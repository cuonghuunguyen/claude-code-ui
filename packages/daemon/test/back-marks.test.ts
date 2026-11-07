import { describe, expect, it } from "vitest";
import { briefPrompt, checkSet, marksOk, total, upsert } from "../src/back-marks.ts";
import { checkPatch, createSettings } from "../src/settings.ts";

const base = { partId: "m1:0", title: "Done" };
describe("back marks", () => {
  it("upsert makes a new mark, then keeps its time and updates the note", () => {
    const list: any[] = [];
    const a = upsert(list, { ...base, note: "x" }, 10);
    expect(a.isNew).toBe(true);
    const b = upsert(list, { ...base, title: "T2" }, 20);
    expect(b.isNew).toBe(false);
    expect(list).toEqual([{ partId: "m1:0", at: 10, title: "T2", note: "x" }]);
    upsert(list, { ...base, note: "" }, 30);
    expect(list[0].note).toBeUndefined();
  });
  it("remindMs sets remindAt on the daemon clock, re-arms a fired one, null clears", () => {
    const list: any[] = [];
    upsert(list, { ...base, remindMs: 120_000 }, 1000);
    expect(list[0]).toMatchObject({ remindMs: 120_000, remindAt: 121_000 });
    list[0].remindedAt = 5;
    upsert(list, { ...base, remindMs: 120_000 }, 9000);
    expect(list[0].remindedAt).toBeUndefined();
    expect(list[0].remindAt).toBe(129_000);
    upsert(list, { ...base, remindMs: null }, 9500);
    expect(list[0].remindMs).toBeUndefined();
    expect(list[0].remindAt).toBeUndefined();
  });
  it("checkSet enforces caps and the interval range", () => {
    expect(checkSet(base)).toBeUndefined();
    expect(checkSet({ ...base, title: "x".repeat(201) })).toMatch(/title/);
    expect(checkSet({ ...base, note: "x".repeat(281) })).toMatch(/note/);
    expect(checkSet({ ...base, remindMs: 59_999 })).toMatch(/remindMs/);
    expect(checkSet({ ...base, remindMs: 7 * 86_400_000 + 1 })).toMatch(/remindMs/);
    expect(checkSet({ ...base, remindMs: 1.5 })).toMatch(/remindMs/);
    expect(checkSet({ ...base, remindMs: 60_000 })).toBeUndefined();
    expect(checkSet({ ...base, remindMs: 7 * 86_400_000 })).toBeUndefined();
    expect(checkSet({ ...base, remindMs: null })).toBeUndefined();
  });
  it("marksOk limits the total to 200 marks and one per part", () => {
    const m = (i: number) => ({ partId: `p${i}`, at: 1, title: "t" });
    expect(marksOk({ s: Array.from({ length: 200 }, (_, i) => m(i)) })).toBe(true);
    expect(marksOk({ s: Array.from({ length: 200 }, (_, i) => m(i)), t: [m(1)] })).toBe(false);
    expect(marksOk({ s: [m(1), m(1)] })).toBe(false);
    expect(total({ a: [m(1)], b: [m(2), m(3)] })).toBe(3);
  });
  it("prompt carries the tag, the title and the refresh line", () => {
    const p = briefPrompt("msg_01:0", 'Fix "it"', false);
    expect(p.split("\n")[0]).toBe('<claude-ui-brief part="msg_01:0"/>');
    expect(p).toContain('starts with "Fix  it "');
    expect(p).not.toContain("This is a refresh");
    expect(briefPrompt("a", "b", true)).toContain("This is a refresh");
  });
  it("settings.set refuses back; changeMarks persists and is read back", () => {
    expect(checkPatch({ back: { marks: {} } })).toMatch(/back\.set/);
    const s = createSettings();
    s.changeMarks((m) => void (m.s = [{ partId: "p", at: 1, title: "t" }]));
    expect(s.get().back.marks.s).toHaveLength(1);
    s.changeMarks((m) => void delete m.s);
    expect(s.get().back.marks).toEqual({});
  });
});
