import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createShortcut, desktopEntry, icns, ico, macApp, shQuote, shortcutPath, windowsScript } from "../src/shortcut.ts";

const png = Buffer.from("89504e470d0a1a0a00112233", "hex");

describe("icon containers", () => {
  it("icns wraps a PNG in one ic09 entry", () => {
    const b = icns(png);
    expect(b.toString("latin1", 0, 4)).toBe("icns");
    expect(b.readUInt32BE(4)).toBe(b.length);
    expect(b.toString("latin1", 8, 12)).toBe("ic09");
    expect(b.readUInt32BE(12)).toBe(8 + png.length);
    expect(b.subarray(16).equals(png)).toBe(true);
  });
  it("ico wraps a PNG in one entry", () => {
    const b = ico(png, 192);
    expect([b.readUInt16LE(2), b.readUInt16LE(4), b[6], b[7]]).toEqual([1, 1, 192, 192]);
    expect(b.readUInt32LE(14)).toBe(png.length);
    expect(b.readUInt32LE(18)).toBe(22);
    expect(b.subarray(22).equals(png)).toBe(true);
    expect(ico(png, 256)[6]).toBe(0);
  });
});

describe("generators", () => {
  it("macOS app", () => {
    const files = macApp("/bin/zsh");
    const get = (p: string) => files.find((f) => f.path === p)!;
    const plist = get("Contents/Info.plist").content;
    expect(plist).toMatch(/<key>CFBundleExecutable<\/key>\s*<string>claude-ui<\/string>/);
    expect(plist).toMatch(/<key>CFBundleIconFile<\/key>\s*<string>icon<\/string>/);
    const exe = get("Contents/MacOS/claude-ui");
    expect(exe.mode).toBe(0o755);
    expect(exe.content.startsWith("#!/bin/sh")).toBe(true);
    expect(exe.content).toContain("'/bin/zsh' -ilc 'claude-ui open'");
    expect(exe.content).toContain("open -a Terminal");
    expect(get("Contents/Resources/start.command").mode).toBe(0o755);
    expect(get("Contents/Resources/start.command").content).toContain("exec claude-ui");
    expect(files.some((f) => f.content.includes(process.execPath))).toBe(false);
  });
  it("macOS app quotes a shell with a quote", () => {
    expect(shQuote("/opt/it's/zsh")).toBe("'/opt/it'\\''s/zsh'");
    expect(macApp("/opt/it's/zsh")[1]!.content).toContain("'/opt/it'\\''s/zsh' -ilc");
  });
  it("Linux desktop entry", () => {
    expect(desktopEntry("/bin/bash", "/c/claude-ui.png")).toBe(
      `[Desktop Entry]\nType=Application\nName=Claude UI\nComment=Start Claude UI, or open it when it runs\nExec="/bin/bash" -ilc "claude-ui open >/dev/null 2>&1 || exec claude-ui"\nIcon=/c/claude-ui.png\nTerminal=true\nCategories=Development;\n`,
    );
  });
  it("Linux Exec escapes reserved characters", () => {
    // $ gets a backslash (quoting), then every backslash doubles (string value); % doubles.
    expect(desktopEntry("/x/$a b%", "i")).toContain(`Exec="/x/\\\\$a b%%" -ilc`);
  });
  it("Windows script", () => {
    const s = windowsScript({ lnk: "C:\\U\\O'Brien\\Claude UI.lnk", comspec: "C:\\Windows\\system32\\cmd.exe", icon: "C:\\c\\claude-ui.ico", cwd: "C:\\U" });
    for (const part of ["CreateShortcut('C:\\U\\O''Brien\\Claude UI.lnk')", "TargetPath = 'C:\\Windows\\system32\\cmd.exe'", "Arguments = '/c call claude-ui open >nul 2>&1 || claude-ui'", "IconLocation = 'C:\\c\\claude-ui.ico,0'", "$s.Save()"]) expect(s).toContain(part);
  });
  it("shortcutPath per OS and override", () => {
    expect(shortcutPath("darwin", {}, "/h")).toBe("/h/Applications/Claude UI.app");
    expect(shortcutPath("linux", {}, "/h")).toBe("/h/.local/share/applications/claude-ui.desktop");
    expect(shortcutPath("linux", { XDG_DATA_HOME: "/x" }, "/h")).toBe("/x/applications/claude-ui.desktop");
    expect(shortcutPath("win32", { APPDATA: "C:\\A" }, "C:\\h")).toBe("C:\\A\\Microsoft\\Windows\\Start Menu\\Programs\\Claude UI.lnk");
    expect(shortcutPath("linux", { CLAUDE_UI_SHORTCUT_DIR: "/s" }, "/h")).toBe("/s/claude-ui.desktop");
    expect(shortcutPath("freebsd", {}, "/h")).toBeUndefined();
  });
});

describe("createShortcut", () => {
  const setup = (platform: NodeJS.Platform, exec?: (f: string, a: string[]) => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), "shortcut-"));
    const webRoot = join(root, "web");
    mkdirSync(webRoot);
    for (const n of ["icon-512.png", "icon-192.png"]) writeFileSync(join(webRoot, n), png);
    const dir = join(root, "entries");
    const configDir = join(root, "config");
    return { dir, configDir, shortcut: createShortcut({ platform, env: { CLAUDE_UI_SHORTCUT_DIR: dir }, home: root, configDir, webRoot, shell: "/bin/zsh", exec })! };
  };
  it("creates and removes the macOS app", async () => {
    const { dir, shortcut } = setup("darwin");
    expect(shortcut.installed()).toBe(false);
    expect(await shortcut.set(true)).toBe(true);
    const app = join(dir, "Claude UI.app");
    expect(existsSync(join(app, "Contents/Resources/icon.icns"))).toBe(true);
    if (process.platform !== "win32") expect(statSync(join(app, "Contents/MacOS/claude-ui")).mode & 0o111).not.toBe(0);
    expect(await shortcut.set(false)).toBe(false);
    expect(existsSync(app)).toBe(false);
  });
  it("creates and removes the Linux entry and icon", async () => {
    const { dir, configDir, shortcut } = setup("linux");
    expect(await shortcut.set(true)).toBe(true);
    expect(readFileSync(join(dir, "claude-ui.desktop"), "utf8")).toContain(`Icon=${join(configDir, "claude-ui.png")}`);
    expect(existsSync(join(configDir, "claude-ui.png"))).toBe(true);
    expect(await shortcut.set(false)).toBe(false);
    expect(existsSync(join(configDir, "claude-ui.png"))).toBe(false);
  });
  it("Windows runs PowerShell with the encoded script", async () => {
    const calls: [string, string[]][] = [];
    const { configDir, shortcut } = setup("win32", async (f, a) => void calls.push([f, a]));
    await shortcut.set(true);
    expect(calls).toHaveLength(1);
    const [file, args] = calls[0]!;
    expect(file).toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(Buffer.from(args[3]!, "base64").toString("utf16le")).toContain("CreateShortcut");
    expect(existsSync(join(configDir, "claude-ui.ico"))).toBe(true);
    await shortcut.set(false);
    expect(existsSync(join(configDir, "claude-ui.ico"))).toBe(false);
  });
  it("an unsupported platform gives no shortcut", () => {
    expect(createShortcut({ platform: "aix", env: {}, home: "/h", configDir: "/c", webRoot: "/w" })).toBeUndefined();
  });
});
