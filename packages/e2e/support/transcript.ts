import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code's transcript of a session, wherever its project folder is (the folder name encodes the cwd). */
export function transcriptOf(id: string): string | undefined {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${id}.jsonl`);
    if (existsSync(f)) return f;
  }
  return undefined;
}
