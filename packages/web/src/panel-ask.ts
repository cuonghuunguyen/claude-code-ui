// GH-722: palette and shortcut commands that act inside a panel (Rollback, branch picks, Stash, Annotate, Send selection).
// The app reveals the panel and files an ask; the panel that owns the action takes it. Kept out of the panels so App.tsx does not load their code.
// Like commit-ask.ts, an ask is held 2 s so a panel that mounts right after the reveal still takes it.
import { useEffect, useRef } from "react";

export type BranchAskAction = "checkout" | "checkoutSmart" | "merge" | "rebase" | "new";
export type PanelAsk =
  | { kind: "rollback" }
  | { kind: "annotate"; path: string }
  | { kind: "sendSelection" }
  | { kind: "branch"; action: BranchAskAction }
  | { kind: "stash" };
export type PanelAskKind = PanelAsk["kind"];
type Of<K extends PanelAskKind> = Extract<PanelAsk, { kind: K }>;
type Handler<K extends PanelAskKind> = (ask: Of<K>) => boolean | void;

const HOLD_MS = 2000;
let pending: { ask: PanelAsk; at: number } | undefined;
const listeners = new Set<{ kind: PanelAskKind; fn: (ask: never) => boolean | void }>();

const fresh = () => !!pending && Date.now() - pending.at < HOLD_MS;

/** Hands the pending ask to the first listener of its kind that does not return false. */
function deliver() {
  if (!pending) return;
  if (!fresh()) return void (pending = undefined);
  const { ask } = pending;
  for (const l of [...listeners]) {
    if (l.kind !== ask.kind) continue;
    if ((l.fn as Handler<PanelAskKind>)(ask) !== false) return void (pending = undefined);
  }
}

export function askPanel(ask: PanelAsk) {
  pending = { ask, at: Date.now() };
  // After the reveal renders: a panel shown by it (mounted or unhidden) takes the ask.
  setTimeout(deliver);
}

/** The pending ask of `kind`, once; an older one than 2 s is dropped. */
export function takePanelAsk<K extends PanelAskKind>(kind: K): Of<K> | undefined {
  if (!fresh()) return (pending = undefined);
  if (pending!.ask.kind !== kind) return undefined;
  const a = pending!.ask as Of<K>;
  pending = undefined;
  return a;
}

/** Listens for asks of `kind`, and takes one that is pending now (the panel mounted late). `fn` returns false to leave the ask for another panel. Returns the unsubscribe. */
export function onPanelAsk<K extends PanelAskKind>(kind: K, fn: Handler<K>): () => void {
  const l = { kind, fn: fn as (ask: never) => boolean | void };
  listeners.add(l);
  deliver();
  return () => void listeners.delete(l);
}

/** `onPanelAsk` for a component: the latest `fn` runs, the subscription lasts as long as the component. */
export function usePanelAsk<K extends PanelAskKind>(kind: K, fn: Handler<K>) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => onPanelAsk(kind, (a) => latest.current(a)), [kind]);
}
