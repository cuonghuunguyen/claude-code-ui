// One WebSocket per tab. Requests resolve on the reply with the same reqId; events go to onEvent.
import type { ClientMessage, Event, ServerMessage } from "@claude-ui/protocol";

type Request = ClientMessage extends infer M ? (M extends ClientMessage ? Omit<M, "reqId"> : never) : never;

export function connect(onEvent: (e: Event) => void) {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  const pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  const open = new Promise<void>((r) => ws.addEventListener("open", () => r(), { once: true }));

  ws.addEventListener("message", (ev) => {
    const m: ServerMessage = JSON.parse(ev.data);
    if (m.type === "event") return onEvent(m);
    const p = m.reqId ? pending.get(m.reqId) : undefined;
    if (!p) return console.error("daemon error", m);
    pending.delete(m.reqId!);
    m.type === "reply" ? p.resolve(m.result) : p.reject(new Error(m.message));
  });

  // ponytail: no reconnect yet; the reconnect/replay issue adds backoff and resubscribe.
  async function request<T>(msg: Request): Promise<T> {
    await open;
    const reqId = crypto.randomUUID();
    ws.send(JSON.stringify({ ...msg, reqId }));
    return new Promise<T>((resolve, reject) => pending.set(reqId, { resolve: resolve as (r: unknown) => void, reject }));
  }

  return { request, close: () => ws.close() };
}
