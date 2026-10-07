// Whether the code this daemon runs is older than what is on disk (docs/spec.md "Updates"): a source checkout changed after the
// daemon started, or a newer release is installed and waits for a restart. A stale daemon lacks tools and permission modes the
// source has, so the coordinator and the web app are told (`daemonNote`, `daemon_stale`).
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, installedVersions } from "./update.ts";

const CACHE_MS = 10_000;

/** The newest mtime (ms) of the non-test `.ts` files under `dir`, and that file; none when there are none. */
function newestSource(dir: string): { at: number; file: string } | undefined {
  let best: { at: number; file: string } | undefined;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        const at = statSync(p).mtimeMs;
        if (!best || at > best.at) best = { at, file: p };
      }
    }
  };
  try {
    walk(dir);
  } catch {}
  return best;
}

/**
 * `stale()` is the note when this daemon (`version`, "dev" for a source checkout) runs older code than `srcDirs` (dev: a source
 * file changed after `startedAt`) or `versionsDir` (a release: a newer complete install), else undefined. Cached for 10 s.
 */
export function createBuildInfo(o: { version: string; srcDirs?: string[]; versionsDir?: string; startedAt?: number; now?: () => number }) {
  // The process start, not the call: a file saved while the modules loaded is already newer than the code that runs.
  const startedAt = o.startedAt ?? Date.now() - process.uptime() * 1000;
  const now = o.now ?? Date.now;
  let cached: { at: number; note: string | undefined } | undefined;
  const check = (): string | undefined => {
    if (o.version === "dev") {
      const newest = (o.srcDirs ?? []).map(newestSource).reduce<ReturnType<typeof newestSource>>((a, b) => (b && (!a || b.at > a.at) ? b : a), undefined);
      if (!newest || newest.at <= startedAt) return undefined;
      return `This claude-ui daemon runs code older than its source checkout (a file changed ${new Date(newest.at).toISOString()}, after the daemon started at ${new Date(startedAt).toISOString()}). Tools and permission modes may be missing; ask the user to restart the daemon.`;
    }
    const newer = o.versionsDir ? installedVersions(o.versionsDir)[0] : undefined;
    return newer && compareVersions(newer, o.version) > 0 ? `claude-ui ${newer} is installed but this daemon still runs ${o.version}; it runs after a restart.` : undefined;
  };
  return {
    version: o.version,
    startedAt,
    stale(): string | undefined {
      const t = now();
      if (!cached || t - cached.at >= CACHE_MS) cached = { at: t, note: check() };
      return cached.note;
    },
  };
}

export type BuildInfo = ReturnType<typeof createBuildInfo>;
