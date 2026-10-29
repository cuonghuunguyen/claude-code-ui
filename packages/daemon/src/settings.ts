// App-wide settings (docs/spec.md "Settings"): settings.json in the config dir, shared by the daemons of one user like projects.json.
// A new setting = a field in `Settings`, `DEFAULTS` and `CHECKS`; the store, the wire messages and the dialog's patch need no change.
import { createJsonFile } from "./json-file.ts";
import { AUTO_REPOSITORY_DETECTION, DEFAULT_BRANCH_TEMPLATE, jiraUrlProblem, PARENT_FOLDER_MODES, WORKER_MODES, type Settings, type SettingsPatch } from "@claude-ui/protocol";

export const DEFAULTS: Settings = { orchestration: { enabled: false, workerCap: 4, workerCapTotal: 0, maxDepth: 2, maxChildren: 4, coordinatorPermissions: false, workerMode: "coordinator", workerNotifications: true }, usageLimit: { autoContinue: false }, notifications: { desktop: true }, performance: { monitor: true }, jira: { url: "", email: "", template: DEFAULT_BRANCH_TEMPLATE, jql: "" }, git: { autoRepositoryDetection: true, repositoryScanMaxDepth: 1, repositoryScanIgnoredFolders: ["node_modules"], scanRepositories: [], ignoredRepositories: [], detectSubmodules: true, detectSubmodulesLimit: 10, ignoreSubmodules: false, openRepositoryInParentFolders: "always" } };

/** `patch`: a stricter rule for a new value only; a stored value that fails it is kept (and refused at use), never emptied. */
type Check = { valid: (v: unknown) => boolean; label: string; rule: string; patch?: (v: unknown) => boolean; patchRule?: string };
const jiraUrl = (v: unknown) => {
  if (typeof v !== "string" || v.length > 500) return false;
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
};
const bool = (label: string): Check => ({ valid: (v) => typeof v === "boolean", label, rule: "on or off" });
const strings = (label: string, item: (s: string) => boolean = () => true, rule = "at most 50 entries of at most 260 characters"): Check => ({
  valid: (v) => Array.isArray(v) && v.length <= 50 && v.every((s) => typeof s === "string" && s.length >= 1 && s.length <= 260 && !s.includes("\0") && item(s)),
  label,
  rule,
});
const relativeEntry = (s: string) => !/^([\\/]|[A-Za-z]:)/.test(s) && s.split(/[\\/]/).every((seg) => seg !== ".." && seg.toLowerCase() !== ".git") && s.split(/[\\/]/).some((seg) => seg !== "" && seg !== ".");
const intIn = (label: string, min: number, max: number): Check => ({ valid: (v) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max, label, rule: `a whole number from ${min} to ${max}` });
/** Per field: is `v` valid. A stored field that fails falls back to its default; a patched one is refused with "<label> must be <rule>". */
const CHECKS: { [S in keyof Settings]: { [K in keyof Settings[S]]: Check } } = {
  orchestration: {
    enabled: bool("Enable orchestration"),
    workerCap: intIn("Maximum workers per tree", 1, 20),
    workerCapTotal: intIn("Maximum workers in total", 0, 100),
    maxDepth: intIn("Maximum tree depth", 1, 5),
    maxChildren: intIn("Maximum workers per coordinator", 1, 20),
    coordinatorPermissions: bool("Coordinator may answer permission requests"),
    workerMode: { valid: (v) => (WORKER_MODES as readonly unknown[]).includes(v), label: "Worker mode", rule: `one of ${WORKER_MODES.join(", ")}` },
    workerNotifications: bool("Notifications from workers"),
  },
  usageLimit: { autoContinue: bool("Continue automatically after a usage limit resets") },
  notifications: { desktop: bool("Desktop notifications") },
  performance: { monitor: bool("Performance monitor") },
  jira: {
    url: { valid: (v) => v === "" || jiraUrl(v), label: "Jira URL", rule: "empty or an http(s) address without user name or password", patch: (v) => v === "" || (jiraUrl(v) && !jiraUrlProblem(v as string)), patchRule: "empty or an https address without user name or password (http only for localhost or 127.0.0.1)" },
    email: { valid: (v) => typeof v === "string" && v.length <= 254 && !/[\s]/.test(v), label: "Jira email", rule: "an email address" },
    template: { valid: (v) => typeof v === "string" && v.length >= 1 && v.length <= 200 && !/[\0-\x1f]/.test(v), label: "Branch template", rule: "1 to 200 characters" },
    jql: { valid: (v) => typeof v === "string" && v.length <= 2000 && !/[\0-\x08\x0b-\x1f]/.test(v), label: "Ticket filter", rule: "JQL of at most 2000 characters" },
  },
  git: {
    autoRepositoryDetection: { valid: (v) => (AUTO_REPOSITORY_DETECTION as readonly unknown[]).includes(v), label: "Auto repository detection", rule: `one of ${AUTO_REPOSITORY_DETECTION.join(", ")}` },
    repositoryScanMaxDepth: intIn("Repository scan max depth", -1, 10),
    repositoryScanIgnoredFolders: strings("Repository scan ignored folders", (s) => !/[\\/]/.test(s), "at most 50 folder names (no / or \\) of at most 260 characters"),
    scanRepositories: strings("Scan repositories", relativeEntry, "at most 50 relative paths without .. or .git, of at most 260 characters"),
    ignoredRepositories: strings("Ignored repositories"),
    detectSubmodules: bool("Detect submodules"),
    detectSubmodulesLimit: intIn("Detect submodules limit", 0, 100),
    ignoreSubmodules: bool("Ignore submodules"),
    openRepositoryInParentFolders: { valid: (v) => (PARENT_FOLDER_MODES as readonly unknown[]).includes(v), label: "Open repository in parent folders", rule: `one of ${PARENT_FOLDER_MODES.join(", ")}` },
  },
};
const same = (a: unknown, b: unknown) => (Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]) : a === b);
const copy = (v: unknown) => (Array.isArray(v) ? [...v] : v);
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
      if (checks[s]![k]!.valid(v) && !same(v, defaults[s]![k])) (out[s] ??= {})[k] = copy(v);
    }
  }
  return out;
}

/** Every field valid or default; a hand-edited file of another shape gives the defaults. */
export function parseSettings(raw: unknown): Settings {
  const stored = parseStored(raw);
  return Object.fromEntries(Object.keys(checks).map((s) => [s, Object.fromEntries(Object.entries({ ...defaults[s], ...stored[s] }).map(([k, v]) => [k, copy(v)]))])) as unknown as Settings;
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
      if (!(c.patch ?? c.valid)(v[k])) return `${c.label} must be ${c.patchRule ?? c.rule}`;
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
            if (same(sec[k], defaults[s]![k])) delete d[s]?.[k];
            else (d[s] ??= {})[k] = copy(sec[k]);
          }
        }
      });
      return parseSettings(store.get());
    },
  };
}

export type AppSettings = ReturnType<typeof createSettings>;
