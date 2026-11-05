// The OS launcher shortcut (docs/spec.md "Launcher shortcut"): a macOS app, a Linux .desktop entry or a Windows Start menu .lnk that
// opens claude-ui in the browser when it runs, else starts it in a terminal. Generators are pure; createShortcut writes the files.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { promisify } from "node:util";

const NAME = "Claude UI";
/** Written into every entry we make; an existing entry without it is the user's and is never replaced or removed. */
const MARK = "claude-ui-launcher-shortcut";
const ID = "io.github.cuonghuunguyen.claude-code-ui";

/** An icns container with one ic09 (512 px PNG) entry. */
export function icns(png: Buffer): Buffer {
  const head = Buffer.alloc(16);
  head.write("icns", 0, "latin1");
  head.writeUInt32BE(16 + png.length, 4);
  head.write("ic09", 8, "latin1");
  head.writeUInt32BE(8 + png.length, 12);
  return Buffer.concat([head, png]);
}

/** An ICO container with one PNG entry (`size` px; 256 and above are written as 0). */
export function ico(png: Buffer, size: number): Buffer {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head[6] = head[7] = size >= 256 ? 0 : size;
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}

export const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

type File = { path: string; content: string; mode?: number };

/** The files of the macOS app, relative to the bundle; the writer adds Contents/Resources/icon.icns. */
export function macApp(shell: string): File[] {
  const plist = (k: string, v: string) => `  <key>${k}</key>\n  <string>${v}</string>\n`;
  return [
    {
      path: "Contents/Info.plist",
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${plist("CFBundleExecutable", "claude-ui")}${plist("CFBundleIconFile", "icon")}${plist("CFBundleIdentifier", ID)}${plist("CFBundleName", NAME)}${plist("CFBundleDisplayName", NAME)}${plist("CFBundlePackageType", "APPL")}${plist("CFBundleShortVersionString", "1.0")}${plist("ClaudeUIShortcut", MARK)}</dict>\n</plist>\n`,
    },
    {
      path: "Contents/MacOS/claude-ui",
      mode: 0o755,
      content: `#!/bin/sh\n# Finder starts this without a terminal: a running claude-ui opens in the browser, else claude-ui starts in Terminal (closing the window stops it).\n${shQuote(shell)} -ilc 'claude-ui open' >/dev/null 2>&1 </dev/null || exec open -a Terminal "$(dirname "$0")/../Resources/start.command"\n`,
    },
    { path: "Contents/Resources/start.command", mode: 0o755, content: "#!/bin/sh\nexec claude-ui\n" },
  ];
}

/** One Exec argument in double quotes (Desktop Entry spec): escape " ` $ \ with \, double every \ for the string value, % -> %%. */
const desktopArg = (s: string) => `"${s.replace(/["`$\\]/g, "\\$&").replaceAll("\\", "\\\\").replaceAll("%", "%%")}"`;

export function desktopEntry(shell: string, icon: string): string {
  return `[Desktop Entry]\nType=Application\nName=${NAME}\nComment=Start Claude UI, or open it when it runs\nExec=${desktopArg(shell)} -ilc "claude-ui open >/dev/null 2>&1 || exec claude-ui"\nIcon=${icon}\nTerminal=true\nCategories=Development;\nX-ClaudeUI-Shortcut=${MARK}\n`;
}

/** PowerShell that writes the .lnk (a binary .lnk is not hand-built). */
export function windowsScript(o: { lnk: string; comspec: string; icon: string; cwd: string }): string {
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
  return [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(o.lnk)})`,
    `$s.TargetPath = ${q(o.comspec)}`,
    // `call`: a .cmd run from a `cmd /c` line otherwise may not return to `||`.
    `$s.Arguments = '/c call claude-ui open >nul 2>&1 || claude-ui'`,
    `$s.WorkingDirectory = ${q(o.cwd)}`,
    `$s.IconLocation = ${q(`${o.icon},0`)}`,
    `$s.Description = 'Start Claude UI, or open it when it runs (${MARK})'`,
    `$s.Save()`,
  ].join("\n");
}

/** The entry's path: CLAUDE_UI_SHORTCUT_DIR (tests) or the OS folder; undefined for another OS. */
export function shortcutPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string | undefined {
  const dir = env.CLAUDE_UI_SHORTCUT_DIR;
  if (platform === "darwin") return posix.join(dir ?? posix.join(home, "Applications"), `${NAME}.app`);
  if (platform === "linux") return posix.join(dir ?? posix.join(env.XDG_DATA_HOME || posix.join(home, ".local/share"), "applications"), "claude-ui.desktop");
  if (platform === "win32" && (dir || env.APPDATA)) return win32.join(dir ?? win32.join(env.APPDATA!, "Microsoft/Windows/Start Menu/Programs"), `${NAME}.lnk`);
  return undefined;
}

const run = promisify(execFile);
const defaultExec = async (file: string, args: string[]) => void (await run(file, args, { windowsHide: true, timeout: 30_000 }));

export type Shortcut = { installed(): boolean; set(on: boolean): Promise<boolean> };

export function createShortcut(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; configDir: string; webRoot: string; shell?: string; exec?: (file: string, args: string[]) => Promise<void> }): Shortcut | undefined {
  const path = shortcutPath(o.platform, o.env, o.home);
  if (!path) return undefined;
  const shell = o.shell || "/bin/sh";
  const icon = join(o.configDir, o.platform === "win32" ? "claude-ui.ico" : "claude-ui.png");
  const write = (file: string, content: string | Buffer, mode?: number) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    if (mode) chmodSync(file, mode);
  };
  const installed = () => existsSync(path);
  // Data-loss guard: only an entry carrying MARK may be replaced or removed (a .lnk keeps its Description as UTF-16 or ANSI text).
  const guard = () => {
    if (!installed()) return;
    let ours = false;
    try {
      const b = readFileSync(o.platform === "darwin" ? join(path, "Contents/Info.plist") : path);
      ours = b.includes(MARK) || b.includes(Buffer.from(MARK, "utf16le"));
    } catch {}
    if (!ours) throw new Error(`${path} exists and was not made by claude-ui; remove or rename it yourself first`);
  };
  return {
    installed,
    async set(on) {
      guard();
      if (!on) {
        rmSync(path, { recursive: true, force: true });
        if (o.platform !== "darwin") rmSync(icon, { force: true });
        return installed();
      }
      if (o.platform === "darwin") {
        rmSync(path, { recursive: true, force: true });
        for (const f of macApp(shell)) write(join(path, f.path), f.content, f.mode);
        write(join(path, "Contents/Resources/icon.icns"), icns(readFileSync(join(o.webRoot, "icon-512.png"))));
      } else if (o.platform === "linux") {
        mkdirSync(o.configDir, { recursive: true });
        copyFileSync(join(o.webRoot, "icon-512.png"), icon);
        write(path, desktopEntry(shell, icon), 0o644);
      } else {
        write(icon, ico(readFileSync(join(o.webRoot, "icon-192.png")), 192));
        mkdirSync(dirname(path), { recursive: true });
        const script = windowsScript({ lnk: path, comspec: o.env.ComSpec ?? "cmd.exe", icon, cwd: o.home });
        await (o.exec ?? defaultExec)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
      }
      return installed();
    },
  };
}
