// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Event, SessionState } from "@claude-ui/protocol";
import { applyEvent, emptySession, withSubscribe } from "./store.ts";
import { closedUnread, isUnread, loadShownActivity, saveShownActivity, seenNow, tabTitle } from "./unread.ts";

const state = (seq: number, s: SessionState): Event => ({ type: "event", sessionId: "s", seq, part: { type: "session_state", id: "session_state", state: s } });
const run = (...states: SessionState[]) => states.reduce((v, s, i) => applyEvent(v, state(i + 1, s)), withSubscribe(emptySession(), { logEpoch: "e1", seq: 0, session: { id: "s", cwd: "/", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: [] } }));

describe("unread", () => {
  it("a session is unread after it needs input or finishes (an error counts) until it is seen", () => {
    expect(isUnread(run("running"), undefined)).toBe(false);
    expect(isUnread(run("running", "needs_input"), undefined)).toBe(true);
    expect(isUnread(run("running", "idle"), undefined)).toBe(true);
    expect(isUnread(run("running", "error"), undefined)).toBe(true);
    // A restored session only replays its final idle: nothing happened since.
    expect(isUnread(run("idle"), undefined)).toBe(false);
  });

  it("seeing the session clears it; a later finish marks it again", () => {
    const v = run("running", "idle");
    const seen = seenNow(v);
    expect(isUnread(v, seen)).toBe(false);
    const later = applyEvent(applyEvent(v, state(3, "running")), state(4, "idle"));
    expect(isUnread(later, seen)).toBe(true);
  });

  it("a seen mark from an earlier daemon run (other logEpoch) does not hide new work", () => {
    const seen = { epoch: "old", seq: 99 };
    expect(isUnread(run("running", "idle"), seen)).toBe(true);
  });

  it("the tab title carries the unread count", () => {
    expect(tabTitle(0)).toBe("Claude UI");
    expect(tabTitle(3)).toBe("(3) Claude UI");
  });

  it("GH-378 a session not loaded in this daemon run is unread when its list lastActivity is after the one this browser last showed; unknown without a record", () => {
    expect(closedUnread(200, 150)).toBe(true);
    expect(closedUnread(150, 150)).toBe(false);
    expect(closedUnread(100, 150)).toBe(false);
    expect(closedUnread(100, undefined)).toBeUndefined();
  });

  it("GH-378 the shown lastActivity records of two windows merge (max per session)", () => {
    localStorage.clear();
    saveShownActivity({ a: 100, b: 300 });
    saveShownActivity({ a: 200, b: 100 });
    expect(loadShownActivity()).toEqual({ a: 200, b: 300 });
    localStorage.setItem("claude-ui.shown-activity", "nonsense");
    expect(loadShownActivity()).toEqual({});
  });
});
