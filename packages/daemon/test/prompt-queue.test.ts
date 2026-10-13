import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPromptQueue, MAX_QUEUED } from "../src/prompt-queue.ts";

type Err = { code: string; message: string } | undefined;
function setup() {
  const st = { ready: true, result: undefined as Err };
  const sent: { id: string; text: string }[] = [];
  const shown: { id: string; texts: string[]; held: unknown }[] = [];
  const q = createPromptQueue({
    ready: () => st.ready,
    send: async (id, item) => (sent.push({ id, text: item.text }), st.result),
    show: (id, items, held) => shown.push({ id, texts: items.map((i) => i.text), held }),
  });
  return { q, st, sent, shown };
}
const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("prompt queue", () => {
  it("enqueue while ready sends once and empties the list", async () => {
    const { q, sent, shown } = setup();
    q.enqueue("s", { text: "a", images: [] });
    await flush();
    expect(sent).toEqual([{ id: "s", text: "a" }]);
    expect(shown.at(-1)).toEqual({ id: "s", texts: [], held: undefined });
  });

  it("not ready: nothing; each kick sends only the first item", async () => {
    const { q, st, sent } = setup();
    st.ready = false;
    q.enqueue("s", { text: "a", images: [] });
    q.enqueue("s", { text: "b", images: [] });
    await flush();
    expect(sent).toEqual([]);
    st.ready = true;
    q.kick("s");
    await flush();
    expect(sent.map((x) => x.text)).toEqual(["a"]);
    q.kick("s");
    await flush();
    expect(sent.map((x) => x.text)).toEqual(["a", "b"]);
  });

  it("two kicks while a send is in flight send once", async () => {
    const sent: string[] = [];
    let done!: () => void;
    const q = createPromptQueue({ ready: () => true, send: (_id, i) => (sent.push(i.text), new Promise((r) => (done = () => r(undefined)))), show: () => {} });
    q.enqueue("s", { text: "a", images: [] });
    q.enqueue("s", { text: "b", images: [] });
    await flush();
    q.kick("s");
    q.kick("s");
    await flush();
    expect(sent).toEqual(["a"]);
    done();
  });

  it("take removes and returns; unknown id gives undefined", () => {
    const { q, st } = setup();
    st.ready = false;
    const id = q.enqueue("s", { text: "a", images: ["i"] });
    expect(q.take("s", "nope")).toBeUndefined();
    expect(q.take("s", id as string)).toMatchObject({ text: "a", images: ["i"] });
    expect(q.take("s", id as string)).toBeUndefined();
  });

  it("session_not_live: item back at head, held not_live, nothing until release", async () => {
    const { q, st, sent, shown } = setup();
    st.result = { code: "session_not_live", message: "x" };
    q.enqueue("s", { text: "a", images: [] });
    await flush();
    expect(shown.at(-1)).toEqual({ id: "s", texts: ["a"], held: { reason: "not_live" } });
    st.result = undefined;
    q.kick("s");
    await flush();
    expect(sent).toHaveLength(1);
    q.release("s");
    await flush();
    expect(sent).toHaveLength(2);
  });

  it("external_turn failure: stays at head, next kick retries", async () => {
    const { q, st, sent, shown } = setup();
    st.result = { code: "external_turn", message: "x" };
    q.enqueue("s", { text: "a", images: [] });
    await flush();
    expect(shown.at(-1)!.texts).toEqual(["a"]);
    st.result = undefined;
    q.kick("s");
    await flush();
    expect(sent.map((x) => x.text)).toEqual(["a", "a"]);
  });

  it("hold(until) waits for the time; hold() waits for release", async () => {
    const { q, sent, shown } = setup();
    q.hold("s", Date.now() + 1000);
    q.enqueue("s", { text: "a", images: [] });
    await vi.advanceTimersByTimeAsync(900);
    expect(sent).toEqual([]);
    expect(shown.at(-1)!.held).toEqual({ reason: "usage_limit", until: expect.any(Number) });
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toHaveLength(1);
    q.hold("s");
    q.enqueue("s", { text: "b", images: [] });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(sent).toHaveLength(1);
    q.release("s");
    await flush();
    expect(sent).toHaveLength(2);
  });

  it("move transfers items and shows both sessions", () => {
    const { q, st, shown } = setup();
    st.ready = false;
    q.enqueue("a", { text: "x", images: [] });
    q.move("a", "b");
    expect(q.items("b").map((i) => i.text)).toEqual(["x"]);
    expect(q.items("a")).toEqual([]);
    expect(shown.some((s) => s.id === "b" && s.texts[0] === "x")).toBe(true);
    expect(shown.at(-1)!.id === "a" || shown.some((s) => s.id === "a" && s.texts.length === 0)).toBe(true);
  });

  it("the 21st item is queue_full", () => {
    const { q, st } = setup();
    st.ready = false;
    for (let i = 0; i < MAX_QUEUED; i++) expect(typeof q.enqueue("s", { text: String(i), images: [] })).toBe("string");
    expect(q.enqueue("s", { text: "x", images: [] })).toEqual({ code: "queue_full", message: expect.any(String) });
  });

  it("Send now marks the queue busy while it sends: a kick then sends no second item", async () => {
    const sent: string[] = [];
    const done: (() => void)[] = [];
    const q = createPromptQueue({ ready: () => true, send: (_id, i) => (sent.push(i.text), new Promise((r) => done.push(() => r(undefined)))), show: () => {} });
    // A held queue places both items without sending.
    q.hold("s");
    q.enqueue("s", { text: "a", images: [] });
    q.enqueue("s", { text: "b", images: [] });
    const [a] = q.items("s");
    const now = q.sendNow("s", a!.id);
    await flush();
    expect(sent).toEqual(["a"]);
    q.release("s"); // hold gone while the Send now is still in flight
    q.kick("s");
    await flush();
    expect(sent).toEqual(["a"]);
    done[0]!();
    await now;
    q.kick("s");
    await flush();
    expect(sent).toEqual(["a", "b"]);
  });
});
