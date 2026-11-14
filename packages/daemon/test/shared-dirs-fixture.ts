import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Fixture = { main: string; wt: string; shared: string };
export type FixtureOptions = {
  /** `worktree.symlinkDirectories` of the main checkout's `.claude/settings.local.json`. */
  list?: unknown;
  /** `ok`: `<wt>/development-docs` links to `<main>/development-docs`; `elsewhere`: to another folder; `none`: no entry; `dir`: a real folder. */
  link?: "ok" | "elsewhere" | "none" | "dir";
  /** The shared folder holds a tracked file. */
  tracked?: boolean;
};

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: ["ignore", "pipe", "ignore"] });

/** A repository `<main>` with the daemon's worktree layout `<main>/.claude/worktrees/wt` and a scratch folder `development-docs` shared with it. */
export function sharedFixture(o: FixtureOptions = {}): Fixture {
  const main = realpathSync(mkdtempSync(join(tmpdir(), "shared-")));
  git(main, "init", "-q", "-b", "main");
  mkdirSync(join(main, "packages"));
  writeFileSync(join(main, "packages", "x.ts"), "x");
  writeFileSync(join(main, ".gitignore"), o.tracked ? "" : "development-docs/\n");
  const shared = join(main, "development-docs");
  mkdirSync(join(shared, "K"), { recursive: true });
  mkdirSync(join(main, ".claude"));
  writeFileSync(join(main, ".claude", "settings.local.json"), JSON.stringify({ worktree: { symlinkDirectories: o.list ?? ["development-docs"] } }));
  if (o.tracked) writeFileSync(join(shared, "K", "tracked.md"), "t");
  git(main, "add", "-A", "--", "packages", ".gitignore", ...(o.tracked ? ["development-docs"] : []));
  git(main, "commit", "-q", "-m", "init");
  const wt = join(main, ".claude", "worktrees", "wt");
  mkdirSync(join(main, ".claude", "worktrees"), { recursive: true });
  git(main, "worktree", "add", "-q", "-b", "wt", wt);
  const link = o.link ?? "ok";
  // A tracked folder was checked out as a real folder: the link replaces it.
  if (o.tracked && (link === "ok" || link === "elsewhere")) rmSync(join(wt, "development-docs"), { recursive: true, force: true });
  if (link === "ok") symlinkSync(shared, join(wt, "development-docs"), process.platform === "win32" ? "junction" : undefined);
  if (link === "elsewhere") {
    mkdirSync(join(main, "other"));
    symlinkSync(join(main, "other"), join(wt, "development-docs"), process.platform === "win32" ? "junction" : undefined);
  }
  if (link === "dir" && !o.tracked) mkdirSync(join(wt, "development-docs", "K"), { recursive: true });
  return { main, wt, shared };
}

export { git as fixtureGit };
