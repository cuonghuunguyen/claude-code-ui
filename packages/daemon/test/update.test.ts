import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareVersions, createUpdater, installedVersions, installVersion, latestNewer, parseRegistry, pruneVersions, RESTART_CODE, type Runner } from "../src/update.ts";

const answer = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

/** A fake npm that "installs" `version` the way npm lays it out. */
const fakeNpm = (version = "0.2.1"): Runner & { calls: string[][] } => {
  const calls: string[][] = [];
  const run = (async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const pkg = join(args[args.indexOf("--prefix") + 1]!, "node_modules", "claude-code-ui");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ version }));
    writeFileSync(join(pkg, "dist", "cli.js"), "");
    return { code: 0, output: "" };
  }) as Runner & { calls: string[][] };
  run.calls = calls;
  return run;
};

const dir = () => mkdtempSync(join(tmpdir(), "cu-versions-"));

afterEach(() => vi.useRealTimers());

describe("latestNewer", () => {
  it("returns a newer registry version only", async () => {
    expect(await latestNewer("0.2.0", { fetch: answer({ version: "0.2.1" }) })).toBe("0.2.1");
    expect(await latestNewer("0.2.0", { fetch: answer({ version: "0.10.0" }) })).toBe("0.10.0");
    expect(await latestNewer("0.2.0", { fetch: answer({ version: "0.2.0" }) })).toBeUndefined();
    expect(await latestNewer("0.2.0", { fetch: answer({ version: "0.1.9" }) })).toBeUndefined();
  });
  it("ignores a failed request, a bad answer and a source checkout", async () => {
    const thrower = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await latestNewer("0.2.0", { fetch: thrower })).toBeUndefined();
    expect(await latestNewer("0.2.0", { fetch: answer({ version: "9.9.9" }, false) })).toBeUndefined();
    for (const version of ["1.0.0-beta.1", "../../evil", "1.0.0 && rm -rf /", 3, null]) expect(await latestNewer("0.2.0", { fetch: answer({ version }) })).toBeUndefined();
    expect(await latestNewer("0.2.0", { fetch: answer(null) })).toBeUndefined();
    const f = vi.fn(answer({ version: "9.9.9" }));
    expect(await latestNewer("dev", { fetch: f })).toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });
  it("asks <registry>/claude-code-ui/latest", async () => {
    const f = vi.fn(answer({ version: "0.2.1" }));
    await latestNewer("0.2.0", { fetch: f, registry: "http://127.0.0.1:9" });
    expect(f.mock.calls[0]![0]).toBe("http://127.0.0.1:9/claude-code-ui/latest");
  });
  it("compares numerically", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("installVersion", () => {
  it("runs npm install --prefix into the versions dir and keeps a complete install only", async () => {
    const d = dir();
    const run = fakeNpm();
    await installVersion(d, "0.2.1", { run });
    expect(run.calls[0]).toEqual(["npm", "install", "--prefix", join(d, "0.2.1.partial"), "--omit=dev", "--no-save", "--no-fund", "--no-audit", "--loglevel=error", "--registry", "https://registry.npmjs.org", "claude-code-ui@0.2.1"]);
    expect(readdirSync(d)).toEqual(["0.2.1"]);
    expect(installedVersions(d)).toEqual(["0.2.1"]);
    await installVersion(d, "0.2.1", { run });
    expect(run.calls).toHaveLength(1);
  });
  it("fails with npm's last lines and leaves nothing behind", async () => {
    const d = dir();
    const run: Runner = async () => ({ code: 1, output: "a\nb\nnpm ERR! code E404\nnpm ERR! 404 Not Found\nnpm ERR! end\n" });
    await expect(installVersion(d, "0.2.1", { run })).rejects.toThrow("npm ERR! code E404\nnpm ERR! 404 Not Found\nnpm ERR! end");
    expect(readdirSync(d)).toEqual([]);
  });
  it("refuses a different installed version and a bad version string", async () => {
    const d = dir();
    await expect(installVersion(d, "0.2.1", { run: fakeNpm("0.2.2") })).rejects.toThrow("npm installed 0.2.2, not 0.2.1");
    expect(readdirSync(d)).toEqual([]);
    await expect(installVersion(d, "0.2.1 --global", { run: fakeNpm() })).rejects.toThrow("invalid version");
  });
  it("passes a custom registry", async () => {
    const run = fakeNpm();
    await installVersion(dir(), "0.2.1", { run, registry: "http://127.0.0.1:9" });
    expect(run.calls[0]).toContain("http://127.0.0.1:9");
  });
});

describe("parseRegistry", () => {
  it("takes https, plain http only on loopback, and refuses anything that could reach a shell", () => {
    expect(parseRegistry(undefined)).toBeUndefined();
    expect(parseRegistry("https://npm.example.com/repo/")).toBe("https://npm.example.com/repo");
    expect(parseRegistry("http://127.0.0.1:41739")).toBe("http://127.0.0.1:41739");
    expect(parseRegistry("http://localhost:4873")).toBe("http://localhost:4873");
    expect(parseRegistry("http://[::1]:4873")).toBe("http://[::1]:4873");
    for (const bad of ["http://npm.example.com", "ftp://x", "https://x/a b", 'https://x/"&calc', "https://x/%PATH%", "not a url"]) expect(() => parseRegistry(bad)).toThrow("CLAUDE_UI_UPDATE_REGISTRY");
  });
});

describe("versions dir", () => {
  it("lists complete installs newest first; prune removes only versions older than the previous one", async () => {
    const d = dir();
    for (const v of ["0.1.0", "0.2.0", "0.2.1", "0.10.0"]) await installVersion(d, v, { run: fakeNpm(v) });
    mkdirSync(join(d, "0.3.0.partial"));
    mkdirSync(join(d, "0.4.0"));
    expect(installedVersions(d)).toEqual(["0.10.0", "0.2.1", "0.2.0", "0.1.0"]);
    writeFileSync(join(d, "notes.txt"), "");
    pruneVersions(d, "0.2.1");
    // Kept: current, previous, newer ones, a .partial install (maybe another daemon's) and other names.
    expect(readdirSync(d).sort()).toEqual(["0.10.0", "0.2.0", "0.2.1", "0.3.0.partial", "0.4.0", "notes.txt"]);
    pruneVersions(d, "0.1.0");
    expect(readdirSync(d)).toHaveLength(6);
    expect(installedVersions(join(d, "missing"))).toEqual([]);
  });
});

describe("createUpdater", () => {
  const setup = (busy = { sessions: 0, terminals: 0 }, run: Runner = fakeNpm()) => {
    const sent: unknown[] = [];
    const exit = vi.fn();
    const u = createUpdater({ current: "0.2.0", dir: dir(), fetch: answer({ version: "0.2.1" }), run, busy: () => busy, exit, broadcast: (m) => sent.push(m), pollMs: 100 });
    return { u, sent, exit, busy };
  };

  it("announces a newer version once and tells new connections", async () => {
    const { u, sent } = setup();
    await u.check();
    await u.check();
    expect(sent).toEqual([{ type: "update_available", version: "0.2.1", current: "0.2.0" }]);
    expect(u.messages()).toEqual([{ type: "update_available", version: "0.2.1", current: "0.2.0" }]);
  });

  it("installs, then restarts at once when nothing runs", async () => {
    const { u, sent, exit } = setup();
    await u.check();
    expect(await u.install()).toBe("0.2.1");
    expect(sent).toContainEqual({ type: "update_state", phase: "installing" });
    expect(u.restart()).toBe(0);
    expect(sent.at(-1)).toEqual({ type: "update_state", phase: "restarting" });
    expect(exit).toHaveBeenCalledWith(RESTART_CODE);
  });

  it("waits for a running turn; now: true exits at once", async () => {
    vi.useFakeTimers();
    const { u, sent, exit, busy } = setup({ sessions: 1, terminals: 2 });
    await u.check();
    await u.install();
    expect(u.restart()).toBe(1);
    expect(sent.at(-1)).toEqual({ type: "update_state", phase: "waiting", waitingFor: 1, terminals: 2 });
    expect(u.messages().at(-1)).toEqual({ type: "update_state", phase: "waiting", waitingFor: 1, terminals: 2 });
    vi.advanceTimersByTime(1000);
    expect(exit).not.toHaveBeenCalled();
    busy.sessions = 0;
    vi.advanceTimersByTime(5000);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(exit).toHaveBeenCalledWith(RESTART_CODE);

    const b = setup({ sessions: 3, terminals: 0 });
    await b.u.check();
    await b.u.install();
    b.u.restart();
    expect(b.exit).not.toHaveBeenCalled();
    b.u.restart(true);
    expect(b.exit).toHaveBeenCalledWith(RESTART_CODE);
  });

  it("waits 5 s after the last busy session went idle; a session busy again in that time starts the grace period over", async () => {
    vi.useFakeTimers();
    const { u, sent, exit, busy } = setup({ sessions: 1, terminals: 0 });
    await u.check();
    await u.install();
    u.restart();
    vi.advanceTimersByTime(100);
    busy.sessions = 0;
    vi.advanceTimersByTime(3000);
    // Claude starts a turn on a finished background task.
    busy.sessions = 1;
    vi.advanceTimersByTime(100);
    busy.sessions = 0;
    vi.advanceTimersByTime(4900);
    expect(exit).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: "update_state", phase: "waiting", waitingFor: 1 });
    vi.advanceTimersByTime(200);
    expect(exit).toHaveBeenCalledWith(RESTART_CODE);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("nothing busy but open terminals: waits for Restart now, naming the terminals", async () => {
    vi.useFakeTimers();
    const { u, sent, exit } = setup({ sessions: 0, terminals: 2 });
    await u.check();
    await u.install();
    expect(u.restart()).toBe(0);
    expect(sent.at(-1)).toEqual({ type: "update_state", phase: "waiting", waitingFor: 0, terminals: 2 });
    vi.advanceTimersByTime(60_000);
    expect(exit).not.toHaveBeenCalled();
    u.restart(true);
    expect(exit).toHaveBeenCalledWith(RESTART_CODE);
  });

  it("only terminals: closing one updates the notice; closing the last restarts", async () => {
    vi.useFakeTimers();
    const { u, sent, exit, busy } = setup({ sessions: 0, terminals: 2 });
    await u.check();
    await u.install();
    u.restart();
    busy.terminals = 1;
    vi.advanceTimersByTime(100);
    expect(sent.at(-1)).toEqual({ type: "update_state", phase: "waiting", waitingFor: 0, terminals: 1 });
    expect(exit).not.toHaveBeenCalled();
    busy.terminals = 0;
    vi.advanceTimersByTime(100);
    expect(exit).toHaveBeenCalledWith(RESTART_CODE);
  });

  it("an install failure rejects with npm's lines, keeps the daemon and announces the version again", async () => {
    const { u, sent, exit } = setup(undefined, async () => ({ code: 1, output: "npm ERR! EACCES" }));
    await u.check();
    await expect(u.install()).rejects.toThrow("npm ERR! EACCES");
    expect(sent.at(-1)).toEqual({ type: "update_available", version: "0.2.1", current: "0.2.0" });
    expect(() => u.restart()).toThrow("no update installed");
    expect(exit).not.toHaveBeenCalled();
  });

  it("refuses an install without an available version", async () => {
    const { u } = setup();
    await expect(u.install()).rejects.toThrow("no update available");
  });
});
