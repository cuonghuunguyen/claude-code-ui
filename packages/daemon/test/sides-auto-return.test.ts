// GH-458: saved sides come back with the hub: auto update (bundle only), restart after an exit, retry, poll, prefs, cached lists.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@claude-ui/protocol";
import { createRouter, createSides, dockerSide, effectiveSetup, parseSaved, wslSide, type SavedSide, type SideProcess } from "../src/sides.ts";

/** A side that is ready at once and dies when `die()` runs. */
function readySide() {
  const stdout = new PassThrough();
  const exit = new EventEmitter();
  stdout.write(JSON.stringify({ ready: true }) + "\n");
  const proc: SideProcess = { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => {}, on: (e, l) => exit.on(e, l) };
  return { proc, die: (code = 1) => exit.emit("exit", code) };
}
/** A side whose setup script says `not_installed`. */
function notInstalled(): SideProcess {
  const stdout = new PassThrough();
  const exit = new EventEmitter();
  setTimeout(() => (stdout.write("CLAUDE_UI_SETUP not_installed\n"), exit.emit("exit", 3)), 0);
  return { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => {}, on: (e, l) => exit.on(e, l) };
}
/** A side that fails to start (exit code 1, no frame). */
function failing(): SideProcess {
  const exit = new EventEmitter();
  setTimeout(() => exit.emit("exit", 1), 0);
  return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {}, on: (e, l) => exit.on(e, l) };
}

const state = (s: ReturnType<typeof createSides>, id: string) => s.list().find((x) => x.id === id);
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

afterEach(() => vi.useRealTimers());

describe("parseSaved", () => {
  it("reads a legacy array, a v2 object and garbage", () => {
    expect(parseSaved(["wsl:A", 3, "docker:b"])).toEqual([{ id: "wsl:A" }, { id: "docker:b" }]);
    expect(parseSaved({ sides: [{ id: "wsl:A", key: "k", update: false }, { id: 5 }, { id: "docker:b", update: true }, null] })).toEqual([{ id: "wsl:A", key: "k", update: false }, { id: "docker:b", key: undefined }]);
    expect(parseSaved("x")).toEqual([]);
    expect(parseSaved(undefined)).toEqual([]);
  });
});

describe("effectiveSetup", () => {
  it("a bundle-only start without a usable bundle runs with never (no npm); otherwise the setup is kept", () => {
    expect(effectiveSetup("needed", true, false)).toBe("never");
    expect(effectiveSetup("needed", true, true)).toBe("needed");
    expect(effectiveSetup("needed", undefined, false)).toBe("needed");
    expect(effectiveSetup("force", false, false)).toBe("force");
  });
});

describe("auto start of a saved side", () => {
  const modes = async (saved: SavedSide[], key = "k2") => {
    const seen: { setup: string; bundleOnly?: boolean }[] = [];
    createSides({ targets: [wslSide("A")], saved, key: () => key, spawn: async (_id, o) => (seen.push({ setup: o.setup, bundleOnly: o.bundleOnly }), readySide().proc) });
    await Promise.resolve();
    return seen;
  };

  it("a legacy entry without a key starts once with the bundle only", async () => {
    expect(await modes(parseSaved(["wsl:A"]))).toEqual([{ setup: "needed", bundleOnly: true }]);
  });
  it("the current key starts with setup never", async () => {
    expect(await modes([{ id: "wsl:A", key: "k2" }])).toEqual([{ setup: "never", bundleOnly: undefined }]);
  });
  it("another key and update on: needed + bundleOnly", async () => {
    expect(await modes([{ id: "wsl:A", key: "old" }])).toEqual([{ setup: "needed", bundleOnly: true }]);
  });
  it("another key and update off: never", async () => {
    expect(await modes([{ id: "wsl:A", key: "old", update: false }])).toEqual([{ setup: "never", bundleOnly: undefined }]);
  });

  it("a start that ends not_installed: off, update true, no retry", async () => {
    vi.useFakeTimers();
    const spawn = vi.fn(async () => notInstalled());
    const s = createSides({ targets: [wslSide("A")], saved: [{ id: "wsl:A", key: "old" }], key: () => "k2", spawn, retryMs: 30_000 });
    await tick(5);
    expect(state(s, "wsl:A")).toMatchObject({ state: "off", update: true, autoStart: true });
    await tick(60_000);
    expect(spawn).toHaveBeenCalledTimes(1);
    s.close();
  });

  it("ready saves the current key", async () => {
    const saves: SavedSide[][] = [];
    const s = createSides({ targets: [wslSide("A")], key: () => "k2", spawn: async () => readySide().proc, save: (x) => saves.push(x) });
    await s.start("wsl:A");
    expect(saves.at(-1)).toEqual([{ id: "wsl:A", key: "k2" }]);
    s.close();
  });

  it("a failed auto start retries once after 30 s, then stays error", async () => {
    vi.useFakeTimers();
    const spawn = vi.fn(async () => failing());
    const s = createSides({ targets: [wslSide("A")], saved: [{ id: "wsl:A", key: "k" }], key: () => "k", spawn });
    await tick(5);
    expect(state(s, "wsl:A")?.state).toBe("error");
    expect(spawn).toHaveBeenCalledTimes(1);
    await tick(30_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    await tick(120_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(state(s, "wsl:A")?.state).toBe("error");
    s.close();
  });
});

describe("restart after an exit", () => {
  const mk = (extra: object = {}) => {
    const procs: ReturnType<typeof readySide>[] = [];
    const modes: string[] = [];
    const s = createSides({ targets: [wslSide("A")], key: () => "k", spawn: async (_id, o) => (modes.push(o.setup), procs.push(readySide()), procs.at(-1)!.proc), ...extra });
    return { s, procs, modes };
  };

  it("starting, restarted after 2 s, then 10 s, then 60 s; the 4th exit in 10 min is an error with Retry", async () => {
    vi.useFakeTimers();
    const { s, procs, modes } = mk();
    await s.start("wsl:A");
    procs[0]!.die();
    expect(state(s, "wsl:A")).toMatchObject({ state: "starting" });
    await tick(1_999);
    expect(procs).toHaveLength(1);
    await tick(2);
    expect(procs).toHaveLength(2);
    expect(state(s, "wsl:A")?.state).toBe("ready");
    expect(modes).toEqual(["needed", "never"]);
    procs[1]!.die();
    await tick(9_999);
    expect(procs).toHaveLength(2);
    await tick(2);
    expect(procs).toHaveLength(3);
    procs[2]!.die();
    await tick(59_999);
    expect(procs).toHaveLength(3);
    await tick(2);
    expect(procs).toHaveLength(4);
    procs[3]!.die();
    expect(state(s, "wsl:A")).toMatchObject({ state: "error", message: expect.stringContaining("Retry") });
    await tick(120_000);
    expect(procs).toHaveLength(4);
    s.close();
  });

  it("exits spread over more than 10 min reset the count", async () => {
    vi.useFakeTimers();
    const { s, procs } = mk({ restartMs: [10] });
    await s.start("wsl:A");
    for (let i = 0; i < 3; i++) {
      procs.at(-1)!.die();
      expect(state(s, "wsl:A")?.state).toBe("starting");
      await tick(11);
      expect(state(s, "wsl:A")?.state).toBe("ready");
      await tick(601_000);
    }
    s.close();
  });

  it("a manual start during the backoff cancels the timer", async () => {
    vi.useFakeTimers();
    const { s, procs } = mk();
    await s.start("wsl:A");
    procs[0]!.die();
    await s.start("wsl:A");
    expect(procs).toHaveLength(2);
    await tick(70_000);
    expect(procs).toHaveLength(2);
    s.close();
  });

  it("close() ends the timers: no restart", async () => {
    vi.useFakeTimers();
    const { s, procs } = mk();
    await s.start("wsl:A");
    procs[0]!.die();
    s.close();
    await tick(70_000);
    expect(procs).toHaveLength(1);
  });

  it("a side switched off is not restarted", async () => {
    vi.useFakeTimers();
    const { s, procs } = mk();
    await s.start("wsl:A");
    s.prefs("wsl:A", { start: false });
    procs[0]!.die();
    expect(state(s, "wsl:A")?.state).toBe("error");
    await tick(70_000);
    expect(procs).toHaveLength(1);
    s.close();
  });
});

describe("Docker side", () => {
  it("exits and its container is not listed: off, no restart; listed again: auto start", async () => {
    vi.useFakeTimers();
    let listed = [dockerSide("dev")];
    const procs: ReturnType<typeof readySide>[] = [];
    const s = createSides({ targets: [], discoverMs: 0, saved: [{ id: "docker:dev", key: "k" }], key: () => "k", discover: async () => listed, spawn: async () => (procs.push(readySide()), procs.at(-1)!.proc) });
    await s.refresh();
    await tick(5);
    expect(state(s, "docker:dev")?.state).toBe("ready");
    listed = [];
    procs[0]!.die();
    await tick(2_100);
    expect(procs).toHaveLength(1);
    expect(state(s, "docker:dev")?.state).not.toBe("ready");
    listed = [dockerSide("dev")];
    await s.refresh();
    await tick(5);
    expect(procs).toHaveLength(2);
    expect(state(s, "docker:dev")?.state).toBe("ready");
    s.close();
  });

  it("polls every 30 s while a saved Docker side is not ready; stops when ready and on close()", async () => {
    vi.useFakeTimers();
    const discover = vi.fn(async () => [] as ReturnType<typeof dockerSide>[]);
    const s = createSides({ targets: [], discoverMs: 0, saved: [{ id: "docker:dev", key: "k" }], key: () => "k", discover, spawn: async () => readySide().proc });
    await tick(30_000);
    expect(discover).toHaveBeenCalledTimes(1);
    await tick(30_000);
    expect(discover).toHaveBeenCalledTimes(2);
    discover.mockImplementation(async () => [dockerSide("dev")]);
    await tick(30_000);
    expect(state(s, "docker:dev")?.state).toBe("ready");
    const n = discover.mock.calls.length;
    await tick(90_000);
    expect(discover).toHaveBeenCalledTimes(n);
    s.close();
  });

  it("a saved container that is not listed is a missing row", () => {
    const s = createSides({ targets: [wslSide("A")], saved: [{ id: "docker:dev" }], spawn: async () => readySide().proc, discover: async () => [] });
    expect(state(s, "docker:dev")).toEqual({ id: "docker:dev", label: "Docker: dev", state: "off", missing: true, autoStart: true });
    s.close();
  });
});

describe("side.prefs", () => {
  it("start off removes the entry and leaves a running side running; on adds it without starting; update off is stored", async () => {
    const saves: SavedSide[][] = [];
    const procs: ReturnType<typeof readySide>[] = [];
    const s = createSides({ targets: [wslSide("A")], key: () => "k", spawn: async () => (procs.push(readySide()), procs[0]!.proc), save: (x) => saves.push(x) });
    await s.start("wsl:A");
    expect(s.prefs("wsl:A", { start: false })).toBe(true);
    expect(saves.at(-1)).toEqual([]);
    expect(state(s, "wsl:A")).toEqual({ id: "wsl:A", label: "WSL: A", state: "ready" });
    s.prefs("wsl:A", { start: true });
    expect(saves.at(-1)).toEqual([{ id: "wsl:A" }]);
    expect(procs).toHaveLength(1);
    s.prefs("wsl:A", { update: false });
    expect(saves.at(-1)).toEqual([{ id: "wsl:A", update: false }]);
    expect(state(s, "wsl:A")).toMatchObject({ autoStart: true, autoUpdate: false });
    s.prefs("wsl:A", { update: true });
    expect(saves.at(-1)).toEqual([{ id: "wsl:A" }]);
    expect(s.prefs("wsl:Nope", { start: true })).toBe(false);
    s.close();
  });

  it("turning start on does not start a listed Docker side before the next hub start", async () => {
    vi.useFakeTimers();
    const spawn = vi.fn(async () => readySide().proc);
    const s = createSides({ targets: [], discoverMs: 0, discover: async () => [dockerSide("dev")], spawn });
    await s.refresh();
    s.prefs("docker:dev", { start: true });
    await s.refresh();
    await tick(5);
    expect(spawn).not.toHaveBeenCalled();
    s.close();
  });
});

/** Router harness: local daemon with no sessions. */
function hub(sides: ReturnType<typeof createSides>) {
  const sent: ServerMessage[] = [];
  const router = createRouter({
    sides,
    send: (m) => void sent.push(m),
    local: async () => {},
    localCall: async (m) => ({ type: "reply", reqId: m.reqId, result: { sessions: [], projects: [], recentProjects: [] } }),
    isLocalSession: async () => false,
  });
  const ask = async (msg: object) => {
    const reqId = `r${sent.length}`;
    await router.handle({ ...msg, reqId } as ClientMessage & Record<string, unknown>);
    return sent.filter((m) => "reqId" in m && m.reqId === reqId).at(-1) as any;
  };
  return { router, sent, ask };
}

/** A side that answers session.list with `list` (and nothing else). */
function listingSide(list: object) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const exit = new EventEmitter();
  stdin.on("data", (d) => {
    for (const line of String(d).split("\n").filter(Boolean)) {
      const f = JSON.parse(line);
      if (f.m?.type === "session.list") stdout.write(JSON.stringify({ c: f.c, m: { type: "reply", reqId: f.m.reqId, result: list } }) + "\n");
    }
  });
  stdout.write(JSON.stringify({ ready: true }) + "\n");
  return { proc: { stdin, stdout, stderr: new PassThrough(), kill: () => {}, on: (e: "exit", l: (c: number | null) => void) => exit.on(e, l) } as SideProcess, die: () => exit.emit("exit", 1) };
}

describe("cached lists of saved sides", () => {
  const list = { sessions: [{ id: "s1", cwd: "/w/p", lastActivity: 5, title: "t", archived: false, transcript: true }], projects: ["/w/p"], recentProjects: [{ cwd: "/w/p", lastActivity: 5 }] };

  it("a starting side keeps its projects and sessions (live false); its cwd belongs to the side; a subscribe gets side_not_ready", async () => {
    const side = listingSide(list);
    const writes: object[] = [];
    let spawns = 0;
    const s = createSides({ targets: [wslSide("A")], key: () => "k", restartMs: [60_000], posixLocal: true, localDirs: [], spawn: async () => (spawns++ ? new Promise<SideProcess>(() => {}) : side.proc), cache: { read: () => ({}), write: (c) => writes.push(c) } });
    await s.start("wsl:A");
    const h = hub(s);
    await vi.waitFor(async () => expect((await h.ask({ type: "session.list" })).result.sessions).toHaveLength(1));
    expect(writes).toHaveLength(1);
    side.die();
    expect(state(s, "wsl:A")?.state).toBe("starting");
    const r = await h.ask({ type: "session.list" });
    expect(r.result.projects).toEqual(["/w/p"]);
    expect(r.result.sessions).toEqual([expect.objectContaining({ id: "s1", live: false, state: "idle" })]);
    expect(r.result.cwdSides["/w/p"]).toBe("wsl:A");
    // Unchanged list: not written again.
    expect(writes).toHaveLength(1);
    const sub = await h.ask({ type: "session.subscribe", sessionId: "s1", sinceSeq: 0 });
    expect(sub).toMatchObject({ type: "error", code: "side_not_ready" });
    s.close();
  });

  it("the cache read at start serves a saved side that has not started; a side switched off loses it", async () => {
    const s = createSides({ targets: [wslSide("A")], saved: [{ id: "wsl:A", key: "k" }], key: () => "k", posixLocal: true, localDirs: [], spawn: () => new Promise<SideProcess>(() => {}), cache: { read: () => ({ "wsl:A": list, "wsl:Gone": list }), write: () => {} } });
    const h = hub(s);
    expect((await h.ask({ type: "session.list" })).result.projects).toEqual(["/w/p"]);
    s.prefs("wsl:A", { start: false });
    expect((await h.ask({ type: "session.list" })).result.projects).toEqual([]);
    s.close();
  });

  it("side.prefs: unknown side, bad values and the reply", async () => {
    const s = createSides({ targets: [wslSide("A")], spawn: async () => readySide().proc });
    const h = hub(s);
    expect(await h.ask({ type: "side.prefs", side: "wsl:Nope", start: true })).toMatchObject({ type: "error", code: "unknown_side" });
    expect(await h.ask({ type: "side.prefs", side: "wsl:A", start: "yes" })).toMatchObject({ type: "error", code: "bad_request" });
    expect(await h.ask({ type: "side.prefs", side: "wsl:A" })).toMatchObject({ type: "error", code: "bad_request" });
    expect(await h.ask({ type: "side.prefs", side: "wsl:A", start: true })).toMatchObject({ type: "reply", result: {} });
    expect(state(s, "wsl:A")).toMatchObject({ autoStart: true });
    s.close();
  });
});
