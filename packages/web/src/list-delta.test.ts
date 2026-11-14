import { describe, expect, it } from "vitest";
import { applyListReply } from "./list-delta.ts";

const row = (id: string, title = id) => ({ id, title });

describe("applyListReply", () => {
  it("takes the sessions of a whole reply", () => {
    expect(applyListReply([row("old")], { sessions: [row("a"), row("b")] })).toEqual([row("a"), row("b")]);
    expect(applyListReply(undefined, { sessions: [row("a")] })).toEqual([row("a")]);
  });

  it("updates a changed row, adds a new one and orders by ids", () => {
    const base = [row("a"), row("b"), row("c")];
    expect(applyListReply(base, { delta: true, ids: ["c", "a", "d", "b"], sessions: [row("a", "renamed"), row("d")] })).toEqual([row("c"), row("a", "renamed"), row("d"), row("b")]);
  });

  it("drops a row whose id is no longer listed", () => {
    expect(applyListReply([row("a"), row("b")], { delta: true, ids: ["b"], sessions: [] })).toEqual([row("b")]);
  });

  it("gives undefined when a listed id has no known row or there is no base", () => {
    expect(applyListReply([row("a")], { delta: true, ids: ["a", "x"], sessions: [] })).toBeUndefined();
    expect(applyListReply(undefined, { delta: true, ids: [], sessions: [] })).toBeUndefined();
    expect(applyListReply([row("a")], { delta: true, sessions: [] })).toBeUndefined();
  });
});
