import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Where Claude Code keeps the plan files of a session in `cwd` (checked in the CLI bundle, 2.1.294): the `plansDirectory` setting (local, project, then user
 * settings; relative to the project root and ignored outside it), else `<config dir>/plans`. The default folder is always listed too, as earlier plans live there.
 */
export function planDirs(claudeDir: string, cwd: string): string[] {
  const def = join(claudeDir, "plans");
  for (const file of [join(cwd, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json"), join(claudeDir, "settings.json")])
    try {
      const dir = JSON.parse(readFileSync(file, "utf8"))?.plansDirectory;
      if (typeof dir !== "string" || !dir) continue;
      const abs = resolve(cwd, dir);
      const rel = relative(cwd, abs);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return [abs, def];
    } catch {
      // Missing or unreadable file: the next source decides.
    }
  return [def];
}
