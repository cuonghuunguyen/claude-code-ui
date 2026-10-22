// A git repository with an origin for the Create worktree acceptance tests. No Playwright import.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
