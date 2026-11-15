import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configDir, loadDaemonId, loadToken, pairingUrl } from "../src/token.ts";

// File modes are POSIX: on Windows chmod only sets the read-only flag, and %APPDATA% is private to the user by its ACL.
const posix = process.platform !== "win32";

describe("config dir", () => {
  it("is $XDG_CONFIG_HOME/claude-ui, else ~/.config/claude-ui", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x/cfg" }, "linux")).toBe(join("/x/cfg", "claude-ui"));
    expect(configDir({}, "linux")).toBe(join(homedir(), ".config", "claude-ui"));
  });

  it("on Windows is %APPDATA%\\claude-ui, unless ~/.config/claude-ui of an earlier run exists", () => {
    const env = { APPDATA: "C:\\Users\\me\\AppData\\Roaming" };
    expect(configDir(env, "win32", () => false)).toBe("C:\\Users\\me\\AppData\\Roaming\\claude-ui");
    expect(configDir(env, "win32", (p) => p === join(homedir(), ".config", "claude-ui"))).toBe(join(homedir(), ".config", "claude-ui"));
    // Set on purpose (tests, a moved config): it wins.
    expect(configDir({ ...env, XDG_CONFIG_HOME: "D:\\cfg" }, "win32", () => false)).toBe(join("D:\\cfg", "claude-ui"));
  });
});

describe("token", () => {
  it("is generated on first run, persisted owner-only, and reused on the next run", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "cfg-")), "claude-ui");
    const first = loadToken(dir);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(join(dir, "token"), "utf8").trim()).toBe(first);
    if (posix) expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);
    expect(loadToken(dir)).toBe(first);
  });

  it.runIf(posix)("restores owner-only permissions on an existing token file", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "cfg-")), "claude-ui");
    const token = loadToken(dir);
    chmodSync(join(dir, "token"), 0o644);
    expect(loadToken(dir)).toBe(token);
    expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);
  });

  it("puts the token in the URL fragment so it is never sent in an HTTP request", () => {
    expect(pairingUrl("http://127.0.0.1:4280", "abc")).toBe("http://127.0.0.1:4280/#token=abc");
  });
});

describe("daemon id (GH-771)", () => {
  it("is a random UUID created once as plain text in the config dir and reused", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "cfg-")), "claude-ui");
    const first = loadDaemonId(dir);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(readFileSync(join(dir, "daemon-id"), "utf8").trim()).toBe(first);
    expect(loadDaemonId(dir)).toBe(first);
  });

  it("a read or write failure gives a per-run id and one log line", () => {
    const base = mkdtempSync(join(tmpdir(), "cfg-"));
    // A file where the directory should be: mkdir and write fail.
    const blocked = join(base, "blocked");
    writeFileSync(blocked, "x");
    const log: string[] = [];
    const id = loadDaemonId(join(blocked, "claude-ui"), (m) => log.push(m));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(log).toHaveLength(1);
    // An unreadable id (a directory named daemon-id) is not an id either.
    const dir = join(base, "d");
    mkdirSync(join(dir, "daemon-id"), { recursive: true });
    const log2: string[] = [];
    expect(loadDaemonId(dir, (m) => log2.push(m))).toMatch(/^[0-9a-f-]{36}$/);
    expect(log2).toHaveLength(1);
  });
});
