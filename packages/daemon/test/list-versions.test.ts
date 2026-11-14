import { describe, expect, it } from "vitest";
import { createListVersions, LIST_VERSIONS_KEPT } from "../src/list-versions.ts";

const row = (id: string, title = id) => ({ id, title });
const list = (rows: { id: string; title: string }[], projects = ["/p"]) => ({ sessions: rows, projects });

describe("list versions", () => {
  it("answers the full result with a version when no since is given", () => {
    const v = createListVersions("e");
    const r = v.encode(list([row("a"), row("b")]));
    expect(r).toEqual({ sessions: [row("a"), row("b")], projects: ["/p"], version: "e:1" });
    expect(r.delta).toBeUndefined();
  });

  it("keeps the version of a result equal to the newest and answers a delta without rows", () => {
    const v = createListVersions("e");
    const first = v.encode(list([row("a"), row("b")]));
    const again = v.encode(list([row("a"), row("b")]), first.version);
    expect(again.version).toBe(first.version);
    expect(again).toMatchObject({ delta: true, ids: ["a", "b"], sessions: [], projects: ["/p"] });
  });

  it("sends only a changed or added row, with every id in list order", () => {
    const v = createListVersions("e");
    const first = v.encode(list([row("a"), row("b")]));
    const next = v.encode(list([row("c"), row("a", "renamed"), row("b")]), first.version);
    expect(next.version).not.toBe(first.version);
    expect(next.delta).toBe(true);
    expect(next.ids).toEqual(["c", "a", "b"]);
    expect(next.sessions).toEqual([row("c"), row("a", "renamed")]);
  });

  it("leaves a removed id out of ids", () => {
    const v = createListVersions("e");
    const first = v.encode(list([row("a"), row("b")]));
    const next = v.encode(list([row("b")]), first.version);
    expect(next.ids).toEqual(["b"]);
    expect(next.sessions).toEqual([]);
  });

  it("reflects an order change in ids and a change of the other fields as a new version", () => {
    const v = createListVersions("e");
    const first = v.encode(list([row("a"), row("b")]));
    const swapped = v.encode(list([row("b"), row("a")]), first.version);
    expect(swapped.version).not.toBe(first.version);
    expect(swapped.ids).toEqual(["b", "a"]);
    expect(swapped.sessions).toEqual([]);
    const other = v.encode(list([row("b"), row("a")], ["/p", "/q"]), swapped.version);
    expect(other.version).not.toBe(swapped.version);
    expect(other).toMatchObject({ delta: true, projects: ["/p", "/q"], sessions: [] });
  });

  it("answers a delta against an older held version", () => {
    const v = createListVersions("e");
    const first = v.encode(list([row("a")]));
    v.encode(list([row("a"), row("b")]), first.version);
    const third = v.encode(list([row("a"), row("b", "x")]), first.version);
    expect(third.sessions).toEqual([row("b", "x")]);
  });

  it("answers the full result for an unknown since", () => {
    const v = createListVersions("e");
    v.encode(list([row("a")]));
    const r = v.encode(list([row("a")]), "other-epoch:1");
    expect(r.delta).toBeUndefined();
    expect(r.sessions).toEqual([row("a")]);
    expect(r.version).toBe("e:1");
  });

  it("evicts the oldest version after the kept count", () => {
    const v = createListVersions("e");
    const first = v.encode(list([row("s0")]));
    for (let i = 1; i < LIST_VERSIONS_KEPT; i++) v.encode(list([row(`s${i}`)]));
    expect(v.encode(list([row("x")]), first.version).delta).toBeUndefined(); // 9th version evicted the 1st
    const second = v.encode(list([row("x")]), "e:2");
    expect(second.delta).toBe(true);
  });
});
