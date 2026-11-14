import type { Event } from "@claude-ui/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFeeds, FEED_HIGH, FEED_LOW, type FeedSource } from "../src/feed.ts";

const ev = (seq: number, id = `p${seq}`, text = ""): Event => ({ type: "event", sessionId: "s", seq, part: { type: "assistant_text", id, text, streaming: id === "stream" } as never });

/** A session log as Session keeps it: a streamed part's older event is replaced by its latest. */
class FakeSource implements FeedSource {
  log: Event[] = [];
  listeners = new Set<(e: Event) => void>();
  seq = 0;
  emit(id?: string, text = "") {
    const e = ev(++this.seq, id, text);
    if (id === "stream") this.log = this.log.filter((x) => x.part.id !== "stream");
    this.log.push(e);
    for (const l of this.listeners) l(e);
    return e;
  }
  *eventsAfter(seq: number) {
    for (const e of this.log) if (e.seq > seq) yield e;
  }
  subscribe(_since: number, l: (e: Event) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

/** A connection whose buffer the test sets; each send adds the event's size to it. */
function conn(size = 1000) {
  const c = { OPEN: 1, readyState: 1, bufferedAmount: 0 };
  const sent: Event[] = [];
  return { c, sent, send: (e: Event) => (sent.push(e), (c.bufferedAmount += size)) };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("send feeds", () => {
  it("sends at once while the buffer is below HIGH, replay and live", () => {
    const s = new FakeSource();
    s.emit();
    s.emit();
    const { c, sent, send } = conn();
    const feeds = createFeeds(c, send);
    feeds.follow(s, 0, true);
    expect(sent.map((e) => e.seq)).toEqual([1, 2]);
    s.emit();
    expect(sent.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(feeds.paused()).toBe(0);
  });

  it("stops above HIGH and resumes below LOW in seq order without a duplicate", () => {
    const s = new FakeSource();
    const { c, sent, send } = conn();
    const feeds = createFeeds(c, send);
    feeds.follow(s, 0, true);
    c.bufferedAmount = FEED_HIGH + 1;
    s.emit();
    s.emit();
    expect(sent).toHaveLength(0);
    expect(feeds.paused()).toBe(1);
    // Still above LOW: nothing moves.
    c.bufferedAmount = FEED_LOW + 1;
    vi.advanceTimersByTime(200);
    expect(sent).toHaveLength(0);
    c.bufferedAmount = 0;
    vi.advanceTimersByTime(60);
    expect(sent.map((e) => e.seq)).toEqual([1, 2]);
    expect(feeds.paused()).toBe(0);
    s.emit();
    expect(sent.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("sends a streamed part updated many times while paused as one event with the latest text", () => {
    const s = new FakeSource();
    const { c, sent, send } = conn();
    const feeds = createFeeds(c, send);
    feeds.follow(s, 0, true);
    c.bufferedAmount = FEED_HIGH + 1;
    for (let i = 0; i < 50; i++) s.emit("stream", `text ${i}`);
    c.bufferedAmount = 0;
    vi.advanceTimersByTime(60);
    expect(sent).toHaveLength(1);
    expect((sent[0]!.part as { text: string }).text).toBe("text 49");
  });

  it("resumes a shown feed before the background feeds, which take turns", () => {
    const [shown, a, b] = [new FakeSource(), new FakeSource(), new FakeSource()];
    const { c, sent, send } = conn(1000);
    const feeds = createFeeds(c, send);
    c.bufferedAmount = FEED_HIGH + 1;
    for (let i = 0; i < 120; i++) (a.emit(), b.emit());
    for (let i = 0; i < 10; i++) shown.emit();
    // Each source answers with its own session id so the order is visible.
    const named = (src: FakeSource, id: string): FeedSource => ({ eventsAfter: function* (n) { for (const e of src.eventsAfter(n)) yield { ...e, sessionId: id }; }, subscribe: (since, l) => src.subscribe(since, l) });
    feeds.follow(named(a, "a"), 0, false);
    feeds.follow(named(b, "b"), 0, false);
    feeds.follow(named(shown, "shown"), 0, true);
    expect(sent).toHaveLength(0);
    c.bufferedAmount = 0;
    vi.advanceTimersByTime(60);
    const order = sent.map((e) => e.sessionId);
    expect(order.slice(0, 10)).toEqual(Array(10).fill("shown"));
    // A slice of 50 events each: a, then b.
    expect(order.slice(10, 60)).toEqual(Array(50).fill("a"));
    expect(order.slice(60, 110)).toEqual(Array(50).fill("b"));
    // Never more than HIGH + one event above the buffer.
    expect(c.bufferedAmount).toBeLessThanOrEqual(FEED_HIGH + 1000);
  });

  it("the first subscribed tab (the visible one) catches up first, the other open tabs' backlogs then go in turns of 50 events", () => {
    const [visible, other, third] = [new FakeSource(), new FakeSource(), new FakeSource()];
    const { c, sent, send } = conn(1000);
    const feeds = createFeeds(c, send);
    c.bufferedAmount = FEED_HIGH + 1;
    for (let i = 0; i < 100; i++) (visible.emit(), other.emit(), third.emit());
    for (let i = 0; i < 400; i++) other.emit(), third.emit();
    const named = (src: FakeSource, id: string): FeedSource => ({ eventsAfter: function* (n) { for (const e of src.eventsAfter(n)) yield { ...e, sessionId: id }; }, subscribe: (since, l) => src.subscribe(since, l) });
    feeds.follow(named(visible, "visible"), 0, true);
    feeds.follow(named(other, "other"), 0, true);
    feeds.follow(named(third, "third"), 0, true);
    expect(sent).toHaveLength(0);
    c.bufferedAmount = 0;
    vi.advanceTimersByTime(60);
    const order = sent.map((e) => e.sessionId);
    expect(order.slice(0, 100)).toEqual(Array(100).fill("visible"));
    expect(order.slice(100, 150)).toEqual(Array(50).fill("other"));
    expect(order.slice(150, 200)).toEqual(Array(50).fill("third"));
    expect(order.slice(200, 250)).toEqual(Array(50).fill("other"));
  });

  it("orders the shown feeds by the order of the request, not by the order follow() is called in", () => {
    const [first, second, third] = [new FakeSource(), new FakeSource(), new FakeSource()];
    const { c, sent, send } = conn(1000);
    const feeds = createFeeds(c, send);
    c.bufferedAmount = FEED_HIGH + 1;
    for (const src of [first, second, third]) for (let i = 0; i < 100; i++) src.emit();
    const named = (src: FakeSource, id: string): FeedSource => ({ eventsAfter: function* (n) { for (const e of src.eventsAfter(n)) yield { ...e, sessionId: id }; }, subscribe: (since, l) => src.subscribe(since, l) });
    // Requested first, second, third; the lookups finished third, first, second.
    feeds.follow(named(third, "third"), 0, true, 3);
    feeds.follow(named(first, "first"), 0, true, 1);
    feeds.follow(named(second, "second"), 0, true, 2);
    c.bufferedAmount = 0;
    vi.advanceTimersByTime(60);
    const order = sent.map((e) => e.sessionId);
    expect(order.slice(0, 100)).toEqual(Array(100).fill("first"));
    expect(order.slice(100, 150)).toEqual(Array(50).fill("second"));
    expect(order.slice(150, 200)).toEqual(Array(50).fill("third"));
  });

  it("writes a long replay in pieces: never more than HIGH + one event above the buffer, and every event arrives once", () => {
    const s = new FakeSource();
    for (let i = 0; i < 2000; i++) s.emit();
    const { c, sent, send } = conn(5_000); // 10 MB of events
    let peak = 0;
    const feeds = createFeeds(c, (e) => (send(e), (peak = Math.max(peak, c.bufferedAmount))));
    feeds.follow(s, 0, true);
    expect(sent.length).toBeLessThan(2000);
    for (let t = 0; t < 400 && sent.length < 2000; t++) {
      c.bufferedAmount = Math.max(0, c.bufferedAmount - 200_000); // the link drains 200 KB per 50 ms
      vi.advanceTimersByTime(50);
    }
    expect(sent.map((e) => e.seq)).toEqual(Array.from({ length: 2000 }, (_, i) => i + 1));
    expect(peak).toBeLessThanOrEqual(FEED_HIGH + 5_000);
  });

  it("stops the timer when the feed is stopped while paused", () => {
    const s = new FakeSource();
    const { c, sent, send } = conn();
    const feeds = createFeeds(c, send);
    const stop = feeds.follow(s, 0, true);
    c.bufferedAmount = FEED_HIGH + 1;
    s.emit();
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    c.bufferedAmount = 0;
    vi.advanceTimersByTime(200);
    s.emit();
    expect(sent).toHaveLength(0);
    expect(s.listeners.size).toBe(0);
  });

  it("sends nothing to a closed connection and stops its timer", () => {
    const s = new FakeSource();
    const { c, sent, send } = conn();
    const feeds = createFeeds(c, send);
    feeds.follow(s, 0, true);
    c.bufferedAmount = FEED_HIGH + 1;
    s.emit();
    c.readyState = 3;
    c.bufferedAmount = 0;
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
