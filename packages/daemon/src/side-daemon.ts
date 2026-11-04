// The Side Daemon of an SSH Side (ADR 0007): outlives the pipe of the Hub. It serves one attached pipe at a time (the newest attach takes
// over) and counts the Grace period while no pipe is attached and no turn runs.
import { PassThrough, type Readable, type Writable } from "node:stream";
import type { PushPayload } from "@claude-ui/protocol";
import type { GitRunner } from "./git-runner.ts";
import { runSide, type SideSocket } from "./sides.ts";

export const DEFAULT_GRACE_MS = 30 * 60_000;
export const HEARTBEAT_MS = 15_000;

export function createSideDaemon(o: {
  accept: (ws: SideSocket) => void;
  git?: GitRunner;
  /** A turn runs. A turn that waits on a permission prompt or a question is idle. */
  busy: () => boolean;
  /** Open terminals: reported to the Hub, which does not update this Daemon while one is open. */
  terminals?: () => number;
  /** The install folder name of this build (the Hub compares it with its own: another build is an update pending). */
  build?: string;
  /** At expiry: stops the turns that are still open (they wait for the user), before `exit`. */
  stopIdle: () => Promise<void> | void;
  exit: () => void;
  graceMs?: number;
  heartbeatMs?: number;
  /** How long a second pipe waits for the Hub's `hello` line while another pipe is attached (default 2 s; a Hub of the previous build sends none). */
  helloMs?: number;
  /** How often the Grace period is counted (default 1 s). */
  tickMs?: number;
}) {
  let graceMs = o.graceMs ?? DEFAULT_GRACE_MS;
  let pipe: ReturnType<typeof runSide> | undefined;
  /** The Hub (`hello.hub`) of the attached pipe; undefined for a Hub of the previous build. */
  let pipeHub: string | undefined;
  let running = false;
  let idleMs = 0;
  let last = Date.now();
  let expired = false;
  let terms = 0;
  const tick = setInterval(() => {
    const n = o.terminals?.() ?? 0;
    if (n !== terms) (terms = n), pipe?.terminals(n);
    const now = Date.now();
    const dt = now - last;
    last = now;
    // An attached Hub or a running turn holds the count at 0: the full Grace period starts when the Daemon is idle again.
    if (pipe || o.busy() || expired) return void (idleMs = 0);
    idleMs += dt;
    if (idleMs >= graceMs) {
      expired = true;
      void Promise.resolve(o.stopIdle()).catch(() => {}).finally(o.exit);
    }
  }, o.tickMs ?? 1000);
  tick.unref();
  const begin = (input: Readable, output: Writable, hub?: string) => {
    pipe?.takeOver();
    pipeHub = hub;
    idleMs = 0;
    const mine: ReturnType<typeof runSide> = (pipe = runSide({
      input,
      output,
      accept: o.accept,
      git: o.git,
      heartbeatMs: o.heartbeatMs ?? HEARTBEAT_MS,
      build: o.build,
      onGrace: (ms) => (graceMs = ms),
      onHello: (h) => void (pipe === mine && (pipeHub = h)),
      onEnd: () => {
        if (pipe !== mine) return;
        pipe = undefined;
        pipeHub = undefined;
        idleMs = 0;
        last = Date.now();
      },
    }));
    // Terminals first: the Hub decides on the `running` frame, so it must know the terminals by then.
    if (o.terminals) mine.terminals((terms = o.terminals()));
    mine.running(running);
  };
  return {
    /**
     * The attach seam: the pipe of a Hub (ssh stdio through the bridge, or a stream pair in tests). With no pipe attached it starts at once. With one
     * attached it first reads the new Hub's `{"hello":{"hub","auto"}}` line: an automatic attach (a reconnect, a Hub start) of another Hub is refused
     * with `{"taken":1}` (it must not take the Side back from the Hub that took it over); any other attach takes over.
     */
    attach(input: Readable, output: Writable) {
      if (!pipe) return begin(input, output);
      let buf = "";
      const settle = (hello: { hub?: unknown; auto?: unknown } | undefined, rest: string) => {
        clearTimeout(timer);
        input.off("data", onData);
        const hub = typeof hello?.hub === "string" ? hello.hub : undefined;
        if (hello?.auto === true && pipe && pipeHub !== undefined && hub !== pipeHub) {
          output.write('{"taken":1}\n');
          output.end();
          return void input.destroy();
        }
        const relay = new PassThrough();
        relay.on("close", () => input.destroy());
        if (rest) relay.write(rest);
        input.pipe(relay);
        begin(relay, output, hub);
      };
      const onData = (b: Buffer | string) => {
        buf += b;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        let hello: { hub?: unknown; auto?: unknown } | undefined;
        try {
          hello = (JSON.parse(buf.slice(0, nl)) as { hello?: object }).hello;
        } catch {
          // not a hello: the line is the pipe's first frame
        }
        settle(hello, hello ? buf.slice(nl + 1) : buf);
      };
      const timer = setTimeout(() => settle(undefined, buf), o.helloMs ?? 2000);
      input.on("data", onData);
      input.once("close", () => clearTimeout(timer));
    },
    push: (p: PushPayload) => pipe?.push(p),
    running(on: boolean) {
      running = on;
      pipe?.running(on);
    },
    close: () => (clearInterval(tick), pipe?.end()),
  };
}
