import { describe, expect, it } from "vitest";
import type { Event, Part } from "@claude-ui/protocol";
import { clearing, heirView, isClearCommand } from "./clear.ts";
import { addPending } from "./optimistic.ts";
import { applyEvent, emptySession, type SessionView } from "./store.ts";

const ev = (seq: number, part: Part): Event => ({ type: "event", sessionId: "s", seq, part });
const said = (v: SessionView, id: string, text: string, extra: object = {}) => applyEvent(v, ev(v.lastSeq + 1, { type: "user_text", id, text, images: [], ...extra } as Part));
const state = (v: SessionView, s: "idle" | "running") => applyEvent(v, ev(v.lastSeq + 1, { type: "session_state", id: `st${v.lastSeq}`, state: s } as Part));

describe("isClearCommand", () => {
  it.each(["/clear", "/reset", "/new", " /clear "])("%j is a clear command", (t) => expect(isClearCommand(t)).toBe(true));
  it.each(["/clear now", "/compact", "clear", ""])("%j is not", (t) => expect(isClearCommand(t)).toBe(false));
});

describe("clearing", () => {
  it("a running session whose last prompt is /clear is clearing", () => {
    expect(clearing(state(said(emptySession(), "u1", "/clear"), "running"))).toBe(true);
  });
  it("an idle one is not", () => {
    expect(clearing(said(emptySession(), "u1", "/clear"))).toBe(false);
  });
  it("another prompt running is not", () => {
    expect(clearing(state(said(said(emptySession(), "u1", "/clear"), "u2", "hello"), "running"))).toBe(false);
  });
  it("a sent /clear not echoed yet is clearing; once echoed it follows the view", () => {
    const v0 = emptySession();
    const pending = addPending(undefined, v0, { key: "k", text: "/clear", images: [] });
    expect(clearing(v0, pending)).toBe(true);
    expect(clearing(said(v0, "u1", "/clear"), pending)).toBe(false);
    expect(clearing(state(said(v0, "u1", "/clear"), "running"), pending)).toBe(true);
  });
  it("a subagent's prompt is ignored", () => {
    expect(clearing(state(said(said(emptySession(), "u1", "/clear"), "u2", "hi", { parentId: "t1" }), "running"))).toBe(true);
  });
  it("no view is not clearing", () => {
    expect(clearing(undefined)).toBe(false);
  });
});

describe("heirView", () => {
  it("carries the settings and commands of the old view with an empty timeline", () => {
    const old = { ...state(said(emptySession(), "u1", "hi"), "running"), commands: [{ name: "x", description: "", argumentHint: "" }], model: "haiku", permissionMode: "plan" as const, effort: "high" as const };
    const v = heirView(old);
    expect(v).toMatchObject({ commands: old.commands, model: "haiku", permissionMode: "plan", effort: "high", state: "idle", lastSeq: 0, order: [] });
    expect(v.parts.size).toBe(0);
  });
  it("without an old view is an empty one", () => {
    expect(heirView(undefined)).toMatchObject({ commands: [], order: [], lastSeq: 0 });
  });
});
