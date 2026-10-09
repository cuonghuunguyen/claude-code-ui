// Which plan usage window the titlebar ring shows (docs/spec.md "Plan usage meter"): per browser, like the other Settings.
import { useSyncExternalStore } from "react";
import type { PlanWindow } from "@claude-ui/protocol";

export type UsageRing = "highest" | "session" | "weekly";
export const USAGE_RINGS: { value: UsageRing; label: string }[] = [
  { value: "highest", label: "Highest usage" },
  { value: "session", label: "Session (5 h)" },
  { value: "weekly", label: "Weekly" },
];
/** The window kind each choice shows (the daemon's `kind`, never the label). */
const KIND: Record<Exclude<UsageRing, "highest">, string> = { session: "session", weekly: "weekly_all" };

const KEY = "claude-ui.usageRing";
export const loadUsageRing = (): UsageRing => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "session" || v === "weekly" ? v : "highest";
  } catch {
    return memory;
  }
};

const listeners = new Set<() => void>();
// Storage blocked: the choice lasts while the page is open.
let memory: UsageRing = "highest";
export function saveUsageRing(r: UsageRing) {
  memory = r;
  try {
    if (r === "highest") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, r);
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
export const useUsageRing = (): UsageRing => useSyncExternalStore(subscribe, loadUsageRing, () => "highest");

/** The window the choice names, or undefined (highest, or the window is missing: the caller falls back to the highest). */
export const ringWindow = (windows: PlanWindow[], ring: UsageRing): PlanWindow | undefined => (ring === "highest" ? undefined : windows.find((w) => w.kind === KIND[ring]));
