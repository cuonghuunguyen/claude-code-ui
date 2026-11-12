// Reads the project's AGENTS.md / CLAUDE.md, the way Claude Code reads CLAUDE.md: as user
// configuration for the classifier's policy prompt. Missing files are not an error.
import { readFile } from "node:fs/promises";
import path from "node:path";

async function readFirst(dirs: string[], filename: string): Promise<string | undefined> {
  for (const dir of dirs) {
    try {
      return await readFile(path.join(dir, filename), "utf8");
    } catch {
      // not in this directory; try the next, or give up
    }
  }
  return undefined;
}

/** `worktree` first, then `directory`, so a worktree's own doc wins over the main checkout's. */
export async function readProjectDoc(worktree: string, directory: string, filename: string): Promise<string | undefined> {
  const dirs = worktree === directory ? [directory] : [worktree, directory];
  return readFirst(dirs, filename);
}
