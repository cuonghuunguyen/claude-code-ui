import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PERMISSION_MODES } from "@claude-ui/protocol";

/**
 * `permissions.defaultMode` as Claude Code resolves it for `cwd`: the highest of local (`local`: the files of `localSettingsFiles`, repo root first),
 * project (.claude/settings.json) and user (`claudeDir`/settings.json) that sets a valid one. Read on each call, so edits apply to the next new session.
 * An unknown value is skipped (the next source decides), and `auto` / `bypassPermissions` count only from the user settings: Claude Code
 * ignores them in project files, so a cloned repo cannot turn off permission checks. Undefined when no file sets a usable value.
 */
export function readDefaultMode(claudeDir: string, cwd: string, local: readonly string[]): string | undefined {
  const files = [
    ...local.map((f) => [f, false] as const),
    [join(cwd, ".claude", "settings.json"), false],
    [join(claudeDir, "settings.json"), true],
  ] as const;
  for (const [file, isUser] of files)
    try {
      const mode = JSON.parse(readFileSync(file, "utf8"))?.permissions?.defaultMode;
      if (PERMISSION_MODES.includes(mode) && (isUser || (mode !== "auto" && mode !== "bypassPermissions"))) return mode;
    } catch {
      // Missing or unreadable file: the next source decides.
    }
  return undefined;
}
