// Signal only (docs/spec.md "Session view UX"): a run of tool cards folds into one line; prompts, text, errors and pending requests stay.
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

const KEY = "claude-ui.signal-only";
const MAX = 500;

const loadIds = (): string[] => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** The sessions this browser shows in Signal only. */
export const loadSignalIds = () => new Set(loadIds());

/** Whether this browser shows the session in Signal only. */
export const loadSignalOnly = (sessionId: string) => loadIds().includes(sessionId);

export function saveSignalOnly(sessionId: string, on: boolean) {
  try {
    const rest = loadIds().filter((id) => id !== sessionId);
    localStorage.setItem(KEY, JSON.stringify((on ? [...rest, sessionId] : rest).slice(-MAX)));
  } catch {
    // Storage blocked: the setting lasts until the page reloads.
  }
}
