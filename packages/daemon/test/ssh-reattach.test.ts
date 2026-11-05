// GH-549 / ADR 0009: Hub restart reattach, several Hubs on one Hub and updates of an SSH Side. In-process attach servers, fake timers, no ssh.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { safeKey } from "../src/side-bundle.ts";
import { createSides, isNewerBuild, type SideProcess } from "../src/sides.ts";
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
    expect(row(h)).toMatchObject({ state: "off", message: expect.stringContaining("Open it again") });
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
  it("both attach to the same Hub there and both are ready; no takeover", async () => {
    const { d, st } = daemon();
    const a = hub(d);
    const b = hub(d);
    await a.sides.start("ssh:box");
    await b.sides.start("ssh:box");
    await vi.advanceTimersByTimeAsync(5);
    a.sides.open("ssh:box", () => {});
    b.sides.open("ssh:box", () => {});
    await vi.advanceTimersByTimeAsync(5);
    expect(row(a).state).toBe("ready");
    expect(row(b).state).toBe("ready");
    expect(st.opened).toBe(2);
    expect(st.exited).toBe(0);
    a.sides.close();
    b.sides.close();
    d.close();
  });
});

describe("update and mismatch", () => {
  /** A Hub of build "new"; `update` runs (`claude-ui update` there) are counted and exit 0. */
  function updHub(d: ReturnType<typeof daemon>["d"], extra: Partial<Parameters<typeof createSides>[0]> = {}) {
    const updates: number[] = [];
    const sides = createSides({
      targets: [sideTarget("ssh", "box")],
      spawn: (_id, o) => {
        if (o.run !== "update") return pipe(d);
        updates.push(1);
        const exit = new EventEmitter();
        setTimeout(() => exit.emit("exit", 0), 1);
        return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {}, on: (e, l) => exit.on(e, l) } as SideProcess;
      },
      key: () => "new",
      heartbeatMs: 1e9,
      attached: store(["ssh:box"]).attached,
      ...extra,
    });
    return { sides, updates, row: () => sides.list().find((s) => s.id === "ssh:box")! };
  }

  it("an attach-started Hub of an older build is updated; the row shows updatePending", async () => {
    const old = daemon({ build: "old", startedBy: "attach" });
    const h = updHub(old.d);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.updates.length).toBe(1);
    expect(h.row().updatePending).toBe(true);
    h.sides.close();
    old.d.close();
  });

  it("a Hub the user started is never updated; neither the same build nor Update automatically off", async () => {
    const user = daemon({ build: "old" });
    const a = updHub(user.d);
    const same = daemon({ build: safeKey("new"), startedBy: "attach" });
    const b = updHub(same.d);
    const off = daemon({ build: "old", startedBy: "attach" });
    const c = updHub(off.d, { saved: [{ id: "ssh:box", key: "new", update: false }] });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    for (const h of [a, b, c]) {
      expect(h.row().state).toBe("ready");
      expect(h.row().updatePending).toBeUndefined();
      expect(h.updates.length).toBe(0);
      h.sides.close();
    }
    user.d.close();
    same.d.close();
    off.d.close();
  });

  /** A Hub there whose ready frame is `frame`. */
  const readyOf = (frame: object): SideProcess => {
    const stdout = new PassThrough();
    stdout.write(JSON.stringify({ ready: true, killTree: true, hb: true, ...frame }) + "\n");
    const exit = new EventEmitter();
    return { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => exit.emit("exit", 255), on: (e: "exit", l: (c: number | null) => void) => exit.on(e, l) } as never;
  };

  it("a ready frame without schema or with a range that does not overlap: error with the mismatch (remote older or newer)", async () => {
    for (const [frame, remoteOlder] of [[{ version: "1.0.0" }, true], [{ schema: [0, 0], version: "0.9.0" }, true], [{ schema: [2, 2], version: "2.0.0" }, false]] as const) {
      const sides = createSides({ targets: [sideTarget("ssh", "box")], spawn: () => readyOf(frame), version: "1.1.0", heartbeatMs: 1e9 });
      await sides.start("ssh:box").catch(() => {});
      expect(sides.list().find((x) => x.id === "ssh:box")).toMatchObject({ state: "error", mismatch: { remoteOlder, local: "1.1.0" } });
      sides.close();
    }
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
