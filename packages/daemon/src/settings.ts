// App-wide settings (docs/spec.md "Settings"): settings.json in the config dir, shared by the daemons of one user like projects.json.
// A new setting = a field in `Settings`, `DEFAULTS` and `CHECKS`; the store, the wire messages and the dialog's patch need no change.
import { createJsonFile } from "./json-file.ts";
import { WORKER_MODES, type Settings, type SettingsPatch } from "@claude-ui/protocol";

export const DEFAULTS: Settings = { orchestration: { enabled: false, workerCap: 4, coordinatorPermissions: false, workerMode: "coordinator" } };

type Check = { valid: (v: unknown) => boolean; label: string; rule: string };
const bool = (label: string): Check => ({ valid: (v) => typeof v === "boolean", label, rule: "on or off" });
/** Per field: is `v` valid. A stored field that fails falls back to its default; a patched one is refused with "<label> must be <rule>". */
const CHECKS: { [S in keyof Settings]: { [K in keyof Settings[S]]: Check } } = {
  orchestration: {
    enabled: bool("Enable orchestration"),
    workerCap: { valid: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 20, label: "Maximum workers", rule: "a whole number from 1 to 20" },
    coordinatorPermissions: bool("Coordinator may answer permission requests"),
    workerMode: { valid: (v) => (WORKER_MODES as readonly unknown[]).includes(v), label: "Worker mode", rule: `one of ${WORKER_MODES.join(", ")}` },
  },
};
const checks = CHECKS as Record<string, Record<string, Check>>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Own property only: "__proto__", "toString" and the like are never a section or field. */
const own = (o: Record<string, unknown>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);

type Stored = Record<string, Record<string, unknown>>;
const defaults = DEFAULTS as unknown as Stored;

/**
 * The file keeps only valid known fields that differ from their default: a later default change applies to every install
 * that never chose the field, and an unknown or renamed key (`coordinatorAnswersPermissions`) is dropped on the next write.
 */
function parseStored(raw: unknown): Stored {
  const out: Stored = {};
  const root = isObj(raw) ? raw : {};
  for (const s of Object.keys(checks)) {
    const sec = own(root, s);
    if (!isObj(sec)) continue;
    for (const k of Object.keys(checks[s]!)) {
      const v = own(sec, k);
      if (checks[s]![k]!.valid(v) && v !== defaults[s]![k]) (out[s] ??= {})[k] = v;
    }
  }
  return out;
}

/** Every field valid or default; a hand-edited file of another shape gives the defaults. */
export function parseSettings(raw: unknown): Settings {
  const stored = parseStored(raw);
  return Object.fromEntries(Object.keys(checks).map((s) => [s, { ...defaults[s], ...stored[s] }])) as unknown as Settings;
}

/** The first problem of a patch (unknown section or field, wrong value), or undefined. */
export function checkPatch(patch: unknown): string | undefined {
  if (!isObj(patch)) return "patch must be an object";
  for (const s of Object.keys(patch)) {
    const sec = Object.hasOwn(checks, s) ? checks[s] : undefined;
    const v = patch[s];
    if (!sec || !isObj(v)) return `unknown setting ${s}`;
    for (const k of Object.keys(v)) {
      const c = Object.hasOwn(sec, k) ? sec[k] : undefined;
      if (!c) return `unknown setting ${s}.${k}`;
      if (!c.valid(v[k])) return `${c.label} must be ${c.rule}`;
    }
  }
}

/** Without `file` the settings live in memory only (tests). `set` throws when the patch is invalid or the save fails. */
export function createSettings({ file }: { file?: string } = {}) {
  const store = createJsonFile<Stored>(file, parseStored, "settings");
  return {
    /** The latest settings (re-read from the file); readers call it each time, so a change applies without a restart. */
    get: () => parseSettings(store.get()),
    /** Sets only the fields in `patch`: another daemon's change to other fields stays. */
    set(patch: SettingsPatch) {
      const problem = checkPatch(patch);
      if (problem) throw new Error(problem);
      // Only known keys, copied one by one: the patch object itself is never merged in.
      store.change((d) => {
        for (const s of Object.keys(checks)) {
          const sec = own(patch as Record<string, unknown>, s);
          if (!isObj(sec)) continue;
          for (const k of Object.keys(checks[s]!)) {
            if (!Object.hasOwn(sec, k)) continue;
            // A default value is not stored: the field follows the default again.
            if (sec[k] === defaults[s]![k]) delete d[s]?.[k];
            else (d[s] ??= {})[k] = sec[k];
          }
        }
      });
      return parseSettings(store.get());
    },
  };
}

export type AppSettings = ReturnType<typeof createSettings>;
