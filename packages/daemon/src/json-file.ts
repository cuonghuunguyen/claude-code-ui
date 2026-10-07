// A small JSON file in the config dir that daemons of one user (other ports) share: projects.json, sessions.json.
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Re-reads the file before every read and change, so each change applies to the latest content and never overwrites
 * another daemon's change. `parse` turns the parsed JSON (undefined: missing file; `corrupt`: the file could not be parsed and there is no data in memory yet) into the data; a hand-edited
 * file of another shape should come out empty. Without `file` the data lives in memory only (tests).
 * ponytail: no lock; two daemons writing in the same millisecond can still lose one change. Add a lock file if that shows up.
 */
export function createJsonFile<T>(file: string | undefined, parse: (raw: unknown, corrupt?: boolean) => T, label: string) {
  let data = parse(undefined);
  // A change whose save failed lives in memory only; until a save succeeds the file must not replace it.
  // ponytail: while unsaved, this daemon stops merging; its next successful save writes all its data. Replay pending ops if that matters.
  let unsaved = false;
  let readFailed = false;
  let loaded = false; // data came from the file once (or the file was corrupt at start)
  const load = () => {
    if (!file || unsaved) return;
    try {
      data = parse(JSON.parse(readFileSync(file, "utf8")));
      readFailed = false;
      loaded = true;
    } catch (e) {
      const corrupt = e instanceof SyntaxError;
      // Missing: empty. Corrupt: the data in memory stays (an empty list would bring back removed projects); at start there is none, so `parse` decides.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        data = parse(undefined);
        loaded = true;
      } else if (corrupt && !loaded) {
        data = parse(undefined, true);
        loaded = true;
      }
      // Corrupt or unreadable (EACCES, EISDIR, ...; then the data in memory stays): log once until a read succeeds.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && !readFailed)
        (readFailed = true), console.error(corrupt ? `ignoring unreadable ${label} (${file}):` : `reading ${label} failed, keeping it in memory:`, e);
    }
  };
  /** Temp file (per process: two daemons must not share one) + rename: a crash during the write leaves the old file, never a truncated one. */
  const save = () => {
    if (!file) return;
    const tmp = `${file}.${process.pid}.tmp`;
    unsaved = true;
    try {
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {}
      throw e;
    }
    unsaved = false;
    loaded = true;
  };
  return {
    /** The latest data; never throws. */
    get: () => (load(), data),
    /** Applies `fn` to the latest data and saves. Throws when the save fails; the change stays in memory. */
    change(fn: (d: T) => void) {
      load();
      fn(data);
      save();
    },
  };
}
