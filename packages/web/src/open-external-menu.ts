// GH-612: "Reveal in file manager / Open in editor / Open with default app" entries of the file context menus, as data.
import { createContext, useContext } from "react";
import { editorLabel, LOCAL_SIDE, type EditorId } from "@claude-ui/protocol";
import { t } from "./i18n.ts";

export type ExternalHow = "reveal" | "default" | EditorId | "custom";
export type ExternalId = `ext:${ExternalHow}`;
export type ExternalEntry = { id: ExternalId; how: ExternalHow; label: string; /** The full label, for a name the menu row truncates. */ title?: string; disabled?: boolean; testId: string };
export type EditorInfo = { id: EditorId | "custom"; label: string };
/** The menu entry of Settings › Open in app (GH-646): its name, else the program of the command; none when no command is set. The daemon builds the same label for settings.get. */
export const customEditor = (e?: { command: string; name: string }): EditorInfo[] => {
  const label = e ? editorLabel(e) : "";
  return e?.command.trim() && label ? [{ id: "custom", label }] : [];
};
/** `run` asks the daemon to open `path` (a session folder `cwd` holds it); absent from the context: the browser is not on the daemon machine or the daemon is older. */
export type OpenExternal = { editors: EditorInfo[]; run: (path: string, how: ExternalHow, cwd: string) => void; /** The session folder is on this machine or in a WSL side (a Docker or SSH side cannot open it). */ canOpen: (cwd: string) => boolean; /** The folder is on this machine, not in a WSL side: only then the custom editor (a hub setting) is offered. */ isLocal: (cwd: string) => boolean };
/** The side id of a path: this machine or a WSL distro (its daemon starts the app on the same Windows desktop). */
export const canOpenSide = (side: string) => side === LOCAL_SIDE || side.startsWith("wsl:");
export const OpenExternalContext = createContext<OpenExternal | undefined>(undefined);
export const useOpenExternal = () => useContext(OpenExternalContext);

/** The browser runs on the daemon machine (a LAN or Tailscale address of it counts as remote); the daemon refuses any other browser too. */
export const onDaemonMachine = () => ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

export const isExternalId = (id: string): id is ExternalId => id.startsWith("ext:");
export const externalHow = (id: ExternalId) => id.slice(4) as ExternalHow;

/** The browser runs on the daemon machine, so its OS names the file manager. */
const os = () => (typeof navigator === "undefined" ? "" : /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : /Win/.test(navigator.platform) ? "win" : "other");

/** The section for one file or folder: reveal, the detected editors, and for a file the default app. `disabled`: the file is deleted. */
export function externalEntries(o: { isDir: boolean; editors: EditorInfo[]; /** false: the path is in a Side, which has no custom editor. */ local?: boolean; disabled?: boolean; platform?: string }): ExternalEntry[] {
  const p = o.platform ?? os();
  const e = (how: ExternalHow, label: string): ExternalEntry => ({ id: `ext:${how}`, how, label, title: label, disabled: o.disabled, testId: `ext-menu-${how}` });
  return [
    e("reveal", t(p === "mac" ? "files.menu.revealMac" : p === "win" ? "files.menu.revealWin" : "files.menu.revealOther")),
    ...o.editors.filter((x) => x.id !== "custom" || o.local !== false).map((x) => e(x.id, t("files.menu.openIn", { app: x.label }))),
    ...(o.isDir ? [] : [e("default", t("files.menu.openDefault"))]),
  ];
}
