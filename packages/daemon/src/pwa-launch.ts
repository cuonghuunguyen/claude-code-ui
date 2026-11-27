// GH-1016: `claude-ui open` and the daemon's auto-open start the installed claude-ui app (Chromium PWA) instead of a browser tab.
// Detection reads the OS entry Chromium writes at install; launch runs the browser binary with `--app-launch-url-for-shortcuts-menu-item`
// (the only flag that delivers a fragment such as `#token=` or `#<sessionId>` to an app window). docs/spec.md "Launcher shortcut".
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { isWsl, openInBrowser, runOpener } from "./ctl/commands.ts";

/** Chromium app id of a manifest id URL: `GenerateId(SHA256HashString(url))`, i.e. sha256 twice, first 16 bytes, hex 0-f written as a-p. */
export function chromiumAppId(manifestIdUrl: string): string {
  const once = createHash("sha256").update(manifestIdUrl).digest();
  const hex = createHash("sha256").update(once).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
}

export type PwaFs = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (p: string) => boolean;
  readFile: (p: string) => Buffer;
  /** Entry names of a folder; [] when it is missing. */
  readdir: (p: string) => string[];
};
/** `userDataDir`: only when it is not the browser's default one (`--user-data-dir`, else the launch would look in the default folder and open a plain window). */
export type PwaFound = { bin: string; profile: string; appId: string; userDataDir?: string };

/** Fixed order when several browsers have the app. */
const ORDER = ["chrome", "edge", "brave", "chromium"] as const;
type Browser = (typeof ORDER)[number];
const rank = (b: Browser) => ORDER.indexOf(b);

const MAC: Record<string, { browser: Browser; app: string; data: string }> = {
  "com.google.Chrome": { browser: "chrome", app: "Google Chrome", data: "Google/Chrome" },
  "com.microsoft.edgemac": { browser: "edge", app: "Microsoft Edge", data: "Microsoft Edge" },
  "com.brave.Browser": { browser: "brave", app: "Brave Browser", data: "BraveSoftware/Brave-Browser" },
  "org.chromium.Chromium": { browser: "chromium", app: "Chromium", data: "Chromium" },
};
const LINUX_PREFIX: Record<string, Browser> = { chrome: "chrome", msedge: "edge", brave: "brave", chromium: "chromium" };
const WIN: { browser: Browser; bins: [string, string][]; data: [string, string] }[] = [
  { browser: "chrome", bins: [["ProgramFiles", "Google\\Chrome\\Application\\chrome.exe"], ["ProgramFiles(x86)", "Google\\Chrome\\Application\\chrome.exe"], ["LOCALAPPDATA", "Google\\Chrome\\Application\\chrome.exe"]], data: ["LOCALAPPDATA", "Google\\Chrome\\User Data"] },
  { browser: "edge", bins: [["ProgramFiles(x86)", "Microsoft\\Edge\\Application\\msedge.exe"], ["ProgramFiles", "Microsoft\\Edge\\Application\\msedge.exe"]], data: ["LOCALAPPDATA", "Microsoft\\Edge\\User Data"] },
  { browser: "brave", bins: [["ProgramFiles", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"], ["ProgramFiles(x86)", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"], ["LOCALAPPDATA", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"]], data: ["LOCALAPPDATA", "BraveSoftware\\Brave-Browser\\User Data"] },
];

const text = (fs: PwaFs, p: string): string | undefined => {
  try {
    return fs.readFile(p).toString("utf8");
  } catch {
    return undefined;
  }
};

/** The profile folder of `userDataDir` that has the app installed (`Web Applications/Manifest Resources/<id>`): `prefer` when it has it, else Local State `profile.last_used` when it has it, else the first by name. */
function pickProfile(fs: PwaFs, join: (...p: string[]) => string, userDataDir: string, appId: string, prefer?: string): string | undefined {
  const has = fs.readdir(userDataDir).filter((d) => fs.exists(join(userDataDir, d, "Web Applications", "Manifest Resources", appId))).sort();
  if (!has.length) return undefined;
  if (prefer && has.includes(prefer)) return prefer;
  let last: unknown;
  try {
    last = JSON.parse(text(fs, join(userDataDir, "Local State")) ?? "").profile?.last_used;
  } catch {}
  return typeof last === "string" && has.includes(last) ? last : has[0];
}

/** `key`/`string` pairs of an XML plist. */
function plistStrings(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) out[m[1]!] = m[2]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return out;
}

function detectMac(fs: PwaFs, appId: string): PwaFound | undefined {
  const { join } = posix;
  const apps = join(fs.home, "Applications");
  const shims = fs.readdir(apps).filter((d) => d.endsWith(" Apps.localized")).flatMap((d) => fs.readdir(join(apps, d)).filter((a) => a.endsWith(".app")).map((a) => join(apps, d, a)));
  const found = shims.flatMap((shim) => {
    const xml = text(fs, join(shim, "Contents", "Info.plist"));
    const p = xml ? plistStrings(xml) : {};
    const b = p.CrBundleIdentifier ? MAC[p.CrBundleIdentifier] : undefined;
    return p.CrAppModeShortcutID === appId && b ? [{ b, dataDir: p.CrAppModeUserDataDir }] : [];
  });
  for (const { b, dataDir } of found.sort((x, y) => rank(x.b.browser) - rank(y.b.browser))) {
    const bin = ["/Applications", apps].map((d) => join(d, `${b.app}.app`, "Contents", "MacOS", b.app)).find(fs.exists);
    // `<user data dir>/-/Web Applications/_crx_<id>`: the shim names the user data dir, not the profile.
    const standard = join(fs.home, "Library", "Application Support", b.data);
    const userData = dataDir?.includes("/-/Web Applications/") ? dataDir.slice(0, dataDir.indexOf("/-/Web Applications/")) : standard;
    const profile = bin && pickProfile(fs, join, userData, appId);
    if (bin && profile) return { bin, profile, appId, ...(userData !== standard && { userDataDir: userData }) };
  }
}

/** Shell-like split of an `Exec=` value: spaces separate, double quotes group (also inside a word: `--profile-directory="Profile 1"`). */
const splitExec = (s: string) => [...s.matchAll(/(?:[^\s"]|"(?:[^"\\]|\\.)*")+/g)].map((m) => m[0].replace(/"((?:[^"\\]|\\.)*)"/g, "$1"));

function detectLinux(fs: PwaFs, appId: string): PwaFound | undefined {
  const { join } = posix;
  const dir = join(fs.env.XDG_DATA_HOME || join(fs.home, ".local", "share"), "applications");
  const entries = fs.readdir(dir).flatMap((f) => {
    const m = /^(chrome|msedge|brave|chromium)-([a-p]{32})-(.+)\.desktop$/.exec(f);
    return m && m[2] === appId ? [{ f, browser: LINUX_PREFIX[m[1]!]!, profile: m[3]! }] : [];
  });
  for (const e of entries.sort((x, y) => rank(x.browser) - rank(y.browser))) {
    const exec = /^Exec=(.*)$/m.exec(text(fs, join(dir, e.f)) ?? "")?.[1];
    const argv = exec ? splitExec(exec) : [];
    const bin = argv[0];
    if (!bin) continue;
    const profile = argv.find((a) => a.startsWith("--profile-directory="))?.slice("--profile-directory=".length) ?? e.profile;
    const userDataDir = argv.find((a) => a.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
    return { bin, profile, appId, ...(userDataDir && { userDataDir }) };
  }
}

function detectWin(fs: PwaFs, appId: string): PwaFound | undefined {
  const { join } = win32;
  const programs = join(fs.env.APPDATA ?? join(fs.home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs");
  // A .lnk holds its command line as UTF-16 text: drop the zero bytes and search.
  const lnk = (p: string) => (/\.lnk$/i.test(p) ? fs.readFile(p).toString("latin1").replace(/\0/g, "") : "");
  const files = fs.readdir(programs).flatMap((n) => (/\.lnk$/i.test(n) ? [join(programs, n)] : fs.readdir(join(programs, n)).map((m) => join(programs, n, m))));
  let prefer: string | undefined;
  let hit = false;
  for (const f of files) {
    let t = "";
    try {
      t = lnk(f);
    } catch {}
    if (!t.includes(`--app-id=${appId}`)) continue;
    hit = true;
    prefer = /--profile-directory=(?:"([^"]+)"|([^\s"]+))/.exec(t)?.slice(1).find(Boolean);
    break;
  }
  if (!hit) return undefined;
  for (const b of WIN) {
    const bin = b.bins.flatMap(([v, rel]) => (fs.env[v] ? [join(fs.env[v]!, rel)] : [])).find(fs.exists);
    const base = fs.env[b.data[0]];
    const profile = bin && base && pickProfile(fs, join, join(base, b.data[1]), appId, prefer);
    if (bin && profile) return { bin, profile, appId };
  }
}

/** The installed claude-ui app of `origin` (its manifest id is `<origin>/`) on this computer, or undefined when none is: the OS entry Chromium writes at install proves it, the profile folder names the profile. */
export function detectPwa(fs: PwaFs, origin: string): PwaFound | undefined {
  const appId = chromiumAppId(`${origin}/`);
  try {
    return fs.platform === "darwin" ? detectMac(fs, appId) : fs.platform === "win32" ? detectWin(fs, appId) : fs.platform === "linux" ? detectLinux(fs, appId) : undefined;
  } catch {
    return undefined;
  }
}

/** The command that opens `target` (a URL of the app's scope, fragment kept) in the installed app. */
export function pwaLaunchArgs(f: PwaFound, target: string): [string, string[]] {
  return [f.bin, [...(f.userDataDir ? [`--user-data-dir=${f.userDataDir}`] : []), `--profile-directory=${f.profile}`, `--app-id=${f.appId}`, `--app-launch-url-for-shortcuts-menu-item=${target}`]];
}

const realFs = (): PwaFs => ({
  platform: process.platform,
  env: process.env,
  home: homedir(),
  exists: existsSync,
  readFile: (p) => readFileSync(p),
  readdir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
});

export type OpenAppDeps = { fs: PwaFs; wsl: boolean; run: (cmd: string, args: string[]) => Promise<void>; browser: (url: string) => Promise<void> };
const realDeps = (): OpenAppDeps => ({
  fs: realFs(),
  wsl: isWsl,
  run: (cmd, args) => runOpener(cmd, args, undefined, { detached: process.platform !== "win32" }),
  browser: openInBrowser,
});

/** Opens `target` in the installed app; with none installed (or a launch that fails, or a WSL daemon) in the default browser. Resolves with where it opened. */
export async function openApp(target: string, d: OpenAppDeps = realDeps()): Promise<"app" | "browser"> {
  const found = d.wsl ? undefined : detectPwa(d.fs, new URL(target).origin);
  if (found) {
    try {
      await d.run(...pwaLaunchArgs(found, target));
      return "app";
    } catch {}
  }
  await d.browser(target);
  return "browser";
}
