// opencode-adapters.json: which OpenCode adapter each Session belongs to (ADR 0015). Only version 2 is written; a Session with no record belongs to version 1.
// A separate file, not sessions.json: that one drops entries past its limit and prunes, which would turn a version 2 Session back into a version 1 one.
import { createJsonFile } from "./json-file.ts";

/** Without `file` the record lives in memory only (tests). `set2` throws when the save fails; `get` never throws. */
export function createOpenCodeAdapters(file?: string) {
  // ponytail: a record is never removed (about 40 bytes per session); the delete of a version 2 session (a later slice) can drop its entry.
  const store = createJsonFile<Record<string, 2>>(
    file,
    (raw) => (raw && typeof raw === "object" && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter(([, v]) => v === 2) as [string, 2][]) : {}),
    "OpenCode adapter record",
  );
  return {
    get: (id: string): 1 | 2 => (store.get()[id] === 2 ? 2 : 1),
    set2(id: string) {
      if (store.get()[id] === 2) return;
      try {
        store.change((d) => void (d[id] = 2));
      } catch (err) {
        // A failed save leaves the change in memory (json-file.ts): take it back, or the next call would see a record that is not on disk and skip the save.
        delete store.get()[id];
        throw err;
      }
    },
  };
}
export type OpenCodeAdapters = ReturnType<typeof createOpenCodeAdapters>;
