// Custom names and icons of projects and sides (GH-515): the daemon's `labels` setting, kept in one module store so
// `projectName` (used by every caller) and the avatars follow a change without props.
import { useSyncExternalStore } from "react";
import type { Label, Settings, SettingsResult } from "@claude-ui/protocol";
import type { Request } from "./client.ts";

type Labels = Settings["labels"];
const EMPTY: Labels = { projects: {}, sides: {} };
let cur = EMPTY;
const subs = new Set<() => void>();

/** From settings.get and settings_changed; an older daemon has no `labels`. */
export function setLabels(l: Labels | undefined) {
  l ??= EMPTY;
  if (JSON.stringify(l) === JSON.stringify(cur)) return;
  cur = l;
  subs.forEach((f) => f());
}
export const getLabels = () => cur;
export const useLabels = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    getLabels,
  );
export const projectLabel = (cwd: string): Label | undefined => (Object.hasOwn(cur.projects, cwd) ? cur.projects[cwd] : undefined);
export const sideLabel = (id: string): Label | undefined => (Object.hasOwn(cur.sides, id) ? cur.sides[id] : undefined);

/** The map with `key` set to `label`; undefined, or no name and no icon, removes it. */
export function withLabel(map: Record<string, Label>, key: string, label: Label | undefined): Record<string, Label> {
  const { [key]: _, ...rest } = map;
  const name = label?.name?.trim();
  const icon = label?.icon;
  if (!name && !icon) return rest;
  return { ...rest, [key]: { ...(name ? { name } : {}), ...(icon ? { icon } : {}) } };
}

const RASTER = /^data:image\/(png|webp|jpeg);base64,/;
/** The icon as `<img>` src when it is an image; undefined for an emoji (and for anything but a raster data URL). */
export const iconSrc = (icon: string | undefined) => (icon && RASTER.test(icon) ? icon : undefined);

/** Saves one label (undefined = reset) as a whole-map patch and shows it at once; rejects with the daemon's refusal. */
export async function saveLabel(request: <T>(m: Request) => Promise<T>, kind: keyof Labels, key: string, label: Label | undefined) {
  const r = await request<SettingsResult>({ type: "settings.set", patch: { labels: { [kind]: withLabel(cur[kind], key, label) } } });
  setLabels(r.settings.labels);
}
