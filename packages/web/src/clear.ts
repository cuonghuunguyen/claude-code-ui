// /clear (GH-150): the tab goes on in the session the CLI continues in, keeping its prompt box.
import { emptySession, shownState, type SessionView } from "./store.ts";
import { unechoed, type Pending } from "./optimistic.ts";

/** `/clear` and its aliases, as the daemon's CLEARED and the adapter's hidden commands. */
export const isClearCommand = (text: string) => /^\/(clear|reset|new)$/.test(text.trim());

/**
 * The session's /clear is under way: its last prompt (sent and not echoed yet, or echoed and the turn running) is /clear and
 * no session_cleared moved the tab yet. The hand-over rewinds the /clear prompt away and idles the old session, so this
 * turns false by itself; a /clear that fails ends idle too.
 */
export function clearing(view: SessionView | undefined, pending?: Pending[]): boolean {
  if (!view) return false;
  if (unechoed(pending, view).some((p) => isClearCommand(p.text))) return true;
  const state = shownState(view);
  if (state !== "running" && state !== "needs_input") return false;
  for (let i = view.order.length - 1; i >= 0; i--) {
    const p = view.parts.get(view.order[i]!)!;
    if (p.type === "user_text" && !p.parentId) return isClearCommand(p.text);
  }
  return false;
}

/** The view a tab shows for the session it followed after /clear, until that session's subscribe reply. */
export const heirView = (old: SessionView | undefined): SessionView => ({
  ...emptySession(),
  commands: old?.commands ?? [],
  model: old?.model,
  permissionMode: old?.permissionMode,
  effort: old?.effort,
});
