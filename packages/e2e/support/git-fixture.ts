// A git repository with an origin for the Create worktree acceptance tests. No Playwright import.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const env = { ...process.env, GIT_AUTHOR_NAME: "E2E", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "E2E", GIT_COMMITTER_EMAIL: "e2e@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

function commit(cwd: string, file: string, text: string, message: string): void {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", message);
}

/**
 * Makes `repo` (an existing folder, already holding `.claude/settings.json`) a clone-like repository of the bare `origin`:
 * main (pushed), local-only `base-alt` with an extra commit, remote-only `feat/remote` and `feature/PRJ-2-old-try`.
 */
export function makeRepoWithOrigin(repo: string, origin: string): void {
  mkdirSync(dirname(origin), { recursive: true });
  git(dirname(origin), "init", "--bare", "-b", "main", origin);
  const seed = `${origin}.seed`;
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-b", "main");
  commit(seed, "README.md", "main\n", "initial");
  for (const b of ["feat/remote", "feature/PRJ-2-old-try"]) {
    git(seed, "checkout", "-b", b, "main");
    commit(seed, `${b.replace(/\W+/g, "-")}.txt`, `${b}\n`, `work on ${b}`);
  }
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "origin", "main", "feat/remote", "feature/PRJ-2-old-try");

  git(repo, "init", "-b", "main");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "fetch", "origin");
  git(repo, "checkout", "-B", "main", "origin/main");
  git(repo, "branch", "--set-upstream-to=origin/main", "main");
  git(repo, "checkout", "-b", "base-alt");
  commit(repo, "alt.txt", "alt\n", "a commit only on base-alt");
  git(repo, "checkout", "main");
}

export type SubmoduleState = "moved" | "dirty-only" | "moved-committed" | "moved-committed-listed" | "dirty-with-nested" | "tree";

/** Short commit names of the inner repository: `first` is the recorded one, `second` the later one. */
export type SubmoduleShas = { first: string; second: string };

/**
 * Makes `repo` a superproject holding `libs/lib`, an inner repository committed and `git add`ed as a gitlink (no `submodule add`).
 * - moved: HEAD records `first`, the inner working tree sits at `second`; plus a normal change in `s.txt`.
 * - dirty-only: HEAD records `first`, the inner repository stays on it with an uncommitted edit of a tracked file.
 * - moved-committed: HEAD itself moved the gitlink from `first` to `second` (the Graph shows that commit).
 * - moved-committed-listed: like moved-committed, plus the committed `.gitmodules` (so the repository list holds `libs/lib`).
 * - dirty-with-nested: like dirty-only, plus a committed `.gitmodules` (so the repository list holds `libs/lib`), a branch `lib-only` in `libs/lib`
 *   and an untracked embedded repository `inner/` (git prints it as an untracked folder).
 * - tree (GH-392): committed `.gitmodules`; `libs/lib` moved to `second` plus an uncommitted edit of its `a.txt`; an embedded repository `tools/inner`
 *   with an untracked `new.txt` and an edited `a.txt`; a normal change in `s.txt`.
 */
export function makeSuperproject(repo: string, state: SubmoduleState): SubmoduleShas {
  const lib = join(repo, "libs", "lib");
  mkdirSync(lib, { recursive: true });
  git(lib, "init", "-b", "main");
  commit(lib, "a.txt", "1\n", "lib one");
  const first = git(lib, "rev-parse", "--short", "HEAD");
  commit(lib, "a.txt", "2\n", "lib two");
  const second = git(lib, "rev-parse", "--short", "HEAD");
  git(lib, "checkout", "-q", first);
  if (state === "dirty-with-nested") git(lib, "branch", "lib-only", second);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, ".git", "info", "exclude"), ".claude/\n");
  writeFileSync(join(repo, "s.txt"), "s\n");
  const added = ["s.txt", "libs/lib"];
  if (state === "dirty-with-nested" || state === "moved-committed-listed" || state === "tree") {
    writeFileSync(join(repo, ".gitmodules"), '[submodule "libs/lib"]\n\tpath = libs/lib\n\turl = ./libs/lib\n');
    added.push(".gitmodules");
  }
  git(repo, "-c", "advice.addEmbeddedRepo=false", "add", ...added);
  git(repo, "commit", "-m", "add libs/lib");
  if (state === "moved" || state === "tree") {
    git(lib, "checkout", "-q", second);
    writeFileSync(join(repo, "s.txt"), "s\nmore\n");
    if (state === "tree") {
      writeFileSync(join(lib, "a.txt"), "2\nedited\n");
      makeNestedRepo(join(repo, "tools"), "inner", "inner commit", true);
      writeFileSync(join(repo, "tools", "inner", "new.txt"), "new\n");
    }
  } else if (state === "dirty-only" || state === "dirty-with-nested") {
    writeFileSync(join(lib, "a.txt"), "1\nedited\n");
    if (state === "dirty-with-nested") makeNestedRepo(repo, "inner", "inner commit", true);
  } else {
    git(lib, "checkout", "-q", second);
    git(repo, "add", "libs/lib");
    git(repo, "commit", "-m", "move libs/lib");
  }
  return { first, second };
}

/** Makes `dir/<name>` a repository with one commit `subject` holding `file`; `edit` leaves an uncommitted change in it. */
export function makeNestedRepo(dir: string, name: string, subject: string, edit = false): void {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  commit(repo, "a.txt", "1\n", subject);
  if (edit) writeFileSync(join(repo, "a.txt"), "1\nedited\n");
}

/**
 * Gives `repo` and its `libs/lib` a local bare `origin` each, in `<repo>-origins/` (a sibling inside the e2e roots, so the daemon allows it).
 * `libs/lib` gets the remote-only branch `lib-remote-only`, the superproject `super-remote-only`; neither is fetched yet.
 */
export function addSubmoduleRemotes(repo: string): void {
  const origins = `${repo}-origins`;
  mkdirSync(origins, { recursive: true });
  for (const [dir, bare, branch] of [
    [join(repo, "libs", "lib"), "lib.git", "lib-remote-only"],
    [repo, "super.git", "super-remote-only"],
  ] as const) {
    const origin = join(origins, bare);
    git(origins, "init", "--bare", "-b", "main", origin);
    git(dir, "remote", "add", "origin", origin);
    git(dir, "push", "origin", "main");
    const tmp = join(origins, `${basename(bare, ".git")}-tmp`);
    git(origins, "clone", origin, tmp);
    git(tmp, "checkout", "-b", branch);
    commit(tmp, `${branch}.txt`, `${branch}\n`, `work on ${branch}`);
    git(tmp, "push", "origin", branch);
  }
}
