// What Enter does while Claude works (docs/spec.md "Queued messages"): steer the running turn or queue the message. Per browser, like the other Settings.
import { useSyncExternalStore } from "react";

export type SendMode = "steer" | "queue";
export const SEND_MODES: { value: SendMode; label: string }[] = [
  { value: "steer", label: "Steers the turn" },
  { value: "queue", label: "Queues the message" },
];

const KEY = "claude-ui.sendMode";
// Storage blocked: the choice lasts while the page is open.
let memory: SendMode = "steer";
/** An unknown stored value is steer. */
export const loadSendMode = (): SendMode => {
  try {
    return localStorage.getItem(KEY) === "queue" ? "queue" : "steer";
  } catch {
    return memory;
  }
};

const listeners = new Set<() => void>();
export function saveSendMode(m: SendMode) {
  memory = m;
  try {
    if (m === "steer") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, m);
  } catch {
    // See `memory`.
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => (e.key === KEY || e.key === null) && l();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}
/** The setting; re-renders when it is saved here or in another tab. */
export const useSendMode = (): SendMode => useSyncExternalStore(subscribe, loadSendMode, () => "steer");
