// Signal only (docs/spec.md "Session view UX"): a run of tool cards folds into one line; prompts, text, errors and pending requests stay.
import { useSyncExternalStore } from "react";
import type { TimelineItem, ToolCall } from "./store.ts";

/** A folded run of tool items; `items` are what it hides, shown again in place when the row is expanded. */
export type FoldItem = { kind: "fold"; id: string; calls: ToolCall[]; items: TimelineItem[] };
export type SignalItem = TimelineItem | FoldItem;

const toolName = (tool: string) => (tool.startsWith("mcp__") ? (tool.split("__").at(-1) ?? tool) : tool);

/** "4 tool calls · Read 3 · Grep 1": tools by count, then by first appearance. */
export function foldLabel(calls: ToolCall[]) {
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(toolName(c.tool), (counts.get(toolName(c.tool)) ?? 0) + 1);
  const tools = [...counts].sort((a, b) => b[1] - a[1]);
  return [`${calls.length} tool call${calls.length === 1 ? "" : "s"}`, ...tools.map(([t, n]) => `${t} ${n}`)].join(" · ");
}

/** Folds every run of finished-or-running tool calls that is not an error, a denial or waiting for a permission answer. */
export function signalItems(items: TimelineItem[], awaiting: (call: ToolCall) => boolean): SignalItem[] {
  const quiet = (c: ToolCall) => c.status !== "error" && c.status !== "denied" && !awaiting(c);
  const callsOf = (item: TimelineItem): ToolCall[] | undefined => {
    if (item.kind === "context") return item.calls.every(quiet) ? item.calls : undefined;
    return item.part.type === "tool_call" && quiet(item.part) ? [item.part] : undefined;
  };
  const out: SignalItem[] = [];
  for (const item of items) {
    const calls = callsOf(item);
    if (!calls) {
      out.push(item);
      continue;
    }
    const prev = out.at(-1);
    if (prev?.kind === "fold") {
      prev.calls.push(...calls);
      prev.items.push(item);
    } else out.push({ kind: "fold", id: `fold:${calls[0]!.id}`, calls: [...calls], items: [item] });
  }
  return out;
}

// One preference for the whole browser (GH-205). The per-session list of GH-159 (`claude-ui.signal-only`) is ignored and left alone.
const KEY = "claude-ui.signalOnly";
const listeners = new Set<() => void>();
// Storage blocked: the choice lasts while the page is open.
let memory = false;

/** Whether this browser folds tool runs in every session. */
export function loadSignalOnly(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return memory;
  }
}

export function saveSignalOnly(on: boolean) {
  memory = on;
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // See `memory`.
  }
  listeners.forEach((l) => l());
}

export function subscribeSignalOnly(l: () => void) {
  listeners.add(l);
  // Another tab of this browser changed it.
  const onStorage = (e: StorageEvent) => (e.key === KEY || e.key === null) && l();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}
/** The setting; re-renders when it changes here (Settings, palette, shortcut) or in another tab. */
export const useSignalOnly = (): boolean => useSyncExternalStore(subscribeSignalOnly, loadSignalOnly, () => false);
