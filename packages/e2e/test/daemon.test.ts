import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { daemonEnv, freePort, killCommand, ownerPorts, realConfigDirs, TOKEN_RE } from "../support/daemon.ts";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assertUploadsIsolated, isolationBreaches, leakedUploads, sessionIds } from "../support/isolation.ts";
import { commandLineMentions, stopRun } from "../support/stop.ts";
import { runDir, slug } from "../support/paths.ts";
import { fakeDockerScript, writeFakeDocker } from "../support/fake-docker.ts";
import { spawnSync } from "node:child_process";

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

const SIDE = join("/home/u", ".cache", "claude-ui", "side");
describe("realConfigDirs", () => {
  it("lists ~/.config/claude-ui and %APPDATA%\\claude-ui", () => {
    expect(realConfigDirs({ APPDATA: "/ap" }, "/home/u")).toEqual([join("/home/u", ".config", "claude-ui"), join("/ap", "claude-ui"), SIDE]);
    expect(realConfigDirs({}, "/home/u")).toEqual([join("/home/u", ".config", "claude-ui"), SIDE]);
  });
  it("adds the runner's own XDG_CONFIG_HOME, unless it is the run's", () => {
    expect(realConfigDirs({ XDG_CONFIG_HOME: "/x" }, "/home/u")).toContain(join("/x", "claude-ui"));
    expect(realConfigDirs({ XDG_CONFIG_HOME: join("/r", "ui-config"), E2E_RUN_DIR: "/r" }, "/home/u")).toEqual([join("/home/u", ".config", "claude-ui"), SIDE]);
    expect(realConfigDirs({ XDG_CONFIG_HOME: join("/home/u", ".config") }, "/home/u")).toEqual([join("/home/u", ".config", "claude-ui"), SIDE]);
  });
  it("lists the owner's side part cache (XDG_CACHE_HOME or ~/.cache; Windows LOCALAPPDATA), unless it is the run's", () => {
    expect(realConfigDirs({ XDG_CACHE_HOME: "/xc" }, "/home/u")).toContain(join("/xc", "claude-ui", "side"));
    expect(realConfigDirs({ XDG_CACHE_HOME: join("/r", "cache"), E2E_RUN_DIR: "/r" }, "/home/u")).not.toContain(join("/r", "cache", "claude-ui", "side"));
    expect(realConfigDirs({ LOCALAPPDATA: "/la" }, "/home/u", "win32")).toContain(join("/la", "claude-ui", "cache", "side"));
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
    expect(daemonEnv({ LOCALAPPDATA: "C:\\real" }, "/run", 5555, "win32").LOCALAPPDATA).toBe(join("/run", "localappdata"));
    expect(daemonEnv({ LOCALAPPDATA: "/real" }, "/run", 5555, "linux").LOCALAPPDATA).toBe("/real");
  });
  it("gives the daemon its own cache dir: the side parts never land in the owner's ~/.cache", () => {
    expect(daemonEnv({ XDG_CACHE_HOME: "/real-cache" }, "/run", 5555).XDG_CACHE_HOME).toBe(join("/run", "cache"));
    expect(daemonEnv({}, "/run", 5555).XDG_CACHE_HOME).toBe(join("/run", "cache"));
  });
  it("a path prefix goes first on PATH (a fake docker), else PATH is unchanged", () => {
    expect(daemonEnv({ PATH: "/usr/bin" }, "/run", 5555, "linux", "/run/bin").PATH).toBe(`/run/bin${delimiter}/usr/bin`);
    expect(daemonEnv({ PATH: "/usr/bin" }, "/run", 5555).PATH).toBe("/usr/bin");
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
  it("runDir is stable once computed and resolves a symlinked scratch", () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), "e2e-paths-")));
    const link = `${real}-link`;
    symlinkSync(real, link);
    try {
      const env: NodeJS.ProcessEnv = { E2E_SCRATCH: link };
      const a = runDir(env, new Date("2026-10-17T10:20:30Z"), 7);
      expect(a).toBe(join(real, "20261017-102030-7"));
      expect(runDir(env, new Date(), 99)).toBe(a);
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
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

describe("assertUploadsIsolated", () => {
  const id = "05498d02-3da4-49e5-b033-0b7a21c94ab1";
  const tmp: string[] = [];
  afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const setup = (opts: { sessions: boolean; ownUploads: boolean; realFolders: string[] }) => {
    const base = mkdtempSync(join(tmpdir(), "e2e-guard-"));
    tmp.push(base);
    const run = join(base, "run");
    const real = join(base, "real");
    mkdirSync(join(run, "ui-config", "claude-ui"), { recursive: true });
    mkdirSync(join(real, "claude-ui", "uploads"), { recursive: true });
    if (opts.sessions) writeFileSync(join(run, "ui-config", "claude-ui", "sessions.json"), JSON.stringify({ [id]: {} }));
    if (opts.ownUploads) mkdirSync(join(run, "localappdata", "claude-ui", "uploads"), { recursive: true });
    for (const f of opts.realFolders) mkdirSync(join(real, "claude-ui", "uploads", f));
    return { run, env: { LOCALAPPDATA: real } };
  };
  it("passes when the uploads are under the run and the real folder has none of its sessions", () => {
    const { run, env } = setup({ sessions: true, ownUploads: true, realFolders: ["11111111-1111-1111-1111-111111111111"] });
    expect(() => assertUploadsIsolated(run, env, "win32")).not.toThrow();
  });
  it("fails when the real folder holds a folder of a session of the run", () => {
    const { run, env } = setup({ sessions: true, ownUploads: true, realFolders: [id] });
    expect(() => assertUploadsIsolated(run, env, "win32")).toThrow(/UPLOADS BREACH.*holds/);
  });
  it("fails when the run has sessions but no uploads folder of its own", () => {
    const { run, env } = setup({ sessions: true, ownUploads: false, realFolders: [] });
    expect(() => assertUploadsIsolated(run, env, "win32")).toThrow(/does not exist/);
  });
  it("does nothing without sessions or off Windows", () => {
    expect(() => assertUploadsIsolated(setup({ sessions: false, ownUploads: false, realFolders: [id] }).run, {}, "win32")).not.toThrow();
    const { run, env } = setup({ sessions: true, ownUploads: false, realFolders: [id] });
    expect(() => assertUploadsIsolated(run, env, "linux")).not.toThrow();
  });
});

describe("stop", () => {
  it("matches a command line that holds the run folder in any slash style or case", () => {
    expect(commandLineMentions(["node main.ts --roots C:", "Tmp", "Run-1", "projects"].join(String.fromCharCode(92)), "c:/tmp/run-1")).toBe(true);
    expect(commandLineMentions("node main.ts --roots /other/projects", "/tmp/run-1")).toBe(false);
    expect(commandLineMentions("node main.ts --roots /tmp/run-10/projects", "/tmp/run-1")).toBe(false);
    expect(commandLineMentions("", "/tmp/run-1")).toBe(false);
  });
  it("kills the runner and only the daemons whose command line holds the run, and clears the pid files", () => {
    const base = mkdtempSync(join(tmpdir(), "e2e-stop-"));
    try {
      const run = join(base, "run");
      mkdirSync(run);
      writeFileSync(join(run, "runner.pid"), "11");
      writeFileSync(join(run, "daemon-w0.pid"), "22");
      writeFileSync(join(run, "daemon-w1.pid"), "33");
      const killed: number[] = [];
      const cmd = (p: number) => (p === 11 ? "node node_modules/@playwright/test/cli.js test --debug=cli" : p === 22 ? `node --roots ${join(run, "projects")}` : "unrelated");
      stopRun(run, (p) => void killed.push(p), cmd);
      expect(killed).toEqual([11, 22]);
      writeFileSync(join(run, "runner.pid"), "44");
      const reused: number[] = [];
      stopRun(run, (p) => void reused.push(p), cmd);
      expect(reused).toEqual([]);
      expect(() => stopRun(join(base, "nope"), () => {}, () => "")).toThrow(/no such run/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("fake docker", () => {
  const cfg = { containers: ["dev", "k8s_pod"], probe: { code: 1, stdout: "", stderr: "OCI runtime exec failed: it's \"bad\"" }, check: { stdout: "CLAUDE_UI_CHECK arch=x86_64\n" }, setup: { code: 1, stdout: "CLAUDE_UI_SETUP node_missing\n" } };
  const run = (args: string[]) => spawnSync("sh", ["-c", fakeDockerScript(cfg), "docker", ...args], { encoding: "utf8" });
  it("answers version, ps, inspect and cp like a running Linux container", () => {
    expect(run(["version", "--format", "{{.Server.Os}}"]).stdout.trim()).toBe("linux");
    expect(run(["ps", "--filter", "status=running", "--format", "{{.Names}}"]).stdout.split("\n").filter(Boolean)).toEqual(["dev", "k8s_pod"]);
    expect(run(["inspect", "-f", "{{.State.Running}}", "dev"]).stdout.trim()).toBe("true");
    expect(run(["inspect", "-f", "{{.HostConfig.ReadonlyRootfs}}{{range .Mounts}}x{{end}}", "dev"]).stdout).toBe("false\n/data true\nnull\n");
    expect(run(["cp", "a", "dev:/tmp/a"]).status).toBe(0);
  });
  it("exec picks the probe, the check or the setup script by what the script says, and replays the configured answer", () => {
    const probe = run(["exec", "dev", "sh", "-c", 'emit() { :; }; emit arch "$(uname -m)"']);
    expect([probe.status, probe.stderr]).toEqual([1, cfg.probe.stderr]);
    expect(run(["exec", "dev", "sh", "-c", "emit installed none"]).stdout).toBe(cfg.check.stdout);
    const setup = run(["exec", "-i", "dev", "sh", "-c", "echo CLAUDE_UI_SETUP x"]);
    expect([setup.status, setup.stdout]).toEqual([1, cfg.setup.stdout]);
  });
  it("GH-458: log lines per call and per setup exec; side makes the setup exec run a real side under its home (not run here)", () => {
    const d = mkdtempSync(join(tmpdir(), "fake-docker-"));
    try {
      const log = join(d, "docker.log");
      const withLog = { ...cfg, log };
      const sh = (c: typeof withLog & { side?: { home: string; repo: string; projects: string } }, args: string[]) => spawnSync("sh", ["-c", fakeDockerScript(c), "docker", ...args], { encoding: "utf8" });
      sh(withLog, ["cp", "a", "dev:/tmp/a"]);
      sh(withLog, ["exec", "-i", "dev", "sh", "-c", "echo CLAUDE_UI_SETUP x"]);
      expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual(["cp", "setup", "exec"]);
      // The side script is built, never started here: only its text is checked.
      const text = fakeDockerScript({ ...withLog, side: { home: join(d, "h"), repo: "/repo", projects: join(d, "p") } });
      expect(text).toContain("side.pid");
      expect(text).toContain("--side --roots");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("writeFakeDocker writes an executable <run>/bin/docker and returns the folder to put on PATH", () => {
    const d = mkdtempSync(join(tmpdir(), "fake-docker-"));
    try {
      const bin = writeFakeDocker(d, cfg);
      expect(bin).toBe(join(d, "bin"));
      expect(spawnSync(join(bin, "docker"), ["version"], { encoding: "utf8" }).stdout.trim()).toBe("linux");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
