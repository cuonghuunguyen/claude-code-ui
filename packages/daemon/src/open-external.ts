// fs.openExternal: a fixed OS command per platform (no shell, except a Windows .cmd editor launcher) for a path the server already checked.
import { dirname, posix, win32 } from "node:path";
import { appendFileSync } from "node:fs";
import type { EditorId } from "@claude-ui/protocol";
import { runOpener } from "./ctl/commands.ts";
import { shellEnv } from "./terminals.ts";
import { winQuote } from "./update.ts";

export type OpenWith = "reveal" | "default" | "custom" | EditorId;
export interface OpenCommand {
  cmd: string;
  args: string[];
  /** Windows: the arguments are already quoted (explorer /select, cmd /s /c). */
  verbatim?: boolean;
  /** explorer.exe exits 1 on success. */
  ignoreExit?: boolean;
}
/** How an editor starts: its CLI (full path) or, on macOS, its app bundle (`open -a`). */
export type Launcher = { cli: string } | { app: string };

export const EDITORS: Record<EditorId, { label: string; cli: string; apps: string[] }> = {
  code: { label: "VS Code", cli: "code", apps: ["Visual Studio Code.app"] },
  cursor: { label: "Cursor", cli: "cursor", apps: ["Cursor.app"] },
  idea: { label: "IntelliJ IDEA", cli: "idea", apps: ["IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app", "IntelliJ IDEA CE.app"] },
};
export const isOpenWith = (w: unknown): w is OpenWith => w === "reveal" || w === "default" || w === "custom" || (typeof w === "string" && Object.hasOwn(EDITORS, w));

/** A path that cmd.exe would expand (`%VAR%`) inside the .cmd launcher: refused, so nothing expands. */
export const WIN_UNSAFE = /%/;

/** `name` as a file: an absolute path as is, else the first PATH entry that has it (PATHEXT on Windows, unless `name` has an extension). */
export function findOnPath(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; exists: (p: string) => boolean }, name: string): string | undefined {
  const win = o.platform === "win32";
  const { join, delimiter, isAbsolute } = win ? win32 : posix;
  const exts = win && !/\.[^\\/.]+$/.test(name) ? (o.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";").filter(Boolean) : [""];
  if (isAbsolute(name)) return exts.map((x) => name + x).find(o.exists);
  return (o.env.PATH ?? o.env.Path ?? "").split(delimiter).filter(Boolean).flatMap((d) => exts.map((x) => join(d, name + x))).find(o.exists);
}

/** The user's editor command for `path`: `{path}` and `{root}` are replaced in the arguments; with none, the paths are appended as for the built-in editors. The program is never passed through a shell (Windows .cmd: cmd.exe with every argument quoted). */
export function customCommand(argv: string[], path: string, root: string, isDir: boolean, platform: NodeJS.Platform, find: (name: string) => string | undefined): OpenCommand {
  const prog = argv[0] ? find(argv[0]) : undefined;
  if (!prog) throw Object.assign(new Error(`Editor command not found${argv[0] ? `: ${argv[0]}` : ""}. Check Settings › Open in app.`), { code: "editor_missing" });
  // One pass: a file name that contains "{root}" is not replaced again.
  const sub = (a: string) => a.replace(/\{(path|root)\}/g, (_, k: string) => (k === "path" ? path : root));
  const args = argv.slice(1).map(sub);
  if (args.every((a, i) => a === argv[i + 1])) args.push(...(isDir ? [path] : [root, path]));
  if (platform === "win32" && /\.(cmd|bat)$/i.test(prog)) {
    if ([path, root].some((t) => WIN_UNSAFE.test(t))) throw new Error("unsupported character in the path: %");
    return { cmd: "cmd.exe", args: ["/d", "/s", "/c", `"${[prog, ...args].map(winQuote).join(" ")}"`], verbatim: true };
  }
  return { cmd: prog, args };
}

/**
 * The editors installed here: the CLI on PATH (PATHEXT on Windows), else on macOS the app bundle in /Applications or ~/Applications
 * (a daemon started by the launcher shortcut has a GUI PATH without /usr/local/bin and /opt/homebrew/bin).
 */
export function detectEditors(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; exists: (p: string) => boolean; home: string }): Map<EditorId, Launcher> {
  const found = new Map<EditorId, Launcher>();
  for (const [id, e] of Object.entries(EDITORS) as [EditorId, (typeof EDITORS)[EditorId]][]) {
    const cli = findOnPath(o, e.cli);
    if (cli) found.set(id, { cli });
    else if (o.platform === "darwin") {
      const { join } = posix;
      const app = ["/Applications", join(o.home, "Applications")].flatMap((d) => e.apps.map((a) => join(d, a))).find(o.exists);
      if (app) found.set(id, { app });
    }
  }
  return found;
}

/** The command for `path` (canonical, inside `root`); throws for a path the platform cannot pass safely. `wslPath`: its Windows form, set by a daemon in WSL (reveal and default go to Windows Explorer). */
export function openCommand(platform: NodeJS.Platform, how: Exclude<OpenWith, "custom">, path: string, root: string, isDir: boolean, launcher?: Launcher, wslPath?: string): OpenCommand {
  const win = platform === "win32";
  if (how === "reveal") {
    if (wslPath) return { cmd: "explorer.exe", args: ["/select," + wslPath], ignoreExit: true };
    if (platform === "darwin") return { cmd: "open", args: ["-R", path] };
    if (win) return { cmd: "explorer.exe", args: [`/select,"${path}"`], verbatim: true, ignoreExit: true };
    // shortcut: no item selection on Linux, upgrade with org.freedesktop.FileManager1.ShowItems when asked.
    return { cmd: "xdg-open", args: [isDir ? path : dirname(path)] };
  }
  if (how === "default") {
    if (isDir) throw new Error("a folder has no default app");
    if (wslPath) return { cmd: "explorer.exe", args: [wslPath], ignoreExit: true };
    return platform === "darwin" ? { cmd: "open", args: [path] } : win ? { cmd: "explorer.exe", args: [`"${path}"`], verbatim: true, ignoreExit: true } : { cmd: "xdg-open", args: [path] };
  }
  if (!launcher) throw new Error(`${EDITORS[how].label} is not installed`);
  // A folder opens as the workspace itself; a file opens beside its session folder.
  const targets = isDir ? [path] : [root, path];
  if ("app" in launcher) return { cmd: "open", args: ["-a", launcher.app, ...targets] };
  if (win && /\.(cmd|bat)$/i.test(launcher.cli)) {
    // Node refuses to start .cmd without a shell (CVE-2024-27980): cmd.exe with every argument quoted.
    if (targets.some((t) => WIN_UNSAFE.test(t))) throw new Error("unsupported character in the path: %");
    return { cmd: "cmd.exe", args: ["/d", "/s", "/c", `"${[launcher.cli, ...targets].map(winQuote).join(" ")}"`], verbatim: true };
  }
  return { cmd: launcher.cli, args: targets };
}

/** Starts the command detached; rejects when it cannot start or fails. */
// The user's environment without the daemon's PORT and CLAUDE_UI_* (as terminals); detached on POSIX so a foreground viewer or IDE outlives the daemon's Ctrl+C.
export const spawnOpen = (c: OpenCommand) => runOpener(c.cmd, c.args, undefined, { verbatim: c.verbatim, ignoreExit: c.ignoreExit, env: shellEnv(), detached: process.platform !== "win32" });

/** CLAUDE_UI_OPEN_LOG (end-to-end tests): records the command as a JSON line instead of starting an app. */
export const logOpen = (file: string) => async (c: OpenCommand) => void appendFileSync(file, JSON.stringify({ cmd: c.cmd, args: c.args }) + "\n");
