// The app icon and name (docs/spec.md "Settings" › App name and icon): the daemon's `app` setting in a module store, so the favicon
// and title effect and Settings follow a change from any browser without props.
import { useSyncExternalStore } from "react";
import { APP_NAME_DEFAULT, type Settings, type SettingsResult } from "@claude-ui/protocol";
import type { Request } from "./client.ts";

let cur: Settings["app"] = { icon: "", name: "" };
const subs = new Set<() => void>();
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

/** From settings.get and settings_changed; an older daemon has no `app` or no `app.name`. */
export function setApp(app: Settings["app"] | undefined) {
  const icon = app?.icon ?? "";
  const name = app?.name ?? "";
  if (icon === cur.icon && name === cur.name) return;
  cur = { icon, name };
  subs.forEach((f) => f());
}
export const getAppIcon = () => cur.icon;
export const useAppIcon = () => useSyncExternalStore(subscribe, getAppIcon);
/** The effective name: the set one, else "Claude UI". */
export const useAppName = () => useSyncExternalStore(subscribe, () => cur.name || APP_NAME_DEFAULT);

/** Saves the icon and name ("" = the built-in one) and shows them at once; rejects with the daemon's refusal. */
export async function saveApp(request: <T>(m: Request) => Promise<T>, app: Settings["app"]) {
  const r = await request<SettingsResult>({ type: "settings.set", patch: { app } });
  setApp(r.settings.app);
}
