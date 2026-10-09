// Reopen closed tab: the last closed session tabs with their place in the strip, kept per browser.
const KEY = "claude-ui.closed-tabs";
export const MAX_CLOSED = 10;

export type ClosedTab = { id: string; at: number };

export function loadClosed(): ClosedTab[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((t): t is ClosedTab => !!t && typeof t.id === "string" && Number.isInteger(t.at)).slice(-MAX_CLOSED) : [];
  } catch {
    return [];
  }
}

export function saveClosed(stack: ClosedTab[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(stack));
  } catch {
    // Storage blocked: the stack lasts for this page.
  }
}

/** `id` was closed at index `at`: it goes on top; a session that is on the stack already moves there. */
export const pushClosed = (stack: ClosedTab[], id: string, at: number) => [...stack.filter((t) => t.id !== id), { id, at }].slice(-MAX_CLOSED);

/** Undo of one close: `id` goes back to its place (clamped to the end) and leaves the stack; a tab that is open already changes nothing. */
export function restoreClosed(stack: ClosedTab[], tabs: string[], id: string) {
  const entry = stack.find((t) => t.id === id);
  if (!entry || tabs.includes(id)) return { tabs, stack };
  const at = Math.min(entry.at, tabs.length);
  return { tabs: [...tabs.slice(0, at), id, ...tabs.slice(at)], stack: stack.filter((t) => t.id !== id) };
}

/** The tab to reopen: the newest entry that still exists (`exists`) and is not open. The rest of the stack drops the skipped and the reopened entries. */
export function popClosed(stack: ClosedTab[], exists: (id: string) => boolean, open: string[]) {
  for (let i = stack.length - 1; i >= 0; i--) if (exists(stack[i]!.id) && !open.includes(stack[i]!.id)) return { tab: stack[i]!, rest: stack.slice(0, i) };
  return { tab: undefined, rest: [] as ClosedTab[] };
}
