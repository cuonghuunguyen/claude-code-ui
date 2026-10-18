import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { daemonEnv, freePort, killCommand, ownerPorts, realConfigDirs, TOKEN_RE } from "../support/daemon.ts";
import { isolationBreaches, leakedUploads, sessionIds } from "../support/isolation.ts";
import { runDir, slug } from "../support/paths.ts";

describe("freePort", () => {
  it("skips excluded ports", async () => {
    const asked: number[] = [];
    const answers = [4280, 4281, 5000];
    const port = await freePort(new Set([4280, 4281]), undefined, async (p) => (asked.push(p), answers.shift()!));
    expect(port).toBe(5000);
    expect(asked).toEqual([0, 0, 0]);
  });
  it("refuses a preferred port that a real daemon uses", async () => {
    await expect(freePort(new Set([4280]), "4280")).rejects.toThrow(/real daemon/);
  });
  it("uses the preferred port when it is free", async () => {
    expect(await freePort(new Set([4280]), "5123", async (p) => p)).toBe(5123);
  });
});

describe("ownerPorts", () => {
  it("holds 4280 and the port of every daemon.json found", () => {
    const read = (f: string) => {
      if (f.includes("a")) return JSON.stringify({ port: 4999, pid: 1 });
      throw new Error("ENOENT");
    };
    expect([...ownerPorts(["/a", "/b"], read)].sort()).toEqual([4280, 4999]);
  });
});

describe("realConfigDirs", () => {
  it("lists ~/.config/claude-ui and %APPDATA%\\claude-ui", () => {
    expect(realConfigDirs({ APPDATA: "/ap" }, "/home/u")).toEqual([join("/home/u", ".config", "claude-ui"), join("/ap", "claude-ui")]);
    expect(realConfigDirs({}, "/home/u")).toEqual([join("/home/u", ".config", "claude-ui")]);
  });
  it("adds the runner's own XDG_CONFIG_HOME, unless it is the run's", () => {
    expect(realConfigDirs({ XDG_CONFIG_HOME: "/x" }, "/home/u")).toContain(join("/x", "claude-ui"));
    expect(realConfigDirs({ XDG_CONFIG_HOME: join("/r", "ui-config"), E2E_RUN_DIR: "/r" }, "/home/u")).toEqual([join("/home/u", ".config", "claude-ui")]);
    expect(realConfigDirs({ XDG_CONFIG_HOME: join("/home/u", ".config") }, "/home/u")).toEqual([join("/home/u", ".config", "claude-ui")]);
  });
});

describe("killCommand", () => {
  it("kills the tree by PID on Windows", () => {
    expect(killCommand(42, "win32")).toEqual({ cmd: "taskkill", args: ["/PID", "42", "/T", "/F"] });
  });
  it("signals the process group on POSIX", () => {
    expect(killCommand(42, "linux")).toEqual({ cmd: "kill", args: ["-TERM", "-42"] });
  });
});

describe("daemonEnv", () => {
  const env = daemonEnv({ ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_UI_HOSTNAME: "h", KEEP: "1", XDG_CONFIG_HOME: "/real" }, join("/run"), 5555);
  it("drops the API key variables", () => {
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.KEEP).toBe("1");
  });
  it("drops every inherited CLAUDE_UI_* and sets only the ones the test needs", () => {
    const e = daemonEnv({ CLAUDE_UI_LAN: "1", CLAUDE_UI_ALLOW_BYPASS: "1", CLAUDE_UI_CLAUDE_BIN: "x", CLAUDE_UI_OPEN: "1", OTHER: "o" }, "/run", 5555);
    expect(Object.keys(e).filter((k) => k.startsWith("CLAUDE_UI_")).sort()).toEqual(["CLAUDE_UI_OPEN", "CLAUDE_UI_ROOTS"]);
    expect(e.CLAUDE_UI_OPEN).toBe("0");
    expect(e.OTHER).toBe("o");
  });
  it("on Windows gives the daemon its own LOCALAPPDATA (uploads go there); elsewhere leaves it", () => {
    expect(daemonEnv({ LOCALAPPDATA: "C:\real" }, "/run", 5555, "win32").LOCALAPPDATA).toBe(join("/run", "localappdata"));
    expect(daemonEnv({ LOCALAPPDATA: "/real" }, "/run", 5555, "linux").LOCALAPPDATA).toBe("/real");
  });
  it("points the config at the run, sets the port and Haiku", () => {
    expect(env.XDG_CONFIG_HOME).toBe(join("/run", "ui-config"));
    expect(env.PORT).toBe("5555");
    expect(env.ANTHROPIC_MODEL).toBe("haiku");
    expect(env.CLAUDE_UI_OPEN).toBe("0");
  });
});

describe("TOKEN_RE", () => {
  it("reads the token of the pairing URL", () => {
    expect("Pair a browser: open http://127.0.0.1:5555/#token=ab_C-12\n".match(TOKEN_RE)?.[1]).toBe("ab_C-12");
  });
});

describe("paths", () => {
  it("runDir is stable once computed", () => {
    const env: NodeJS.ProcessEnv = { E2E_SCRATCH: "/s" };
    const a = runDir(env, new Date("2026-10-17T10:20:30Z"), 7);
    expect(a).toBe(join("/s", "20261017-102030-7"));
    expect(runDir(env, new Date(), 99)).toBe(a);
  });
  it("slug is folder-safe and short", () => {
    expect(slug("Send a prompt: The reply (390x844)")).toBe("send-a-prompt-the-reply-390x844");
    expect(slug("a".repeat(100)).length).toBe(60);
    expect(slug("The tab switcher stays in the titlebar at 390x844", 30)).not.toBe(slug("The tab switcher stays in the titlebar at 360x780", 30));
    expect(slug("***")).toBe("x");
  });
});

describe("uploads guard", () => {
  const id = "05498d02-3da4-49e5-b033-0b7a21c94ab1";
  it("reads session ids, lowercase and once", () => {
    expect(sessionIds(JSON.stringify({ [id.toUpperCase()]: { a: id }, other: "no" }))).toEqual([id]);
  });
  it("finds the ids that have a folder, ignoring case", () => {
    expect(leakedUploads([id, "11111111-1111-1111-1111-111111111111"], [id.toUpperCase(), "x"])).toEqual([id]);
    expect(leakedUploads([id], ["x"])).toEqual([]);
  });
});

describe("isolationBreaches", () => {
  const run = "C:\\Temp\\claude-ui-e2e\\20261017-1";
  it("finds the run path in a real config file, either slash style", () => {
    expect(isolationBreaches(run, { "projects.json": JSON.stringify([{ path: run + "\\projects\\x" }]) })).toEqual(["projects.json"]);
    expect(isolationBreaches(run, { "sessions.json": JSON.stringify({ cwd: "C:/Temp/claude-ui-e2e/20261017-1/projects/x" }) })).toEqual(["sessions.json"]);
  });
  it("ignores files that do not mention the run", () => {
    expect(isolationBreaches(run, { "projects.json": "[]" })).toEqual([]);
  });
});
