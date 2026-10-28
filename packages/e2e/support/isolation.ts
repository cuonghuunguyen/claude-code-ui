// Guard: nothing of a run may land in the owner's real claude-ui config dirs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { realConfigDirs } from "./daemon.ts";
import { daemonConfigDir, localAppData } from "./paths.ts";

const STATE_FILES = ["projects.json", "sessions.json"];

/** Names of the files whose text mentions the run folder, in any slash style (raw or JSON-escaped). */
export function isolationBreaches(run: string, files: Record<string, string>): string[] {
  const forms = new Set<string>();
  for (const form of [run, run.replace(/\\/g, "/"), run.replace(/\//g, "\\")]) {
    forms.add(form);
    forms.add(JSON.stringify(form).slice(1, -1));
  }
  return Object.entries(files)
    .filter(([, text]) => [...forms].some((f) => text.toLowerCase().includes(f.toLowerCase())))
    .map(([name]) => name);
}

/** Reads the state files of every real config dir that exists; the key is the full path. */
export function readRealState(dirs = realConfigDirs()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of dirs)
    for (const name of STATE_FILES)
      try {
        out[join(dir, name)] = readFileSync(join(dir, name), "utf8");
      } catch {}
  return out;
}

const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Session ids (lowercase, as the daemon names upload folders) found in the text of a sessions.json. */
export function sessionIds(text: string): string[] {
  return [...new Set((text.match(SESSION_ID) ?? []).map((id) => id.toLowerCase()))];
}

/** The ids of the run that have a folder in `entries` (a folder name is compared lowercase). */
export function leakedUploads(ids: string[], entries: string[]): string[] {
  const have = new Set(entries.map((e) => e.toLowerCase()));
  return ids.filter((id) => have.has(id));
}

/** Windows: the daemon's uploads must be under the run, and the owner's real uploads folder must hold no folder of a session of the run. Read only: nothing in the real folder is touched. */
export function assertUploadsIsolated(run: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") return;
  let ids: string[] = [];
  try {
    ids = sessionIds(readFileSync(join(daemonConfigDir(run), "sessions.json"), "utf8"));
  } catch {}
  if (!ids.length) return;
  const own = join(localAppData(run), "claude-ui", "uploads");
  if (!existsSync(own)) throw new Error(`UPLOADS BREACH: the run has ${ids.length} session(s) but ${own} does not exist: the daemon put its uploads elsewhere`);
  const real = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "claude-ui", "uploads") : "";
  if (!real || real.toLowerCase() === own.toLowerCase() || !existsSync(real)) return;
  const leaked = leakedUploads(ids, readdirSync(real));
  if (leaked.length) throw new Error(`UPLOADS BREACH: ${real} holds upload folders of this run's sessions: ${leaked.join(", ")}`);
}

/** Throws when a real config dir mentions the run folder. The owner's own daemon may write these files: only the run path counts. */
export function assertIsolated(run: string): void {
  const breaches = isolationBreaches(run, readRealState());
  if (breaches.length) throw new Error(`ISOLATION BREACH: the test run ${run} appears in the real config: ${breaches.join(", ")}`);
}
