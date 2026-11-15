// A git repository with an origin for the Create worktree acceptance tests. No Playwright import.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const env = { ...process.env, GIT_AUTHOR_NAME: "E2E", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "E2E", GIT_COMMITTER_EMAIL: "e2e@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

/** git init on main. The system gitconfig may set core.autocrlf=true, and the daemon's own git calls read the repo config, so pin it off: a restore must write the bytes that were committed. */
export function initRepo(cwd: string, ...rest: string[]): void {
  git(cwd, "init", "-b", "main", ...rest);
  git(rest.includes("--bare") ? rest[rest.length - 1]! : cwd, "config", "core.autocrlf", "false");
}

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
  initRepo(dirname(origin), "--bare", origin);
  const seed = `${origin}.seed`;
  mkdirSync(seed, { recursive: true });
  initRepo(seed);
  commit(seed, "README.md", "main\n", "initial");
  for (const b of ["feat/remote", "feature/PRJ-2-old-try"]) {
    git(seed, "checkout", "-b", b, "main");
    commit(seed, `${b.replace(/\W+/g, "-")}.txt`, `${b}\n`, `work on ${b}`);
  }
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "origin", "main", "feat/remote", "feature/PRJ-2-old-try");

  initRepo(repo);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "fetch", "origin");
  git(repo, "checkout", "-B", "main", "origin/main");
  git(repo, "branch", "--set-upstream-to=origin/main", "main");
  git(repo, "checkout", "-b", "base-alt");
  commit(repo, "alt.txt", "alt\n", "a commit only on base-alt");
  git(repo, "checkout", "main");
}

/** Makes `repo` (an existing folder, already holding `.claude/settings.json`) a repository with two commits and a README.md and src/app.ts to open in Files. */
export function makeRepoWithTwoCommits(repo: string): void {
  initRepo(repo);
  writeFileSync(join(repo, ".git", "info", "exclude"), ".claude/\n");
  commit(repo, "README.md", "# Fixture\n", "first commit");
  mkdirSync(join(repo, "src"), { recursive: true });
  commit(repo, "src/app.ts", "export const app = 1;\n", "second commit");
}
