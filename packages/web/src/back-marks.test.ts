import { beforeEach, describe, expect, it } from "vitest";
import type { Part } from "@claude-ui/protocol";
import { aboutOf, briefTag, fallbackBrief, foldBriefTurns, formatInterval, onFired, parseBrief, parseInterval, resetBack, setBack, staleTurns } from "./back-marks.ts";

const user = (id: string, text: string): Part => ({ type: "user_text", id, text, images: [] });
const asst = (id: string, text: string): Part => ({ type: "assistant_text", id, text, streaming: false });

describe("parseInterval", () => {
  it.each([
    ["30m", 1_800_000],
    ["2H", 7_200_000],
    [" 1d ", 86_400_000],
    ["7d", 7 * 86_400_000],
    ["1 m", 60_000],
  ])("%s", (text, ms) => expect(parseInterval(text)).toEqual({ ms }));
  it.each([
    ["0m", "min"],
    ["8d", "max"],
    ["169h", "max"],
    ["1h30m", "format"],
    ["abc", "format"],
    ["2 hours", "format"],
    ["", "format"],
    ["-5m", "format"],
  ])("%s -> %s", (text, error) => expect(parseInterval(text)).toEqual({ error }));
  it("formatInterval gives the largest whole unit", () => {
    expect([formatInterval(7_200_000), formatInterval(5_400_000), formatInterval(86_400_000)]).toEqual(["2h", "90m", "1d"]);
  });
});

describe("brief", () => {
  const text = "About: A fix\nFocus now: the test\nNext: run it";
  it("parses the three lines, also wrapped ones; any other shape is undefined", () => {
    expect(parseBrief(text)).toEqual([{ label: "about", text: "A fix" }, { label: "focusNow", text: "the test" }, { label: "next", text: "run it" }]);
    expect(parseBrief("About: a\nmore\nFocus now: b\nNext: c")![0]!.text).toBe("a more");
    expect(parseBrief("Hello\nAbout: a")).toBeUndefined();
    expect(parseBrief("About: a\nNext: c")).toBeUndefined();
  });
  it("fallback uses prompt, last line and note, else the title and a default", () => {
    expect(fallbackBrief({ title: "T", prompt: "P", lastLine: "L", note: "N" }, "Open")).toEqual({ about: "P", lastReply: "L", next: "N" });
    expect(fallbackBrief({ title: "T" }, "Open")).toEqual({ about: "T", lastReply: "T", next: "Open" });
  });
  it("aboutOf reads the stored brief", () => {
    expect(aboutOf({ partId: "p", at: 1, title: "t", brief: { text, at: 1 } })).toBe("A fix");
    expect(aboutOf({ partId: "p", at: 1, title: "t" })).toBeUndefined();
  });
});

describe("tag, fold and stale count", () => {
  const tag = (id: string) => `<claude-ui-brief part="${id}"/>\nThe user marked`;
  it("detects the tag on the first line only", () => {
    expect(briefTag(tag("m1:0"))).toBe("m1:0");
    expect(briefTag("hello\n<claude-ui-brief part=\"m1:0\"/>")).toBeUndefined();
    expect(briefTag('<claude-ui-brief part="m1:0"/> trailing')).toBeUndefined();
  });
  it("counts prompts after the last brief turn of the mark, not brief turns", () => {
    const parts = [user("u1", "hi"), asst("m1:0", "r"), user("u2", tag("m1:0")), asst("a2", "About: ..."), user("u3", "next"), asst("a3", "x"), user("u4", tag("m9:0")), user("u5", "again")];
    expect(staleTurns(parts, "m1:0")).toBe(2);
    expect(staleTurns(parts, "none")).toBe(0);
  });
  it("fold hides the brief turn's text and tools, keeps its prompt and result, collects the answer", () => {
    const part = (p: Part) => ({ kind: "part", part: p });
    const items = [part(user("u1", "hi")), part(asst("a1", "reply")), part(user("u2", tag("m1:0"))), part(asst("a2", "About: x")), part({ type: "turn_result", id: "r2", durationMs: 1, usage: {} as never, isError: false }), part(user("u3", "next")), part(asst("a3", "ok"))];
    const r = foldBriefTurns(items);
    expect(r.items.map((i) => i.part!.id)).toEqual(["u1", "a1", "u2", "r2", "u3", "a3"]);
    expect(r.answers.get("u2")).toBe("About: x");
  });
});

describe("store", () => {
  beforeEach(resetBack);
  it("only a live change gives a fired card", () => {
    const got: string[] = [];
    const off = onFired((f) => got.push(...f.map((x) => x.mark.partId)));
    const m = (extra: object) => ({ marks: { s: [{ partId: "p", at: 1, title: "t", ...extra }] } });
    setBack(m({ remindedAt: 5 }), true);
    setBack(m({ remindedAt: 5, note: "x" }));
    expect(got).toEqual([]);
    setBack(m({ remindedAt: 9 }));
    expect(got).toEqual(["p"]);
    off();
  });
});
