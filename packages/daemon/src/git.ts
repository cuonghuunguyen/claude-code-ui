// Git branch and diff size of a session cwd, for the status bar (`git.status`).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitStatus } from "@claude-ui/protocol";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, encoding: "utf8", maxBuffer: 64 << 20 })).stdout.trim();

/** null outside a git work tree. Lines added/removed: staged and unstaged changes of tracked files against HEAD (the empty tree before the first commit). */
export async function gitStatus(cwd: string): Promise<GitStatus | null> {
  let branch: string;
  try {
    branch = (await git(cwd, "branch", "--show-current")) || (await git(cwd, "rev-parse", "--short", "HEAD"));
  } catch {
    return null;
  }
  const base = await git(cwd, "rev-parse", "--verify", "-q", "HEAD").catch(() => git(cwd, "hash-object", "-t", "tree", "/dev/null"));
  let added = 0;
  let removed = 0;
  // Binary files count "-": no lines.
  for (const line of (await git(cwd, "diff", "--numstat", base).catch(() => "")).split("\n")) {
    const [a, r] = line.split("\t");
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return { branch, added, removed };
}
