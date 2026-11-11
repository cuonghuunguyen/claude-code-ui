// GH-548 / ADR 0009: a Side survives its pipe. The Side registry talks to an in-process attach server through the attach seam;
// a dropped pipe is a destroyed stream pair. Fake timers, no ssh.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSides, type SideProcess } from "../src/sides.ts";
import { sideTarget } from "../src/side-kinds.ts";
import { daemon, hub, noDaemon, pipe } from "./ssh-side-harness.ts";

const MIN = 60_000;
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("attach server: the Grace period", () => {
  it("does not count while a Hub is attached or a turn runs; counts while a turn waits on a prompt; at expiry stops idle turns and exits", async () => {
    const { d, st } = daemon({ graceMs: 30 * MIN, startedBy: "attach" });
    const p = pipe(d, [1, 1]);
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(st.exited).toBe(0); // attached: held at 0
    p.drop();
    st.busy = true; // a running turn pauses the count
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(st.exited).toBe(0);
    st.busy = false; // the turn now waits on a prompt (idle) or ended
    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(st.exited).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(st.stopped).toBe(1);
    expect(st.exited).toBe(1);
    d.close();
  });

  it("the Grace period restarts from full when a long unattended turn ends", async () => {
    const { d, st } = daemon({ graceMs: 30 * MIN, startedBy: "attach" });
    pipe(d, [1, 1]).drop();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    st.busy = true; // a turn starts while unattended
    await vi.advanceTimersByTimeAsync(60 * MIN);
    st.busy = false; // it lands: not 10 min left but the full 30
    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(st.exited).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(st.exited).toBe(1);
    d.close();
  });

  it("a Hub that attaches within the Grace period starts the count over", async () => {
    const { d, st } = daemon({ graceMs: 30 * MIN, startedBy: "attach" });
    pipe(d, [1, 1]).drop();
    await vi.advanceTimersByTimeAsync(29 * MIN);
    const p = pipe(d, [1, 1]);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    p.drop();
    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(st.exited).toBe(0);
    d.close();
  });

  it("the Hub sets the Grace period on attach ({grace: ms})", async () => {
    const { d, st } = daemon({ graceMs: 30 * MIN, startedBy: "attach" });
    const p = pipe(d, [1, 1]);
    p.stdin.write('{"grace":120000}\n');
    await vi.advanceTimersByTimeAsync(10);
    p.drop();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(st.exited).toBe(1);
    d.close();
  });

  it("Grace counts only with no pipe, no browser, no turn; a Hub the user started never exits", async () => {
    const { d, st } = daemon({ graceMs: 10 * MIN, startedBy: "attach" });
    st.browsers = 1;
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(st.exited).toBe(0); // a browser holds it
    st.browsers = 0;
    await vi.advanceTimersByTimeAsync(11 * MIN);
    expect(st.exited).toBe(1);
    d.close();
    const user = daemon({ graceMs: MIN });
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(user.st.exited).toBe(0);
    user.d.close();
  });

  it("two pipes attach at once: both get pushes and running; one dropping leaves the other", async () => {
    const { d, st } = daemon({ graceMs: MIN, startedBy: "attach" });
    const a = pipe(d, [1, 1]);
    const b = pipe(d, [1, 1]);
    await vi.advanceTimersByTimeAsync(10);
    d.push({ sessionId: "s", title: "t", body: "b" });
    d.running(true);
    for (const p of [a, b]) {
      const out = p.received.join("");
      expect(out).toContain('"push"');
      expect(out).toContain('{"running":true}');
    }
    a.drop();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(st.exited).toBe(0); // b is still attached
    b.drop();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(st.exited).toBe(1);
    d.close();
  });

  it("a hello with a schema range that does not overlap gets one ready frame, then the pipe ends", async () => {
    const { d } = daemon({ startedBy: "attach" });
    const p = pipe(d, [2, 2]);
    await vi.advanceTimersByTimeAsync(10);
    expect(p.received.join("").trim().split("\n")).toEqual([expect.stringContaining('"schema":[1,1]')]);
    expect((p.stdout as unknown as PassThrough).writableEnded).toBe(true);
    d.close();
  });

  it("heartbeats both ways every 15 s; 3 missed frames from the Hub end the pipe", async () => {
    const { d, st } = daemon({ heartbeatMs: 15_000 });
    const p = pipe(d, [1, 1]);
    p.stdin.write('{"c":1,"o":1}\n');
    const out: string[] = [];
    p.stdout.on("data", (b) => out.push(String(b)));
    await vi.advanceTimersByTimeAsync(15_000);
    p.stdin.write('{"hb":1}\n');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(out.join("").match(/"hb":1/g)?.length).toBe(2);
    expect(st.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(st.closed).toBe(1); // silence: the connections of the dead pipe closed
    d.close();
  });
});

describe("Side registry: an SSH Side survives the pipe", () => {
  it("a dropped pipe shows reconnecting within ~45 s, the Daemon keeps running, attach brings it back", async () => {
    const { d, st } = daemon();
    const h = hub(d);
    await h.sides.start("ssh:box");
    await vi.advanceTimersByTimeAsync(5);
    expect(h.state()).toBe("ready");
    h.pipes[0]!.drop();
    expect(h.state()).toBe("reconnecting");
    expect(st.exited).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000 + 10);
    expect(h.state()).toBe("ready");
    expect(h.spawned.map((s) => !!s.attach)).toEqual([false, true]); // the first start launches, the reattach only attaches
    h.sides.close();
  });

  it("a silent pipe (3 missed heartbeats, 45 s) ends the ssh and the Side goes reconnecting; a live one is pinged every 15 s", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const exit = new EventEmitter();
    const sent: string[] = [];
    stdin.on("data", (b) => sent.push(String(b)));
    let killed = 0;
    const silent: SideProcess = { stdin, stdout, stderr: new PassThrough(), kill: () => (killed++, exit.emit("exit", 255)), on: (e, l) => exit.on(e, l) };
    stdout.write('{"ready":true,"killTree":true,"hb":true,"schema":[1,1],"version":"1.1.0"}\n');
    const sides = createSides({ targets: [sideTarget("ssh", "box")], spawn: () => silent, reconnectMs: [60_000] });
    await sides.start("ssh:box");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent.join("").match(/"hb":1/g)?.length).toBe(2);
    expect(killed).toBe(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(killed).toBe(1);
    expect(sides.list()[1]!.state).toBe("reconnecting");
    sides.close();
  });

  it("the Grace period set in Settings is sent on attach and when it changes", async () => {
    const { d } = daemon();
    const saved: Record<string, number>[] = [];
    const h = hub(d, { grace: { read: () => ({ "ssh:box": 45 }), write: (g) => void saved.push(g) } });
    await h.sides.start("ssh:box");
    await vi.advanceTimersByTimeAsync(5);
    expect(h.pipes[0]!.sent.join("")).toContain(`"grace":${45 * MIN}`);
    expect(h.sides.list().find((s) => s.id === "ssh:box")!.graceMinutes).toBe(45);
    h.sides.prefs("ssh:box", { graceMinutes: 10 });
    expect(saved.at(-1)).toEqual({ "ssh:box": 10 });
    expect(h.pipes[0]!.sent.join("")).toContain(`"grace":${10 * MIN}`);
    h.sides.close();
  });

  it("an attach that finds no Daemon ends in off with the way back; opening the host starts a fresh one", async () => {
    const { d } = daemon();
    const first = pipe(d);
    const queue: (() => SideProcess)[] = [() => first, noDaemon, () => pipe(d)];
    const calls: { attach?: boolean }[] = [];
    const sides = createSides({ targets: [sideTarget("ssh", "box")], spawn: (_id, o) => (calls.push(o), queue.shift()!()) });
    const row = () => sides.list()[1]!;
    await sides.start("ssh:box");
    await vi.advanceTimersByTimeAsync(5);
    first.drop();
    expect(row().state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(2_000 + 10); // the attach finds no Daemon
    expect(row()).toMatchObject({ state: "off", message: expect.stringContaining("Open it again") });
    await vi.advanceTimersByTimeAsync(10 * MIN); // no more tries
    expect(calls.length).toBe(2);
    await sides.start("ssh:box"); // the user opens the host: a fresh launch (not attach-only)
    await vi.advanceTimersByTimeAsync(5);
    expect(row().state).toBe("ready");
    expect(calls.map((c) => !!c.attach)).toEqual([false, true, false]);
    sides.close();
  });

  it("a host that stays unreachable stops being tried once the Grace period must have run out", async () => {
    const { d } = daemon();
    const first = pipe(d);
    const unreachable = (): SideProcess => {
      const exit = new EventEmitter();
      const stderr = new PassThrough();
      setTimeout(() => (stderr.write("ssh: connect to host box port 22: Connection refused"), exit.emit("exit", 255)), 1);
      return { stdin: new PassThrough(), stdout: new PassThrough(), stderr, kill: () => {}, on: (e, l) => exit.on(e, l) };
    };
    let n = 0;
    const sides = createSides({ targets: [sideTarget("ssh", "box")], spawn: () => (n++ === 0 ? first : unreachable()), grace: { read: () => ({ "ssh:box": 1 }), write: () => {} } });
    await sides.start("ssh:box");
    await vi.advanceTimersByTimeAsync(5);
    first.drop();
    await vi.advanceTimersByTimeAsync(10 * 1000);
    expect(sides.list()[1]!.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(3 * MIN); // Grace (1 min) + 1 min margin
    expect(sides.list()[1]!.state).toBe("error");
    const tries = n;
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(n).toBe(tries);
    sides.close();
  });

});
