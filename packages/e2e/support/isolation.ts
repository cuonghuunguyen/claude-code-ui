// Guard: nothing of a run may land in the owner's real claude-ui config dirs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { realConfigDirs } from "./daemon.ts";

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

/** Throws when a real config dir mentions the run folder. The owner's own daemon may write these files: only the run path counts. */
export function assertIsolated(run: string): void {
  const breaches = isolationBreaches(run, readRealState());
  if (breaches.length) throw new Error(`ISOLATION BREACH: the test run ${run} appears in the real config: ${breaches.join(", ")}`);
}
