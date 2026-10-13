// Queued messages (docs/spec.md "Queued messages"): per-session list of prompts the daemon sends, one per turn, when the session is next idle.
import { randomUUID } from "node:crypto";

export const MAX_QUEUED = 20;
export type QueueItem = { id: string; text: string; images: string[] };
export type QueueHeld = { reason: "usage_limit" | "not_live"; until?: number };
type Err = { code: string; message: string };
type Entry = { items: QueueItem[]; held?: QueueHeld; timer?: NodeJS.Timeout; inflight: boolean; /** Send nows running: like inflight, no kick sends meanwhile. */ now: number };

export function createPromptQueue(o: {
  /** The session takes a prompt as a new turn now. */
  ready: (id: string) => boolean;
  /** Sends the item like session.prompt; the reason when it is not taken. */
  send: (id: string, item: QueueItem) => Promise<Err | undefined>;
  show: (id: string, items: QueueItem[], held: QueueHeld | undefined) => void;
}) {
  const map = new Map<string, Entry>();
  const entry = (id: string) => map.get(id) ?? (map.set(id, { items: [], inflight: false, now: 0 }), map.get(id)!);
  const show = (id: string) => {
    const e = map.get(id);
    o.show(id, e ? [...e.items] : [], e?.held);
  };
  const clearTimer = (e: Entry) => (clearTimeout(e.timer), (e.timer = undefined));

  async function run(id: string) {
    const e = map.get(id);
    if (!e || e.inflight || e.now || e.held || !e.items.length || !o.ready(id)) return;
    const item = e.items.shift()!;
    e.inflight = true;
    show(id);
    const err = await o.send(id, item).catch((x): Err => ({ code: "prompt_failed", message: String(x) }));
    e.inflight = false;
    if (!err) return;
    e.items.unshift(item);
    if (err.code === "session_not_live") e.held = { reason: "not_live" };
    show(id);
  }
  // Deferred: a kick comes from inside event emission and must not start a prompt there.
  const kick = (id: string) => void queueMicrotask(() => void run(id));

  return {
    /** The new item's id, or the reason it is refused. */
    enqueue(id: string, item: { text: string; images: string[] }): string | Err {
      const e = entry(id);
      if (e.items.length >= MAX_QUEUED) return { code: "queue_full", message: `at most ${MAX_QUEUED} queued messages` };
      const full = { id: randomUUID(), ...item };
      e.items.push(full);
      show(id);
      kick(id);
      return full.id;
    },
    take(id: string, itemId: string): QueueItem | undefined {
      const e = map.get(id);
      const at = e?.items.findIndex((i) => i.id === itemId) ?? -1;
      if (!e || at < 0) return undefined;
      const [item] = e.items.splice(at, 1);
      show(id);
      return item;
    },
    /** Send now: sends the item at once (also while a turn runs); a failed send puts it back at its place. */
    async sendNow(id: string, itemId: string): Promise<Err | undefined> {
      const e = map.get(id);
      const at = e?.items.findIndex((i) => i.id === itemId) ?? -1;
      if (!e || at < 0) return { code: "unknown_item", message: "queued message not found (already sent?)" };
      const [item] = e.items.splice(at, 1);
      show(id);
      e.now++;
      const err = await o.send(id, item!).catch((x): Err => ({ code: "prompt_failed", message: String(x) }));
      e.now--;
      if (err) {
        e.items.splice(Math.min(at, e.items.length), 0, item!);
        show(id);
      }
      return err;
    },
    kick,
    /** Pauses sending until `until` (ms) or, without it, until release(). */
    hold(id: string, until?: number) {
      const e = entry(id);
      clearTimer(e);
      e.held = { reason: "usage_limit", until };
      if (until !== undefined) {
        e.timer = setTimeout(() => this.release(id), Math.min(Math.max(until - Date.now(), 0), 2 ** 31 - 1)).unref();
      }
      show(id);
    },
    release(id: string) {
      const e = map.get(id);
      if (!e || !e.held) return;
      clearTimer(e);
      e.held = undefined;
      show(id);
      kick(id);
    },
    /** The session cannot take prompts (error, closed): the queue is shown paused; back to normal: the pause ends. */
    setNotLive(id: string, notLive: boolean) {
      const e = map.get(id);
      if (!e) return;
      if (notLive) {
        if (!e.items.length || e.held?.reason === "not_live") return;
        clearTimer(e);
        e.held = { reason: "not_live" };
        show(id);
      } else if (e.held?.reason === "not_live") this.release(id);
    },
    /** /clear: the queue follows the conversation. */
    move(from: string, to: string) {
      const a = map.get(from);
      if (!a?.items.length) return;
      const b = entry(to);
      b.items.push(...a.items);
      a.items = [];
      show(from);
      show(to);
    },
    drop(id: string) {
      const e = map.get(id);
      if (e) clearTimer(e);
      map.delete(id);
    },
    items: (id: string) => [...(map.get(id)?.items ?? [])],
  };
}
