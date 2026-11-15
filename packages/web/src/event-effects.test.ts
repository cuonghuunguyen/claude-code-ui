import type { Event, Part, SessionState } from "@claude-ui/protocol";
import { describe, expect, it } from "vitest";
import { createEventEffects, type Effect, type EffectsHost } from "./event-effects.ts";

const state = (sessionId: string, seq: number, s: SessionState): Event => ({ type: "event", sessionId, seq, part: { type: "session_state", id: "state", state: s } });
const usage = (sessionId: string, seq: number): Event => ({ type: "event", sessionId, seq, part: { type: "context_usage", id: "context_usage", usage: { percentage: 81 } } as Part });
const cleared = (sessionId: string, seq: number, to: string): Event => ({ type: "event", sessionId, seq, part: { type: "session_cleared", id: "c", sessionId: to } });

function setup(over: Partial<EffectsHost> = {}) {
  let t = 1_000_000;
  const host: EffectsHost = { pageVisible: () => true, onScreen: () => true, untitled: () => false, replayedTo: () => 0, ...over };
  const fx = createEventEffects(host, () => t);
  const all = (es: Effect[]) => es.map((e) => e.type).filter((x) => x !== "notify");
  /** Without the list refresh that every live session_state asks for. */
  const types = (es: Effect[]) => all(es).filter((x) => x !== "refreshList");
  return { fx, types, all, advance: (ms: number) => (t += ms) };
}

describe("attention (push) rule", () => {
  it("a live attention while the page is hidden sets the push need and offers nothing yet", () => {
    const { fx, types } = setup({ pageVisible: () => false });
    expect(types(fx.classify([state("a", 1, "needs_input")], () => "running"))).toEqual([]);
    expect(fx.takeHiddenNeed()).toBe(true);
    expect(fx.takeHiddenNeed()).toBe(false);
  });

  it("a live attention while the page is visible sets no need", () => {
    const { fx } = setup();
    fx.classify([state("a", 1, "needs_input")], () => "running");
    expect(fx.takeHiddenNeed()).toBe(false);
  });

  it("a replayed attention within 3 s after a reconnect that followed a hidden page offers the push", () => {
    const { fx, types, advance } = setup({ replayedTo: () => 10 });
    fx.pageHidden();
    fx.opened(2);
    advance(2999);
    const out = fx.classify([state("a", 5, "needs_input")], () => "running");
    expect(types(out)).toEqual(["offerPush"]);
    expect(out.find((e) => e.type === "offerPush")).toEqual({ type: "offerPush", afterMs: 800 });
    expect(fx.takeHiddenNeed()).toBe(true);
  });

  it.each([
    ["outside the window", true, 3000],
    ["without a hidden page", false, 0],
  ])("a replayed attention %s emits nothing", (_n, hidden, wait) => {
    const { fx, types, advance } = setup({ replayedTo: () => 10 });
    if (hidden) fx.pageHidden();
    fx.opened(2);
    advance(wait);
    expect(types(fx.classify([state("a", 5, "needs_input")], () => "running"))).toEqual([]);
    expect(fx.takeHiddenNeed()).toBe(false);
  });

  it("the page's first connection opens no replay window", () => {
    const { fx, types } = setup({ replayedTo: () => 10 });
    fx.pageHidden();
    fx.opened(1);
    expect(types(fx.classify([state("a", 5, "needs_input")], () => "running"))).toEqual([]);
  });

  it("tracks the state through the batch: idle after running is attention once", () => {
    const { fx } = setup({ pageVisible: () => false });
    fx.classify([state("a", 1, "idle"), state("a", 2, "idle")], () => "idle");
    expect(fx.takeHiddenNeed()).toBe(false);
    fx.classify([state("a", 3, "running"), state("a", 4, "idle")], () => "idle");
    expect(fx.takeHiddenNeed()).toBe(true);
  });
});

describe("recommendation (context breakdown) rule", () => {
  const turn = (fx: ReturnType<typeof setup>["fx"], id = "a") => fx.classify([state(id, 1, "running"), state(id, 2, "idle")], () => "idle");

  it("a prompt sent here, a live turn end and a live context_usage offer the breakdown once", () => {
    const { fx, types } = setup({ onScreen: (id) => id === "a" });
    fx.sent("a");
    turn(fx);
    const out = fx.classify([usage("a", 3)], () => "idle");
    expect(out.filter((e) => e.type === "offerContextBreakdown")).toEqual([{ type: "offerContextBreakdown", sessionId: "a", visible: true, percent: 81 }]);
    expect(types(fx.classify([usage("a", 4)], () => "idle"))).toEqual([]);
  });

  it("visible is false for a hidden page or a session not on screen", () => {
    for (const host of [{ pageVisible: () => false }, { onScreen: () => false }]) {
      const { fx } = setup(host);
      fx.sent("a");
      turn(fx);
      const out = fx.classify([usage("a", 3)], () => "idle");
      expect(out.find((e) => e.type === "offerContextBreakdown")).toMatchObject({ visible: false });
    }
  });

  it.each([
    ["a turn not sent here", false, 0],
    ["a replayed context_usage", true, 100],
  ])("%s offers nothing", (_n, sent, replayed) => {
    const { fx, types } = setup({ replayedTo: (id) => (id === "a" && replayed ? replayed : 0) });
    if (sent) fx.sent("a");
    if (!replayed) turn(fx);
    expect(types(fx.classify([usage("a", 3)], () => "idle"))).toEqual([]);
  });

  it("a new running turn before the usage drops the waiting rule", () => {
    const { fx, types } = setup();
    fx.sent("a");
    turn(fx);
    fx.classify([state("a", 3, "running")], () => "idle");
    expect(types(fx.classify([usage("a", 4)], () => "idle"))).toEqual([]);
  });
});

describe("/clear and list refresh", () => {
  it("a live session_cleared moves the tab, a replayed one does not", () => {
    const live = setup();
    expect(live.types(live.fx.classify([cleared("a", 1, "b")], () => "idle"))).toEqual(["clearMoved"]);
    const { fx, types } = setup({ replayedTo: () => 5 });
    expect(types(fx.classify([cleared("a", 1, "b")], () => "idle"))).toEqual([]);
  });

  it("a live session_state asks for one list refresh per batch, a replayed one none", () => {
    const { fx, all } = setup();
    expect(all(fx.classify([state("a", 1, "running"), state("b", 1, "running")], () => "idle"))).toEqual(["refreshList"]);
    const replay = setup({ replayedTo: () => 9 });
    expect(replay.all(replay.fx.classify([state("a", 1, "running")], () => "idle"))).toEqual([]);
  });

  it("an untitled session refreshes the list at most every 2 s", () => {
    const { fx, all: types, advance } = setup({ untitled: () => true });
    const text = (seq: number): Event => ({ type: "event", sessionId: "a", seq, part: { type: "assistant_text", id: `t${seq}`, text: "x" } as Part });
    expect(types(fx.classify([text(1)], () => "idle"))).toEqual(["refreshList"]);
    advance(1500);
    expect(types(fx.classify([text(2)], () => "idle"))).toEqual([]);
    advance(600);
    expect(types(fx.classify([text(3)], () => "idle"))).toEqual(["refreshList"]);
  });

  it("every event is reported to notify with its liveness and marks its session live", () => {
    const { fx } = setup({ replayedTo: (id) => (id === "old" ? 9 : 0) });
    const out = fx.classify([state("old", 1, "idle"), state("new", 1, "idle")], () => "idle");
    expect(out.filter((e) => e.type === "notify").map((e) => (e as { live: boolean }).live)).toEqual([false, true]);
    expect(fx.lastLive("old")).toBe(0);
    expect(fx.lastLive("new")).toBeGreaterThan(0);
  });
});
