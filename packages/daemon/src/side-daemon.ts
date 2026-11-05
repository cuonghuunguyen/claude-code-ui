// The attach server of a Hub (ADR 0009): any Hub on a POSIX machine accepts attaching Hubs on its attach socket, several at once (as browsers
// connect to it). A Hub started by an attach counts the Grace period while no Hub is attached, no browser is connected and no turn runs.
import type { Readable, Writable } from "node:stream";
import type { PushPayload } from "@claude-ui/protocol";
import type { GitRunner } from "./git-runner.ts";
import { SIDE_SCHEMA, schemaOverlap } from "./side-frame.ts";
import { runSide, type SideSocket } from "./sides.ts";

export const DEFAULT_GRACE_MS = 30 * 60_000;
export const HEARTBEAT_MS = 15_000;

export function createAttachServer(o: {
  accept: (ws: SideSocket) => void;
  git?: GitRunner;
  /** A turn runs. A turn that waits on a permission prompt or a question is idle. */
  busy: () => boolean;
  /** Real browser connections of this Hub (not the virtual ones of attached Hubs). */
  browsers: () => number;
  /** The install folder name of this build (the attaching Hub compares it with its own: another build is an update pending). */
  build?: string;
  version: string;
  /** Only a Hub started by an attach has a Grace period; a Hub the user started never ends by it. */
  startedBy?: "attach";
  /** At expiry: stops the turns that are still open (they wait for the user), before `exit`. */
  stopIdle: () => Promise<void> | void;
  exit: () => void;
  graceMs?: number;
  heartbeatMs?: number;
  /** How long a pipe waits for the attaching Hub's `hello` line (default 5 s). */
  helloMs?: number;
  /** How often the Grace period is counted (default 1 s). */
  tickMs?: number;
}) {
  let graceMs = o.graceMs ?? DEFAULT_GRACE_MS;
  const pipes = new Set<ReturnType<typeof runSide>>();
  let closed = false;
  let running = false;
  let idleMs = 0;
  let last = Date.now();
  let expired = false;
  const tick = setInterval(() => {
    const now = Date.now();
    const dt = now - last;
    last = now;
    // An attached Hub, a browser or a running turn holds the count at 0: the full Grace period starts when the Hub is idle again.
    if (o.startedBy !== "attach" || pipes.size || o.browsers() || o.busy() || expired) return void (idleMs = 0);
    idleMs += dt;
    if (idleMs >= graceMs) {
      expired = true;
      void Promise.resolve(o.stopIdle()).catch(() => {}).finally(o.exit);
    }
  }, o.tickMs ?? 1000);
  tick.unref();
  const begin = (input: Readable, output: Writable) => {
    idleMs = 0;
    const mine: ReturnType<typeof runSide> = runSide({
      input,
      output,
      accept: o.accept,
      git: o.git,
      heartbeatMs: o.heartbeatMs ?? HEARTBEAT_MS,
      ready: { schema: SIDE_SCHEMA, version: o.version, build: o.build, ...(o.startedBy && { startedBy: o.startedBy }) },
      onGrace: (ms) => (graceMs = ms),
      onEnd: () => {
        pipes.delete(mine);
        idleMs = 0;
        last = Date.now();
      },
    });
    pipes.add(mine);
    mine.running(running);
  };
  return {
    /**
     * The attach seam: the pipe of an attaching Hub (a socket of the bridge, or a stream pair in tests). Its first line is
     * `{"hello":{"schema":[min,max]}}`. A range that does not overlap ours gets our `ready` frame alone (version and range, for its mismatch row), then the pipe ends.
     */
    attach(input: Readable, output: Writable) {
      if (closed) return (output.end(), void input.destroy());
      let buf = "";
      const settle = (rest: string | undefined, ok: boolean) => {
        clearTimeout(timer);
        input.off("data", onData);
        if (!ok) {
          if (rest !== undefined) output.write(JSON.stringify({ ready: true, schema: SIDE_SCHEMA, version: o.version, ...(o.build && { build: o.build }), ...(o.startedBy && { startedBy: o.startedBy }) }) + "\n");
          return (output.end(), void input.destroy());
        }
        // The bytes read past the hello line go back to the pipe's reader.
        if (rest) input.unshift(Buffer.from(rest));
        begin(input, output);
      };
      const onData = (b: Buffer | string) => {
        buf += b;
        // The hello is one short line; anything longer is not an attaching Hub.
        if (buf.length > 65_536) return settle(undefined, false);
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        let range: unknown;
        try {
          range = (JSON.parse(buf.slice(0, nl)) as { hello?: { schema?: unknown } }).hello?.schema;
        } catch {
          // not a hello
        }
        const r = Array.isArray(range) && range.length === 2 && range.every(Number.isInteger) ? (range as [number, number]) : undefined;
        settle(buf.slice(nl + 1), !!r && schemaOverlap(r, SIDE_SCHEMA));
      };
      // A Hub that sends no hello (a build before this one) is not attached: it could not read our ready frame either.
      const timer = setTimeout(() => settle(undefined, false), o.helloMs ?? 5000);
      input.on("data", onData);
      input.once("close", () => clearTimeout(timer));
    },
    push: (p: PushPayload) => pipes.forEach((x) => x.push(p)),
    running(on: boolean) {
      running = on;
      pipes.forEach((x) => x.running(on));
    },
    /** The attach socket is closed first (a Hub that retires accepts no new pipe); attached pipes stay until the Hub exits. */
    stopAccepting: () => void (closed = true),
    close: () => (clearInterval(tick), pipes.forEach((x) => x.end())),
  };
}
