// Shared by the SSH Side tests (GH-548, GH-549): an in-process Side Daemon and the hub's end of its pipe. No ssh.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createSideDaemon } from "../src/side-daemon.ts";
import { createSides, wslSide, type SideProcess } from "../src/sides.ts";
import { sideTarget } from "../src/side-kinds.ts";

/** An in-process Side Daemon: `busy` is a turn running; `opened` counts the virtual connections its handler accepted. */
export function daemon(o: { graceMs?: number; heartbeatMs?: number; build?: string } = {}) {
  const st = { busy: false, terminals: 0, stopped: 0, exited: 0, opened: 0, closed: 0 };
  const d = createSideDaemon({
    accept: (ws) => (st.opened++, ws.on("close", () => st.closed++)),
    busy: () => st.busy,
    terminals: () => st.terminals,
    stopIdle: () => void st.stopped++,
    exit: () => void st.exited++,
    // The test hub end does not heartbeat: a long period keeps its pipes alive.
    heartbeatMs: 1e9,
    ...o,
  });
  return { d, st };
}

/** One pipe: the hub's end as a SideProcess; `drop()` is a dead ssh (the bridge ends both streams). */
export function pipe(d: ReturnType<typeof daemon>["d"]): SideProcess & { drop(): void; sent: string[]; received: string[] } {
  const toDaemon = new PassThrough();
  const fromDaemon = new PassThrough();
  const exit = new EventEmitter();
  const sent: string[] = [];
  const received: string[] = [];
  toDaemon.on("data", (b: Buffer) => sent.push(String(b)));
  // Not a data listener: it would start the flow before the hub reads the stream.
  const write = fromDaemon.write.bind(fromDaemon) as (c: unknown, ...a: unknown[]) => boolean;
  fromDaemon.write = ((c: unknown, ...a: unknown[]) => (received.push(String(c)), write(c, ...a))) as never;
  d.attach(toDaemon, fromDaemon);
  // The bridge and ssh end with the Daemon's end of the pipe (a takeover, a Grace expiry), or with a dead ssh (`drop`).
  let gone = false;
  const bye = () => gone || ((gone = true), exit.emit("exit", 255));
  fromDaemon.once("end", bye);
  const drop = () => (toDaemon.end(), fromDaemon.destroy(), bye());
  return { stdin: toDaemon, stdout: fromDaemon, stderr: new PassThrough(), kill: drop, drop, sent, received, on: (e: "exit", l: (c: number | null) => void) => exit.on(e, l) } as never;
}

/** A process whose attach found no Side Daemon: the bridge says so and exits 3. */
export function noDaemon(): SideProcess {
  const stdout = new PassThrough();
  const exit = new EventEmitter();
  setTimeout(() => (stdout.write("CLAUDE_UI_SETUP no_daemon\n"), exit.emit("exit", 3)), 1);
  return { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => {}, on: (e, l) => exit.on(e, l) };
}

export function hub(d: ReturnType<typeof daemon>["d"], extra: Partial<Parameters<typeof createSides>[0]> = {}) {
  const pipes: ReturnType<typeof pipe>[] = [];
  const spawned: { setup?: string; attach?: boolean; bundleOnly?: boolean }[] = [];
  const sides = createSides({
    targets: [sideTarget("ssh", "box"), wslSide("Ubuntu")],
    spawn: (_id, o) => (spawned.push(o), (extra as { next?: () => SideProcess }).next?.() ?? (pipes.push(pipe(d)), pipes.at(-1)!)),
    discoverMs: 0,
    // The in-process Daemon does not heartbeat (see `daemon`): the hub's own check would end the pipe after 45 s.
    heartbeatMs: 1e9,
    ...extra,
  });
  return { sides, pipes, spawned, state: () => sides.list().find((s) => s.id === "ssh:box")!.state };
}

