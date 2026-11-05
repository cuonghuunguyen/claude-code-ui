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
  stdout.write(JSON.stringify({ ready: true, schema: [1, 1], version: "1.0.0" }) + "\n");
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
/** A reconnect attach that finds no Hub (the setup says `no_daemon`). */
function noDaemon(): SideProcess {
  const stdout = new PassThrough();
  const exit = new EventEmitter();
  setTimeout(() => (stdout.write("CLAUDE_UI_SETUP no_daemon\n"), exit.emit("exit", 3)), 0);
  return { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => {}, on: (e, l) => exit.on(e, l) };
}
const readySideHolder = () => {
  let r: ReturnType<typeof readySide>;
  return { make: () => ((r = readySide()), r.proc), die: () => r.die() };
};
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

  it("an off side that needs an update keeps the reason the bundle was not used", async () => {
    vi.useFakeTimers();
    const s = createSides({ targets: [wslSide("A")], saved: [{ id: "wsl:A", key: "old" }], key: () => "k2", spawn: async (_id, o) => (o.install?.({ fallback: "musl" }), notInstalled()) });
    await tick(5);
    expect(state(s, "wsl:A")).toMatchObject({ state: "off", update: true, fallback: "musl" });
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

  it("a dropped pipe: reconnecting, then attach again with setup never after 2 s", async () => {
    vi.useFakeTimers();
    const { s, procs, modes } = mk();
    await s.start("wsl:A");
    procs[0]!.die();
    expect(state(s, "wsl:A")).toMatchObject({ state: "reconnecting" });
    await tick(1_999);
    expect(procs).toHaveLength(1);
    await tick(2);
    expect(procs).toHaveLength(2);
    expect(state(s, "wsl:A")?.state).toBe("ready");
    expect(modes).toEqual(["needed", "never"]);
    s.close();
  });

  it("no Hub left there (no_daemon): restarted after 2 s, 10 s, 60 s; the 4th time it stays off", async () => {
    vi.useFakeTimers();
    let n = 0;
    const first = readySideHolder();
    const s = createSides({ targets: [wslSide("A")], key: () => "k", spawn: async () => (n++ === 0 ? first.make() : noDaemon()) });
    await s.start("wsl:A");
    first.die();
    await tick(2_001);
    expect(n).toBe(2);
    expect(state(s, "wsl:A")?.state).toBe("starting");
    await tick(2_001);
    expect(n).toBe(3);
    await tick(9_999);
    expect(n).toBe(3);
    await tick(2);
    expect(n).toBe(4);
    await tick(60_001);
    expect(n).toBe(5);
    expect(state(s, "wsl:A")?.state).toBe("off");
    await tick(120_000);
    expect(n).toBe(5);
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

  it("switching start off while reconnecting leaves it reconnecting (not stuck starting)", async () => {
    vi.useFakeTimers();
    const { s, procs } = mk();
    await s.start("wsl:A");
    procs[0]!.die();
    s.prefs("wsl:A", { start: false });
    expect(state(s, "wsl:A")?.state).toBe("reconnecting");
    s.close();
  });
  it("close() while a start is failing: no retry timer is made", async () => {
    vi.useFakeTimers();
    const spawn = vi.fn(async () => failing());
    const s = createSides({ targets: [wslSide("A")], saved: [{ id: "wsl:A", key: "k" }], key: () => "k", spawn });
    // The first start is in flight when the hub closes: its failure makes no retry.
    s.close();
    await tick(60_000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

});

describe("Docker side", () => {
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
  stdout.write(JSON.stringify({ ready: true, schema: [1, 1], version: "1.0.0" }) + "\n");
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
    expect(state(s, "wsl:A")?.state).toBe("reconnecting");
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

  it("a list that differs only in lastActivity is not written again", async () => {
    const writes: unknown[] = [];
    const s = createSides({ targets: [wslSide("A")], saved: [{ id: "wsl:A", key: "k" }], key: () => "k", spawn: async () => readySide().proc, cache: { read: () => ({}), write: (c) => writes.push(c) } });
    s.remember("wsl:A", list);
    s.remember("wsl:A", { ...list, sessions: [{ ...list.sessions[0], lastActivity: 99 }] });
    expect(writes).toHaveLength(1);
    s.remember("wsl:A", { ...list, projects: ["/w/p", "/w/q"] });
    expect(writes).toHaveLength(2);
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
    expect(await h.ask({ type: "side.prefs", side: "local", start: false })).toMatchObject({ type: "error", code: "unknown_side" });
    expect(await h.ask({ type: "side.prefs", side: "wsl:A", start: "yes" })).toMatchObject({ type: "error", code: "bad_request" });
    expect(await h.ask({ type: "side.prefs", side: "wsl:A" })).toMatchObject({ type: "error", code: "bad_request" });
    expect(await h.ask({ type: "side.prefs", side: "wsl:A", start: true })).toMatchObject({ type: "reply", result: {} });
    expect(state(s, "wsl:A")).toMatchObject({ autoStart: true });
    s.close();
  });
});

/** A scripted pipe: `out(line)` is the Side's stdout; `frames` is what the Hub wrote to stdin; `exit(code)` ends it. */
function pipe() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const exit = new EventEmitter();
  const frames: any[] = [];
  const killed = vi.fn(() => queueMicrotask(() => exit.emit("exit", 0)));
  stdin.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => frames.push(JSON.parse(l))));
  const proc: SideProcess = { stdin, stdout, stderr: new PassThrough(), kill: killed, on: (e, l) => exit.on(e, l) };
  return { proc, frames, killed, out: (o: object | string) => stdout.write((typeof o === "string" ? o : JSON.stringify(o)) + "\n"), exit: (code = 0) => exit.emit("exit", code) };
}
const READY = { ready: true, schema: [1, 1], version: "2.0.0" };
const flush = () => vi.advanceTimersByTimeAsync(1);

describe("attach handshake (ADR 0009)", () => {
  it("every start writes the hello with the schema range first", async () => {
    vi.useFakeTimers();
    const p = pipe();
    p.out(READY);
    const s = createSides({ targets: [wslSide("A")], spawn: async () => p.proc });
    await s.start("wsl:A");
    expect(p.frames[0]).toEqual({ hello: { schema: [1, 1] } });
    s.close();
  });

  it.each([
    ["a schema range without overlap", { ready: true, schema: [2, 3], version: "9.0.0" }, [2, 3]],
    ["no schema at all (an older Hub)", { ready: true, version: "1.1.0" }, undefined],
  ])("ready with %s: error with both versions, pipe killed, no reconnect", async (_n, ready, remoteSchema) => {
    vi.useFakeTimers();
    const p = pipe();
    p.out(ready);
    const spawn = vi.fn(async () => p.proc);
    const s = createSides({ targets: [wslSide("A")], spawn });
    void s.start("wsl:A").catch(() => {});
    await tick(120_000);
    expect(p.killed).toHaveBeenCalled();
    const row = state(s, "wsl:A")!;
    expect(row.state).toBe("error");
    expect(row.mismatch).toMatchObject({ remote: (ready as any).version, localSchema: [1, 1], ...(remoteSchema && { remoteSchema }) });
    expect(typeof row.mismatch!.local).toBe("string");
    expect(row.mismatch!.remoteOlder).toBe(remoteSchema ? false : true);
    if (!remoteSchema) expect(row.mismatch!.remoteSchema).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
    s.close();
  });

  it("setup code hub_no_attach <version>: the same mismatch, remote older, no schema, no reconnect", async () => {
    vi.useFakeTimers();
    const spawn = vi.fn(async () => {
      const p = pipe();
      setTimeout(() => (p.out("CLAUDE_UI_SETUP hub_no_attach 1.1.0"), p.exit(3)), 0);
      return p.proc;
    });
    const s = createSides({ targets: [wslSide("A")], spawn });
    let rejected: Error | undefined;
    void s.start("wsl:A").catch((e: Error) => (rejected = e));
    await tick(120_000);
    expect(state(s, "wsl:A")).toMatchObject({ state: "error", mismatch: { remote: "1.1.0", remoteOlder: true } });
    // The start rejects with what the row says (both versions, the way out), never the setup code.
    expect(rejected!.message).toBe(state(s, "wsl:A")!.message);
    expect(rejected!.message).toContain("runs Claude UI 1.1.0");
    expect(rejected!.message).not.toContain("hub_no_attach");
    expect(state(s, "wsl:A")!.mismatch!.remoteSchema).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
    s.close();
  });
});

describe("pipe drop of every kind", () => {
  it.each([
    ["wsl:A", [wslSide("A")]],
    ["docker:dev", [dockerSide("dev")]],
  ])("%s: reconnecting, then attaches again with the bridge", async (id, targets) => {
    vi.useFakeTimers();
    const pipes: ReturnType<typeof pipe>[] = [];
    const s = createSides({ targets, key: () => "k", spawn: async () => (pipes.push(pipe()), pipes.at(-1)!.out(READY), pipes.at(-1)!.proc) });
    await s.start(id);
    pipes[0]!.exit(1);
    expect(state(s, id)?.state).toBe("reconnecting");
    await tick(2_100);
    expect(pipes).toHaveLength(2);
    expect(state(s, id)?.state).toBe("ready");
    s.close();
  });
});

describe("updateRemote", () => {
  const OLD = { ready: true, schema: [0, 0], version: "0.9.0" };
  /** A Side whose first attach is an older Hub; the update command ends with `updateCode`; the next attach is ready with the new Hub. */
  function mk(updateCode: number, updateOut = "", extra: object = {}) {
    const calls: { run?: string; attach?: boolean; setup: string }[] = [];
    const pipes: ReturnType<typeof pipe>[] = [];
    let attaches = 0;
    const spawn = async (_id: string, o: { run?: "update"; attach?: boolean; setup: string }) => {
      calls.push({ run: o.run, attach: o.attach, setup: o.setup });
      const p = pipe();
      pipes.push(p);
      if (o.run) setTimeout(() => (updateOut && p.out(updateOut), p.exit(updateCode)), 0);
      else p.out(attaches++ === 0 ? OLD : (extra as any).next ?? READY);
      return p.proc;
    };
    const s = createSides({ targets: [wslSide("A")], key: () => "k", spawn: spawn as never, reconnectMs: [100], ...extra });
    return { s, calls, pipes };
  }

  it("spawns run update, then attaches again with the bridge that starts a Hub, until ready", async () => {
    vi.useFakeTimers();
    const { s, calls } = mk(0);
    void s.start("wsl:A").catch(() => {});
    await tick(5);
    expect(state(s, "wsl:A")?.mismatch?.remoteOlder).toBe(true);
    const up = s.updateRemote("wsl:A");
    await tick(5);
    await up;
    expect(calls[1]).toMatchObject({ run: "update", setup: "needed" });
    expect(state(s, "wsl:A")).toMatchObject({ state: "starting", message: expect.stringContaining("updates") });
    await tick(500);
    expect(calls[2]).toMatchObject({ run: undefined, attach: undefined, setup: "never" });
    expect(state(s, "wsl:A")).toMatchObject({ state: "ready" });
    expect(state(s, "wsl:A")!.mismatch).toBeUndefined();
    s.close();
  });

  it("a mismatch while updating is retried, not final", async () => {
    vi.useFakeTimers();
    let n = 0;
    const calls: any[] = [];
    const spawn = async (_id: string, o: { run?: "update" }) => {
      calls.push(o.run);
      const p = pipe();
      if (o.run) setTimeout(() => p.exit(0), 0);
      else p.out(n++ < 2 ? OLD : READY); // attach 1 (initial) and 2 (after the update) are still the old Hub
      return p.proc;
    };
    const s = createSides({ targets: [wslSide("A")], key: () => "k", spawn: spawn as never, reconnectMs: [100] });
    void s.start("wsl:A").catch(() => {});
    await tick(5);
    void s.updateRemote("wsl:A");
    await tick(2_000);
    expect(state(s, "wsl:A")?.state).toBe("ready");
    expect(calls.filter((c) => !c)).toHaveLength(3);
    s.close();
  });

  it("a failing update command: error with its last output line, rejects", async () => {
    vi.useFakeTimers();
    const { s } = mk(1, "claude-ui: step one\nclaude-ui: no update available\n");
    void s.start("wsl:A").catch(() => {});
    await tick(5);
    const r = s.updateRemote("wsl:A");
    const caught = r.then(() => new Error("resolved"), (e: Error) => e);
    await tick(10);
    expect((await caught).message).toBe("no update available");
    expect(state(s, "wsl:A")).toMatchObject({ state: "error", message: expect.stringContaining("no update available") });
    s.close();
  });

  it("rejects 'nothing to update' without a mismatch of an older Hub", async () => {
    vi.useFakeTimers();
    const p = pipe();
    p.out(READY);
    const s = createSides({ targets: [wslSide("A")], spawn: async () => p.proc });
    await s.start("wsl:A");
    await expect(s.updateRemote("wsl:A")).rejects.toThrow("nothing to update");
    s.close();
  });
});

describe("side.updateRemote message", () => {
  it("unknown_side, bad_request (nothing to update), side_failed, and {} on success", async () => {
    const p = pipe();
    p.out(READY);
    const spawn = vi.fn(async (_id: string, o: { run?: string }) => {
      if (!o.run) return p.proc;
      const u = pipe();
      setTimeout(() => (u.out("claude-ui: boom"), u.exit(1)), 0);
      return u.proc;
    });
    const s = createSides({ targets: [wslSide("A")], spawn: spawn as never });
    await s.start("wsl:A");
    const h = hub(s);
    expect(await h.ask({ type: "side.updateRemote", side: "nope" })).toMatchObject({ type: "error", code: "unknown_side" });
    expect(await h.ask({ type: "side.updateRemote" })).toMatchObject({ type: "error", code: "unknown_side" });
    expect(await h.ask({ type: "side.updateRemote", side: "wsl:A" })).toMatchObject({ type: "error", code: "bad_request" });
    s.close();
  });

  it("an attach-started ready Side: failure is side_failed with the message; success is an empty reply", async () => {
    for (const code of [1, 0]) {
      const p = pipe();
      p.out({ ...READY, startedBy: "attach" });
      const spawn = async (_id: string, o: { run?: string }) => {
        if (!o.run) return p.proc;
        const u = pipe();
        setTimeout(() => (u.out("claude-ui: boom"), u.exit(code)), 0);
        return u.proc;
      };
      const s = createSides({ targets: [wslSide("A")], spawn: spawn as never, reconnectMs: [60_000] });
      await s.start("wsl:A");
      const r = await hub(s).ask({ type: "side.updateRemote", side: "wsl:A" });
      if (code) expect(r).toMatchObject({ type: "error", code: "side_failed", message: "boom" });
      else expect(r).toMatchObject({ type: "reply", result: {} });
      s.close();
    }
  });
});

describe("settings sync only to a Hub an attach started", () => {
  const settingsFrames = (p: ReturnType<typeof pipe>) => p.frames.filter((f) => f.m?.type === "settings.set");
  it.each([
    ["a user-started Hub: no settings", undefined, 0],
    ["a Hub started by attach: settings", "attach", 1],
  ])("%s", async (_n, startedBy, count) => {
    const p = pipe();
    p.out({ ...READY, ...(startedBy && { startedBy }) });
    const s = createSides({ targets: [wslSide("A")], spawn: async () => p.proc });
    const h = hub(s);
    await h.ask({ type: "side.start", side: "wsl:A" });
    await new Promise((r) => setTimeout(r, 50));
    expect(settingsFrames(p)).toHaveLength(count);
    expect(s.attachStarted("wsl:A")).toBe(!!startedBy);
    s.close();
  });
});
