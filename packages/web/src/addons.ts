// Addons in the web app (docs/spec.md "Frontend" › Addons dialog; ADR 0006): the list the daemon sent, shared by context, and the pure helpers on it.
import { createContext } from "react";
import type { AddonInfo, AddonSource } from "@claude-ui/protocol";
import type { Key } from "./i18n.ts";

export type { AddonInfo, AddonsListResult, AddonUpdateCheck } from "@claude-ui/protocol";

/** One refused or failed call of an addon, kept per browser in memory (last 50 per addon). */
export type AddonLogEntry = { at: number; type: string; message: string };
export type AddonsState = { addons: AddonInfo[]; picks: Record<string, string>; log: Map<string, AddonLogEntry[]> };
export const EMPTY_ADDONS: AddonsState = { addons: [], picks: {}, log: new Map() };
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
  };
  return { key: fixed[c] ?? "addons.cap.unknown", vars: { capability: c } };
}

/** `fence:<lang>` / `tool:<name>` targets claimed by two or more enabled addons, with the claimers (name-sorted). */
export function rendererConflicts(addons: AddonInfo[]): Record<string, string[]> {
  const by: Record<string, string[]> = {};
  for (const a of enabledAddons(addons)) for (const r of a.manifest!.renderers) (by[`fence` in r ? `fence:${r.fence}` : `tool:${r.tool}`] ??= []).push(a.name);
  return Object.fromEntries(Object.entries(by).filter(([, n]) => n.length > 1).map(([t, n]) => [t, n.sort()]));
}
