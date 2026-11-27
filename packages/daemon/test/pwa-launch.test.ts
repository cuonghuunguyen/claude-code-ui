import { describe, expect, it } from "vitest";
import { chromiumAppId, detectPwa, openApp, pwaLaunchArgs, type PwaFs } from "../src/pwa-launch.ts";

const ID = chromiumAppId("http://127.0.0.1:4744/");
const plist = (o: Record<string, string>) => `<?xml version="1.0"?><plist><dict>${Object.entries(o).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("")}</dict></plist>`;

/** An in-memory file system: path -> file content; folders are implied by the paths. */
function mem(platform: NodeJS.Platform, files: Record<string, string | Buffer>, env: NodeJS.ProcessEnv = {}, home = platform === "win32" ? "C:\\Users\\u" : "/h"): PwaFs {
  const sep = platform === "win32" ? "\\" : "/";
  const paths = Object.keys(files);
  return {
    platform,
    env,
    home,
    exists: (p) => paths.some((f) => f === p || f.startsWith(p + sep)),
    readFile: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return Buffer.from(files[p]!);
    },
    readdir: (p) => [...new Set(paths.filter((f) => f.startsWith(p + sep)).map((f) => f.slice(p.length + 1).split(sep)[0]!))],
  };
}

describe("chromiumAppId", () => {
  it("is sha256 twice, a-p (probe vector of Chrome 158)", () => {
    expect(chromiumAppId("http://127.0.0.1:47811/")).toBe("bgckcecldolnjomemkfadgohcmmknkdh");
  });
});

describe("detectPwa", () => {
  const chromeBin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const dataDir = "/h/Library/Application Support/Google/Chrome";
  const shim = (id: string, over: Record<string, string> = {}) =>
    plist({ CrAppModeShortcutID: id, CrBundleIdentifier: "com.google.Chrome", CrAppModeUserDataDir: `${dataDir}/-/Web Applications/_crx_${id}`, ...over });
  const marker = (profile: string, id = ID) => ({ [`${dataDir}/${profile}/Web Applications/Manifest Resources/${id}/icon.png`]: "" });
  const chromeShim = "/h/Applications/Chrome Apps.localized/Claude UI.app/Contents/Info.plist";

  it("macOS: the shim of this id and port finds browser binary and profile; another port, localhost or no shim: none", () => {
    const files = { [chromeBin]: "", [chromeShim]: shim(ID), ...marker("Default") };
    expect(detectPwa(mem("darwin", files), "http://127.0.0.1:4744")).toEqual({ bin: chromeBin, profile: "Default", appId: ID });
    expect(detectPwa(mem("darwin", files), "http://127.0.0.1:4745")).toBeUndefined();
    expect(detectPwa(mem("darwin", files), "http://localhost:4744")).toBeUndefined();
    expect(detectPwa(mem("darwin", { [chromeBin]: "" }), "http://127.0.0.1:4744")).toBeUndefined();
  });
  it("macOS: a non-default user data dir is kept for the launch (--user-data-dir)", () => {
    const alt = "/t/ud";
    const files = { [chromeBin]: "", [chromeShim]: shim(ID, { CrAppModeUserDataDir: `${alt}/-/Web Applications/_crx_${ID}` }), [`${alt}/Default/Web Applications/Manifest Resources/${ID}/i`]: "" };
    const f = detectPwa(mem("darwin", files), "http://127.0.0.1:4744");
    expect(f).toEqual({ bin: chromeBin, profile: "Default", appId: ID, userDataDir: alt });
    expect(pwaLaunchArgs(f!, "http://127.0.0.1:4744/")[1][0]).toBe("--user-data-dir=/t/ud");
  });
  it("macOS: two profiles pick Local State last_used, else the first; no profile with the app: none (browser tab)", () => {
    const base = { [chromeBin]: "", [chromeShim]: shim(ID), ...marker("Default"), ...marker("Profile 1") };
    expect(detectPwa(mem("darwin", base), "http://127.0.0.1:4744")?.profile).toBe("Default");
    const last = { ...base, [`${dataDir}/Local State`]: JSON.stringify({ profile: { last_used: "Profile 1" } }) };
    expect(detectPwa(mem("darwin", last), "http://127.0.0.1:4744")?.profile).toBe("Profile 1");
    expect(detectPwa(mem("darwin", { [chromeBin]: "", [chromeShim]: shim(ID) }), "http://127.0.0.1:4744")).toBeUndefined();
  });
  it("macOS: Chrome before Brave when both have it", () => {
    const brave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
    const bd = "/h/Library/Application Support/BraveSoftware/Brave-Browser";
    const files = {
      [chromeBin]: "",
      [brave]: "",
      "/h/Applications/Brave Browser Apps.localized/Claude UI.app/Contents/Info.plist": shim(ID, { CrBundleIdentifier: "com.brave.Browser", CrAppModeUserDataDir: `${bd}/-/Web Applications/_crx_${ID}` }),
      [`${bd}/Default/Web Applications/Manifest Resources/${ID}/i`]: "",
      [chromeShim]: shim(ID),
      ...marker("Profile 2"),
    };
    expect(detectPwa(mem("darwin", files), "http://127.0.0.1:4744")).toEqual({ bin: chromeBin, profile: "Profile 2", appId: ID });
  });
  it("Linux: the .desktop entry gives binary and profile; XDG_DATA_HOME is honoured", () => {
    const files = { [`/h/.local/share/applications/chrome-${ID}-Profile 1.desktop`]: `[Desktop Entry]\nExec=/opt/google/chrome/chrome --profile-directory="Profile 1" --app-id=${ID}\n` };
    expect(detectPwa(mem("linux", files), "http://127.0.0.1:4744")).toEqual({ bin: "/opt/google/chrome/chrome", profile: "Profile 1", appId: ID });
    const x = { [`/x/applications/brave-${ID}-Default.desktop`]: `Exec=brave-browser --app-id=${ID}\n` };
    expect(detectPwa(mem("linux", x, { XDG_DATA_HOME: "/x" }), "http://127.0.0.1:4744")).toEqual({ bin: "brave-browser", profile: "Default", appId: ID });
    expect(detectPwa(mem("linux", files), "http://127.0.0.1:1")).toBeUndefined();
  });
  it("Windows: a Start Menu .lnk with the app id, the browser binary and the profile folder", () => {
    const env = { APPDATA: "C:\\Users\\u\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", ProgramFiles: "C:\\Program Files" };
    const lnkPath = "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Chrome Apps\\Claude UI.lnk";
    const bin = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const ud = "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data";
    const files = {
      [lnkPath]: Buffer.from(`--profile-directory="Profile 1" --app-id=${ID}`, "utf16le"),
      [bin]: "",
      [`${ud}\\Default\\Web Applications\\Manifest Resources\\${ID}\\i`]: "",
      [`${ud}\\Profile 1\\Web Applications\\Manifest Resources\\${ID}\\i`]: "",
    };
    expect(detectPwa(mem("win32", files, env), "http://127.0.0.1:4744")).toEqual({ bin, profile: "Profile 1", appId: ID });
    expect(detectPwa(mem("win32", { ...files, [lnkPath]: Buffer.from("--app-id=zzzz", "utf16le") }, env), "http://127.0.0.1:4744")).toBeUndefined();
  });
});

describe("pwaLaunchArgs and openApp", () => {
  const target = "http://127.0.0.1:4744/#token=abc";
  const files = { [`/h/.local/share/applications/chrome-${ID}-Default.desktop`]: `Exec=/b/chrome --app-id=${ID}` };
  const deps = (run: () => Promise<void>) => {
    const calls: string[] = [];
    return { calls, d: { fs: mem("linux", files), wsl: false, run: async (c: string, a: string[]) => (calls.push(["app", c, ...a].join(" ")), run()), browser: async (u: string) => void calls.push("browser " + u) } };
  };
  it("the launch flags carry the profile, the app id and the full URL with its fragment", () => {
    expect(pwaLaunchArgs({ bin: "/b/chrome", profile: "Default", appId: ID }, target)).toEqual(["/b/chrome", ["--profile-directory=Default", `--app-id=${ID}`, `--app-launch-url-for-shortcuts-menu-item=${target}`]]);
  });
  it("opens the app when installed; a failing launch falls back to the browser; WSL and no app use the browser", async () => {
    const a = deps(async () => {});
    expect(await openApp(target, a.d)).toBe("app");
    expect(a.calls).toHaveLength(1);
    const f = deps(() => Promise.reject(new Error("spawn ENOENT")));
    expect(await openApp(target, f.d)).toBe("browser");
    expect(f.calls.at(-1)).toBe("browser " + target);
    const w = deps(async () => {});
    expect(await openApp(target, { ...w.d, wsl: true })).toBe("browser");
    expect(w.calls).toEqual(["browser " + target]);
    expect(await openApp("http://127.0.0.1:9/", deps(async () => {}).d)).toBe("browser");
  });
});
