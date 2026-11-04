// GH-549 / ADR 0007: Hub restart reattach, takeover and updates of an SSH Side. In-process Side Daemons through the attach seam, fake timers, no ssh.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeKey } from "../src/side-bundle.ts";
import { createSides, isNewerBuild } from "../src/sides.ts";
import { sideTarget } from "../src/side-kinds.ts";
import { daemon, hub, noDaemon, pipe } from "./ssh-side-harness.ts";

const MIN = 60_000;
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A store for `side-attached.json`. */
const store = (ids?: string[]) => {
  const st = { ids, writes: 0 };
  return { st, attached: { read: () => st.ids, write: (x: string[]) => ((st.ids = x), st.writes++) } };
};
const row = (h: ReturnType<typeof hub>) => h.sides.list().find((s) => s.id === "ssh:box")!;

describe("Hub restart", () => {
  it("while a turn runs: the new Hub attaches at start and its connection reaches the same Daemon", async () => {
    const { d, st } = daemon();
    const s = store();
    const a = hub(d, { attached: s.attached });
    await a.sides.start("ssh:box");
    await vi.advanceTimersByTimeAsync(5);
    st.busy = true;
    expect(s.st.ids).toEqual(["ssh:box"]);
    a.sides.close(); // the Hub stops: it stays in the attached set
    expect(s.st.ids).toEqual(["ssh:box"]);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(st.exited).toBe(0);
    const b = hub(d, { attached: s.attached });
    await vi.advanceTimersByTimeAsync(50);
    expect(b.spawned).toEqual([expect.objectContaining({ attach: true, setup: "never" })]);
    expect(row(b).state).toBe("ready");
    b.sides.open("ssh:box", () => {});
    await vi.advanceTimersByTimeAsync(5);
    expect(st.opened).toBe(1);
    b.sides.close();
    d.close();
  });

  it("a host not attached at shutdown is not contacted at Hub start, also when saved with Start with Claude UI off elsewhere", async () => {
    const { d } = daemon();
    const h = hub(d, { attached: store([]).attached });
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(h.spawned).toEqual([]);
    expect(row(h).state).toBe("off");
    h.sides.close();
    d.close();
  });

  it("Start with Claude UI on (saved): the Hub connects at start and starts a Daemon when none runs (launch, not attach-only)", async () => {
    const { d } = daemon({ build: safeKey("k") });
    const h = hub(d, { attached: store([]).attached, saved: [{ id: "ssh:box", key: "k" }], key: () => "k" });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.spawned).toEqual([expect.objectContaining({ setup: "never" })]);
    expect(h.spawned[0]!.attach).toBeUndefined();
    expect(row(h).state).toBe("ready");
    h.sides.close();
    d.close();
  });

  it("an attached host whose Daemon exited stays off and is forgotten", async () => {
    const { d } = daemon();
    const s = store(["ssh:box"]);
    const h = hub(d, { attached: s.attached, next: noDaemon } as never);
    await vi.advanceTimersByTimeAsync(50);
    expect(row(h)).toMatchObject({ state: "off", message: expect.stringContaining("Open the host again") });
    expect(s.st.ids).toEqual([]);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(h.spawned.length).toBe(1);
    h.sides.close();
    d.close();
  });

  it("an unreachable host at start stays attached: the next Hub start tries it again", async () => {
    const { d } = daemon();
    const s = store(["ssh:box"]);
    const h = hub(d, { attached: s.attached, next: () => Promise.reject(new Error("ssh: Connection refused")) as never } as never);
    await vi.advanceTimersByTimeAsync(50);
    expect(row(h).state).toBe("error");
    expect(s.st.ids).toEqual(["ssh:box"]);
    h.sides.close();
    d.close();
  });

  it("a missing store (first run after the upgrade) is seeded with the saved SSH Sides", async () => {
    const { d } = daemon({ build: safeKey("k") });
    const h = hub(d, { attached: store(undefined).attached, saved: [{ id: "ssh:box", key: "k" }], key: () => "k" });
    await vi.advanceTimersByTimeAsync(50);
    expect(row(h).state).toBe("ready");
    h.sides.close();
    d.close();
  });
});

describe("two Hubs", () => {
  it("the second takes over: the first shows taken over, never attaches again, the Daemon stays", async () => {
    const { d, st } = daemon();
    const sa = store();
    const a = hub(d, { attached: sa.attached });
    const b = hub(d, { attached: store().attached });
    await a.sides.start("ssh:box");
    await vi.advanceTimersByTimeAsync(5);
    await b.sides.start("ssh:box");
    await vi.advanceTimersByTimeAsync(5);
    expect(a.pipes[0]!.received.join("")).toContain('{"taken":1}');
    expect(row(a)).toMatchObject({ state: "off", message: expect.stringMatching(/taken over by another Claude UI/) });
    expect(row(b).state).toBe("ready");
    expect(sa.st.ids).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(a.spawned.length).toBe(1);
    expect(st.exited).toBe(0);
    expect(row(a).state).toBe("off");
    a.sides.close();
    b.sides.close();
    d.close();
  });

  it("Retry on the taken-over Hub takes the Side back", async () => {
    const { d } = daemon();
    const a = hub(d);
    const b = hub(d);
    await a.sides.start("ssh:box");
    await b.sides.start("ssh:box");
    await vi.advanceTimersByTimeAsync(5);
    await a.sides.start("ssh:box");
    await vi.advanceTimersByTimeAsync(5);
    expect(row(a).state).toBe("ready");
    expect(row(b)).toMatchObject({ state: "off", message: expect.stringMatching(/taken over/) });
    a.sides.close();
    b.sides.close();
    d.close();
  });
});

describe("update pending", () => {
  /** A Hub of build "new"; its spawns attach to the Daemons in order (the last repeats). */
  function updHub(daemons: ReturnType<typeof daemon>["d"][], extra: Partial<Parameters<typeof createSides>[0]> = {}) {
    const spawned: { setup?: string; attach?: boolean; bundleOnly?: boolean }[] = [];
    const pipes: ReturnType<typeof pipe>[] = [];
    const sides = createSides({
      targets: [sideTarget("ssh", "box")],
      spawn: (_id, o) => (spawned.push(o), pipes.push(pipe(daemons[Math.min(pipes.length, daemons.length - 1)]!)), pipes.at(-1)!),
      key: () => "new",
      updateWaitMs: 5_000,
      heartbeatMs: 1e9,
      attached: store(["ssh:box"]).attached,
      ...extra,
    });
    return { sides, spawned, pipes, row: () => sides.list().find((s) => s.id === "ssh:box")! };
  }

  it("a newer Hub attaches to an older Daemon, shows update pending while a turn runs, and updates once nothing runs", async () => {
    const old = daemon({ build: "old" });
    old.st.busy = true;
    old.d.running(true);
    const fresh = daemon({ build: safeKey("new") });
    const h = updHub([old.d, fresh.d]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.spawned).toEqual([expect.objectContaining({ attach: true })]);
    expect(h.row()).toMatchObject({ state: "ready", updatePending: true });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(h.spawned.length).toBe(1); // still running: nothing happens
    expect(old.st.exited).toBe(0);
    old.st.busy = false;
    old.d.running(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.pipes[0]!.sent.join("")).toContain('{"grace":1}');
    expect(h.row().state).toBe("starting");
    await vi.advanceTimersByTimeAsync(1_500); // the idle Daemon expires on its next tick
    expect(old.st.exited).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.spawned[1]).toMatchObject({ setup: "needed", bundleOnly: true });
    expect(h.spawned[1]!.attach).toBeUndefined();
    expect(h.row()).toMatchObject({ state: "ready" });
    expect(h.row().updatePending).toBeUndefined();
    h.sides.close();
  });

  it("an open terminal counts as running: the update waits until it is closed", async () => {
    const old = daemon({ build: "old" });
    old.st.terminals = 1;
    old.d.running(false);
    const h = updHub([old.d, daemon({ build: safeKey("new") }).d]);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(h.row()).toMatchObject({ state: "ready", updatePending: true });
    expect(h.spawned.length).toBe(1);
    old.st.terminals = 0; // the Daemon reports the change on its next tick
    await vi.advanceTimersByTimeAsync(1_100);
    expect(h.pipes[0]!.sent.join("")).toContain('{"grace":1}');
    h.sides.close();
  });

  it("a Daemon of the previous build (ready without build) counts as another build", async () => {
    const old = daemon();
    old.st.busy = true;
    old.d.running(true);
    const h = updHub([old.d]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.row()).toMatchObject({ state: "ready", updatePending: true });
    h.sides.close();
  });

  it("the same build: no update pending", async () => {
    const h = updHub([daemon({ build: safeKey("new") }).d]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.row().state).toBe("ready");
    expect(h.row().updatePending).toBeUndefined();
    h.sides.close();
  });

  it("Update automatically off: no update pending, nothing restarts", async () => {
    const old = daemon({ build: "old" });
    const h = updHub([old.d], { saved: [{ id: "ssh:box", key: "new", update: false }] });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(h.row().state).toBe("ready");
    expect(h.row().updatePending).toBeUndefined();
    expect(h.spawned.length).toBe(1);
    expect(old.st.exited).toBe(0);
    h.sides.close();
  });

  it("a launch that still meets the old Daemon tries the update at most twice per Hub run", async () => {
    const old = daemon({ build: "old" });
    const h = updHub([old.d]);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(h.spawned.length).toBe(3); // attach, update try 1, update try 2
    expect(h.row()).toMatchObject({ state: "ready", updatePending: true });
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(h.spawned.length).toBe(3);
    h.sides.close();
  });

  const check = (install: object | undefined, installed = "none") => () => Promise.resolve({ verdict: "install", key: "new", facts: { reachable: true, running: false, installed, ...(install && { install }) } } as never);

  it("no usable bundle on this machine: the old Daemon is not ended (the launch would find nothing installed), no more tries", async () => {
    const old = daemon({ build: "old" });
    const h = updHub([old.d], { check: check({ method: "npm", reason: "no bundle" }) });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(h.row()).toMatchObject({ state: "ready", updatePending: true });
    expect(h.pipes[0]!.sent.join("")).not.toContain('{"grace":1}');
    expect(h.spawned.length).toBe(1);
    expect(old.st.exited).toBe(0);
    h.sides.close();
  });

  it("a usable bundle: the update goes on as usual", async () => {
    const old = daemon({ build: "old" });
    const h = updHub([old.d, daemon({ build: safeKey("new") }).d], { check: check({ method: "bundle" }) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.spawned[1]).toMatchObject({ setup: "needed", bundleOnly: true });
    expect(h.row().updatePending).toBeUndefined();
    h.sides.close();
  });

  it("only an older Daemon is updated: an older Hub does not downgrade a newer Daemon", () => {
    expect(isNewerBuild("1.2.0-5", "1.1.0-9")).toBe(true);
    expect(isNewerBuild("1.2.0-9", "1.2.0-5")).toBe(true);
    expect(isNewerBuild("1.2.0-5", "1.2.0-5")).toBe(false);
    expect(isNewerBuild("1.1.0-9", "1.2.0-1")).toBe(false);
    expect(isNewerBuild("1.2.0-5", undefined)).toBe(true);
    expect(isNewerBuild("new", "old")).toBe(true);
  });
});
