import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `permissions.defaultMode` as Claude Code resolves it for `cwd`: the highest of local (.claude/settings.local.json), project
 * (.claude/settings.json) and user (`claudeDir`/settings.json) that sets it. Read on each call, so edits apply to the next new session.
 * The value is unchecked (an unknown mode is the caller's fallback); undefined when no file sets it.
 */
export function readDefaultMode(claudeDir: string, cwd: string): string | undefined {
  const files = [join(cwd, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json"), join(claudeDir, "settings.json")];
  for (const file of files)
    try {
      const mode = JSON.parse(readFileSync(file, "utf8"))?.permissions?.defaultMode;
      if (mode !== undefined) return String(mode);
    } catch {
      // Missing or unreadable file: the next source decides.
    }
  return undefined;
}
