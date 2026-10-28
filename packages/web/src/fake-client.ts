// Stands in for client.ts in the docs screenshots (docs/site/shots/vite.config.ts redirects every import of client.ts here): the same API,
// answered from scripted data instead of a daemon. Types and helpers come from the real module; only `connect` is replaced.
// Generic on purpose: the data comes from docs/site/shots through `useFakeDaemon`, this file knows nothing about scenes.
import type { ServerMessage, SessionsSearchResult } from "@claude-ui/protocol";
import { connect as realConnect } from "./client.ts";

export * from "./client.ts";

type Opts = Parameters<typeof realConnect>[0];
type Client = ReturnType<typeof realConnect>;
type Req = { type: string; [k: string]: unknown };

export type FakeDaemon = {
  /** Reply by request type; a function gets the request. An unknown type resolves `{}` with a console warning. */
  replies: Record<string, unknown | ((req: Req) => unknown)>;
  /** Server messages pushed once the connection is open, in order. */
  events?: ServerMessage[];
};

let data: FakeDaemon | undefined;

/** Resolves once the scripted events are emitted, so the caller can wait before it takes a picture. */
let markEmitted!: () => void;
export const fakeEmitted = new Promise<void>((r) => (markEmitted = r));

/** Call before the app renders. */
export function useFakeDaemon(d: FakeDaemon): void {
  data = d;
}

export function connect(opts: Opts): Client {
  if (!data) throw new Error("fake daemon: call useFakeDaemon() before the app connects");
  const { replies, events = [] } = data;
  const warned = new Set<string>();
  const fs = new Set<(m: Extract<ServerMessage, { type: "fs.changed" }>) => void>();
  const terminal = new Set<(m: Extract<ServerMessage, { type: "terminal.output" | "terminal.exit" }>) => void>();

  const dispatch = (m: ServerMessage) => {
    if (m.type === "event") return opts.onEvent(m);
    if (m.type === "fs.changed") return fs.forEach((l) => l(m));
    if (m.type === "terminal.output" || m.type === "terminal.exit") return terminal.forEach((l) => l(m));
    if (m.type === "sessions.changed") return opts.onSessionsChanged?.(m);
    if (m.type === "plan_usage") return opts.onPlanUsage?.(m.usage);
    if (m.type === "settings_changed") return opts.onSettingsChanged?.(m);
    if (m.type === "config.changed") return opts.onConfigChanged?.(m);
    if (m.type === "update_available" || m.type === "update_state") return opts.onUpdate?.(m);
    if (m.type === "daemon_stale") return opts.onStale?.(m.note);
  };

  queueMicrotask(() => {
    opts.onStatus?.("connected");
    opts.onOpen?.();
    // After the app's startup requests, so an event lands on a subscribed view.
    setTimeout(() => events.forEach(dispatch), 150);
    setTimeout(markEmitted, 200);
  });

  return {
    async request<T>(msg: Req): Promise<T> {
      const r = replies[msg.type];
      if (r === undefined) {
        if (!warned.has(msg.type)) console.warn(`[scene] unhandled request "${msg.type}", replied {}`);
        warned.add(msg.type);
        return {} as T;
      }
      return (typeof r === "function" ? (r as (m: Req) => unknown)(msg) : r) as T;
    },
    async search(): Promise<SessionsSearchResult> {
      return { scannedFiles: 0, scannedBytes: 0, ms: 0 };
    },
    onFsChanged: (l) => (fs.add(l), () => void fs.delete(l)),
    onTerminal: (l) => (terminal.add(l), () => void terminal.delete(l)),
    close() {},
  } as Client;
}
