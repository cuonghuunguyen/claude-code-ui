// The state folder of a Side Daemon (`~/.local/share/claude-ui/side/.data`): its own, never the config folder of a Hub on the same machine.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** What an older build wrote into the Hub config folder as Side state. */
export const SIDE_STATE_FILES = ["sessions.json", "projects.json", "settings.json", "secrets.json"];
/** A config folder with one of these belongs to a Hub on this machine: its files are the Hub's, not a Side's. */
const HUB_MARKERS = ["token", "daemon.json", "versions"];

/**
 * One-time copy of the old Side state into `data`: only when `data` is empty and `old` shows no Hub. Never changes or deletes `old`.
 * Returns the files copied.
 */
export function migrateSideState(old: string, data: string): string[] {
  if (existsSync(data) && readdirSync(data).length) return [];
  if (HUB_MARKERS.some((m) => existsSync(join(old, m)))) return [];
  const files = SIDE_STATE_FILES.filter((f) => existsSync(join(old, f)));
  if (!files.length) return [];
  mkdirSync(data, { recursive: true, mode: 0o700 });
  for (const f of files) copyFileSync(join(old, f), join(data, f));
  return files;
}
