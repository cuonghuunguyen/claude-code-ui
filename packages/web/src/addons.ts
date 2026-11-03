// Addons in the web app (docs/spec.md "Frontend" › Addons dialog; ADR 0006): the list the daemon sent, shared by context, and the pure helpers on it.
import { createContext } from "react";
import type { RequestType } from "@claude-ui/addon-sdk";
import type { AddonInfo, AddonSource, SlashCommand } from "@claude-ui/protocol";
import { ASIDE_COMMAND, DIALOG_COMMANDS } from "./commands.ts";
import type { Key } from "./i18n.ts";
import type { AddonPaneId } from "./layout.ts";

export type { AddonInfo, AddonsListResult, AddonUpdateCheck } from "@claude-ui/protocol";

/** One line of an addon's log: a refused or invalid bridge call (warn) or a `log` call of the addon. Kept per browser in localStorage, the last LOG_MAX per addon. */
export type AddonLogLevel = "info" | "warn" | "error";
export type AddonLogEntry = { at: number; level: AddonLogLevel; text: string };
export type AddonLog = Map<string, AddonLogEntry[]>;
export type AddonsState = { addons: AddonInfo[]; picks: Record<string, string> };
export const EMPTY_ADDONS: AddonsState = { addons: [], picks: {} };
export const LOG_MAX = 200;
/** Log lines an addon may add per second; more are dropped (an addon must not stall the host). */
export const LOG_RATE = 20;
export const LOG_LEVELS: readonly AddonLogLevel[] = ["info", "warn", "error"];
const LOG_KEY = "claude-ui.addonLog";

/** `log` with `e` appended to `addon`'s entries, the oldest dropped past LOG_MAX. A new Map: React state. */
export const addLog = (log: AddonLog, addon: string, e: AddonLogEntry): AddonLog => new Map(log).set(addon, [...(log.get(addon) ?? []), e].slice(-LOG_MAX));

/** Per-addon rate gate: true when `addon` is under LOG_RATE lines in the second of `now`. Mutates `seen`. */
export function logAllowed(seen: Map<string, { sec: number; n: number }>, addon: string, now: number): boolean {
  const sec = Math.floor(now / 1000);
  const c = seen.get(addon);
  if (!c || c.sec !== sec) return seen.set(addon, { sec, n: 1 }), true;
  return ++c.n <= LOG_RATE;
}
/** `log` without the addons not in `names` (uninstalled): their entries would never show nor be cleared. Same Map when nothing goes. */
export function pruneLog(log: AddonLog, names: readonly string[]): AddonLog {
  const gone = [...log.keys()].filter((k) => !names.includes(k));
  if (!gone.length) return log;
  const next = new Map(log);
  for (const k of gone) next.delete(k);
  return next;
}

const isEntry = (e: unknown): e is AddonLogEntry => !!e && typeof (e as AddonLogEntry).at === "number" && LOG_LEVELS.includes((e as AddonLogEntry).level) && typeof (e as AddonLogEntry).text === "string";
/** The stored log; empty when storage is blocked or the value is not ours. Entries of the wrong shape are dropped. */
export function loadAddonLog(storage: Storage = localStorage): AddonLog {
  try {
    const v: unknown = JSON.parse(storage.getItem(LOG_KEY) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return new Map();
    return new Map(Object.entries(v).flatMap(([k, es]) => (Array.isArray(es) ? [[k, es.filter(isEntry).slice(-LOG_MAX)] as [string, AddonLogEntry[]]] : [])));
  } catch {
    return new Map();
  }
}
export function saveAddonLog(log: AddonLog, storage: Storage = localStorage) {
  try {
    storage.setItem(LOG_KEY, JSON.stringify(Object.fromEntries([...log].filter(([, es]) => es.length))));
  } catch {
    // storage full or blocked: the log stays in memory for this page
  }
}
export const AddonsContext = createContext<AddonsState>(EMPTY_ADDONS);

/** Addons that run: enabled with a base URL and a manifest. */
export const enabledAddons = (addons: AddonInfo[]) => addons.filter((a) => a.state === "enabled" && a.base && a.manifest);

/** What a manifest declares beyond what was approved (`added`) and what was approved but is no longer declared (`removed`). */
export function capabilityDiff(declared: readonly string[], approved: readonly string[]) {
  return { added: declared.filter((c) => !approved.includes(c)), removed: approved.filter((c) => !declared.includes(c)) };
}

/** Where an addon came from: `git: <url>@<ref or HEAD> · <sha7>` or `folder: <path>`. */
export const sourceText = (a: Pick<AddonInfo, "source" | "sha">) => (a.source.kind === "git" ? `git: ${a.source.url}@${a.source.ref ?? "HEAD"}${a.sha ? ` · ${a.sha.slice(0, 7)}` : ""}` : `folder: ${a.source.path}`);
export const sourceKey = (s: AddonSource) => (s.kind === "git" ? s.url : s.path);

/** The catalog key and values of a capability's plain-language line. */
export function capabilityLine(c: string): { key: Key; vars?: Record<string, string> } {
  if (c.startsWith("render.fence:")) return { key: "addons.cap.fence", vars: { lang: c.slice(13) } };
  if (c.startsWith("render.tool:")) return { key: "addons.cap.tool", vars: { name: c.slice(12) } };
  if (c.startsWith("net:")) return { key: "addons.cap.net", vars: { origin: c.slice(4) } };
  const fixed: Record<string, Key> = {
    "session.read": "addons.cap.sessionRead",
    "prompt.insert": "addons.cap.promptInsert",
    "ui.status": "addons.cap.uiStatus",
    "ui.toast": "addons.cap.uiToast",
    "ui.pane": "addons.cap.uiPane",
    "ui.band": "addons.cap.uiBand",
    "ui.command": "addons.cap.uiCommand",
    log: "addons.cap.log",
  };
  return { key: fixed[c] ?? "addons.cap.unknown", vars: { capability: c } };
}

/** `fence:<lang>` / `tool:<name>` targets claimed by two or more enabled addons, with the claimers (name-sorted). */
export function rendererConflicts(addons: AddonInfo[]): Record<string, string[]> {
  const by: Record<string, string[]> = {};
  for (const a of enabledAddons(addons)) for (const r of a.manifest!.renderers) (by[`fence` in r ? `fence:${r.fence}` : `tool:${r.tool}`] ??= []).push(a.name);
  return Object.fromEntries(Object.entries(by).filter(([, n]) => n.length > 1).map(([t, n]) => [t, n.sort()]));
}

/** What a bridge request needs: null = nothing, else the capability. Any type not listed (prompt.submit, fs, shell, permission, ...) is refused whatever was approved. */
const GATE: Record<string, string | null> = { "ui.ready": null, "session.read": "session.read", "prompt.insert": "prompt.insert", "ui.status": "ui.status", "ui.toast": "ui.toast", log: "log" } satisfies Record<RequestType, string | null>;

/** The capability gate of the bridge (ADR 0006): pure, no DOM. */
export function gate(type: string, approved: readonly string[]): { ok: true } | { ok: false; code: "refused" | "unknown"; message: string } {
  if (!Object.hasOwn(GATE, type)) return { ok: false, code: "unknown", message: `${type} is not available to addons` };
  const need = GATE[type];
  return need === null || approved.includes(need) ? { ok: true } : { ok: false, code: "refused", message: `${type} needs capability ${need}` };
}

/** The pane ids of the enabled addons' pane views; `phone`: views with `phone: false` are left out (GH-516 story: hidden below 640 px). */
export const paneIdsOf = (addons: AddonInfo[], phone: boolean): AddonPaneId[] =>
  addons.flatMap((a) => a.manifest!.views.filter((v) => v.kind === "pane" && !(phone && v.phone === false)).map((v) => `addon:${a.name}:${v.id}` as AddonPaneId));

/** The band views of the enabled addons (above the prompt box); `phone`: `phone: false` ones are left out. */
export const bandsOf = (addons: AddonInfo[], phone: boolean) =>
  addons.flatMap((a) => a.manifest!.views.filter((v) => v.kind === "band" && !(phone && v.phone === false)).map((view) => ({ addon: a, view })));

/** A frame height the frame asked for, kept in range (a band at most 160). */
export const clampHeight = (px: number, max = 480) => Math.max(24, Math.min(max, Math.round(px)));

/** Pane id -> view title. */
export const paneTitlesOf = (addons: AddonInfo[]): Map<string, string> => new Map(addons.flatMap((a) => a.manifest!.views.filter((v) => v.kind === "pane").map((v) => [`addon:${a.name}:${v.id}`, v.title] as const)));

/** The addon and view of a pane id `addon:<name>:<view>`, when that addon is enabled. */
export function addonViewOf(addons: AddonInfo[], pane: string) {
  const [, name, id] = pane.split(":");
  const addon = addons.find((a) => a.name === name);
  const view = addon?.manifest?.views.find((v) => v.id === id && v.kind === "pane");
  return addon && view ? { addon, view } : undefined;
}

/** What the host does for an addon (App provides it): the bridge of AddonFrame calls these after the gate. */
export type AddonApi = {
  insert: (sessionId: string, text: string) => void;
  status: (sessionId: string, addon: string, text: string | null) => void;
  toast: (addon: string, text: string) => void;
  refused: (addon: string, type: string, message: string) => void;
  log: (addon: string, level: AddonLogLevel, text: string) => void;
};
export const AddonApiContext = createContext<AddonApi>({ insert() {}, status() {}, toast() {}, refused() {}, log() {} });
/** Status texts by session, then addon (the status bar shows them). */
export const AddonStatusContext = createContext<Record<string, Record<string, string>>>({});

/** The picker rows of the enabled addons' commands, `<addon>:<command>`. A row whose name is a session command (or alias), a dialog command or /btw is left out: an addon never hides a built-in or a skill. */
export function commandRows(addons: AddonInfo[], sessionCommands: SlashCommand[]): SlashCommand[] {
  const taken = new Set([...sessionCommands, ...DIALOG_COMMANDS, ASIDE_COMMAND].flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  return addons.flatMap((a) => a.manifest!.commands.map((c) => ({ name: `${a.name}:${c.name}`, description: c.description, argumentHint: c.argumentHint ?? "" })).filter((r) => !taken.has(r.name)));
}

/** `/addon:cmd args` typed in full, when `rows` has it; the web app runs it, nothing is sent to the session. */
export function addonCommandOf(text: string, rows: SlashCommand[]): { addon: string; name: string; args: string } | undefined {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m || !rows.some((r) => r.name === m[1])) return undefined;
  const [addon, name] = m[1]!.split(":") as [string, string];
  return { addon, name, args: (m[2] ?? "").trim() };
}
export type AddonCommandRun = { addon: string; name: string; args: string };
/** Runs an addon command for a session (App provides it). */
export const AddonCommandContext = createContext<(sessionId: string, c: AddonCommandRun) => void>(() => {});

/** The addon that draws `target` (`fence:<lang>` or `tool:<name>`): the only enabled claimer; of several the one picked in the Addons dialog, else the first by name. */
export function rendererFor(state: Pick<AddonsState, "addons" | "picks">, target: string): { addon: AddonInfo; entry: string } | undefined {
  const claims = enabledAddons(state.addons)
    .flatMap((a) => {
      const r = a.manifest!.renderers.find((x) => ("fence" in x ? `fence:${x.fence}` : `tool:${x.tool}`) === target);
      return r ? [{ addon: a, entry: r.entry }] : [];
    })
    .sort((x, y) => (x.addon.name < y.addon.name ? -1 : x.addon.name > y.addon.name ? 1 : 0));
  return claims.find((c) => c.addon.name === state.picks[target]) ?? claims[0];
}

/** The code fence languages the enabled addons draw. */
export const fenceLanguages = (addons: AddonInfo[]): string[] => [...new Set(enabledAddons(addons).flatMap((a) => a.manifest!.renderers.flatMap((r) => ("fence" in r ? [r.fence] : []))))].sort();
