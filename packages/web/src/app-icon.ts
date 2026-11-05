// The app icon (docs/spec.md "Settings" › App icon): the daemon's `app.icon` setting in a module store, so the favicon effect
// and Settings follow a change from any browser without props.
import { useSyncExternalStore } from "react";
import type { SettingsResult } from "@claude-ui/protocol";
import type { Request } from "./client.ts";

let cur = "";
const subs = new Set<() => void>();

/** From settings.get and settings_changed; an older daemon has no `app`. */
export function setAppIcon(icon: string | undefined) {
  icon ??= "";
  if (icon === cur) return;
  cur = icon;
  subs.forEach((f) => f());
}
export const getAppIcon = () => cur;
export const useAppIcon = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    getAppIcon,
  );

/** Saves the icon ("" = the built-in one) and shows it at once; rejects with the daemon's refusal. */
export async function saveAppIcon(request: <T>(m: Request) => Promise<T>, icon: string) {
  const r = await request<SettingsResult>({ type: "settings.set", patch: { app: { icon } } });
  setAppIcon(r.settings.app?.icon);
}
