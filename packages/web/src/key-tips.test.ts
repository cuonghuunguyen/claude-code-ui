import { describe, expect, it } from "vitest";
import { EMPTY, countClick, loadKeyTips, markUsed, parseKeyTips, resetKeyTips, saveKeyTips, withOff, type KeyTipsState } from "./key-tips.ts";

const clicks = (s: KeyTipsState, id: string, n: number) => {
  const tips: number[] = [];
  for (let i = 1; i <= n; i++) {
    const r = countClick(s, id);
    s = r.state;
    if (r.tip) tips.push(i);
  }
  return { s, tips };
};

describe("key tips counters", () => {
  it("tips at the 2nd, 5th and 10th click only", () => {
    const r = clicks(EMPTY, "sidebar.toggle", 12);
    expect(r.tips).toEqual([2, 5, 10]);
    expect(r.s.counts["sidebar.toggle"]).toBe(10);
  });

  it("counts are per command", () => {
    let s = clicks(EMPTY, "a", 2).s;
    const b = countClick(s, "b");
    expect(b.tip).toBe(false);
    s = b.state;
    expect(clicks(s, "a", 1).tips).toEqual([]);
  });

  it("a used shortcut ends the tips of that command only", () => {
    const s = markUsed(EMPTY, "a");
    const r = clicks(s, "a", 10);
    expect(r.tips).toEqual([]);
    expect(r.s.counts).toEqual({});
    expect(clicks(r.s, "b", 2).tips).toEqual([2]);
  });

  it("off stops every tip and every count", () => {
    const off = withOff(EMPTY, true);
    const r = clicks(off, "a", 10);
    expect(r.tips).toEqual([]);
    expect(r.s.counts).toEqual({});
    expect("off" in withOff(off, false)).toBe(false);
  });

  it("reset clears counts and learned and turns tips on", () => {
    const s = withOff(markUsed(clicks(EMPTY, "a", 3).s, "b"), true);
    expect(resetKeyTips()).toEqual({ v: 1, counts: {}, learned: [] });
    expect(s.off).toBe(true);
  });
});

describe("key tips storage", () => {
  it("parse: absent, corrupt, wrong version give the default; bad counts and learned entries are dropped", () => {
    expect(parseKeyTips(null)).toEqual(EMPTY);
    expect(parseKeyTips("{")).toEqual(EMPTY);
    expect(parseKeyTips('{"v":2}')).toEqual(EMPTY);
    expect(parseKeyTips('{"v":1,"counts":{"a":3,"b":"x","c":99,"d":0},"learned":["a",1,"a"],"off":true}')).toEqual({ v: 1, off: true, counts: { a: 3 }, learned: ["a"] });
  });

  it("storage that throws keeps the state for the page", () => {
    const stub = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    const s = markUsed(EMPTY, "a");
    saveKeyTips(s, stub);
    expect(loadKeyTips(stub)).toEqual(s);
  });

  it("round trips through storage", () => {
    const store = new Map<string, string>();
    const stub = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as unknown as Storage;
    const s = withOff(clicks(EMPTY, "a", 3).s, true);
    saveKeyTips(s, stub);
    expect(JSON.parse(store.get("claude-ui.key-tips")!)).toEqual({ v: 1, off: true, counts: { a: 3 }, learned: [] });
    expect(loadKeyTips(stub)).toEqual(s);
  });
});

it("a failed write keeps the state in memory while reads still work (full storage)", () => {
  const store = new Map<string, string>([["claude-ui.key-tips", JSON.stringify({ v: 1, counts: { a: 1 }, learned: [] })]]);
  const full = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: () => {
      throw new Error("quota");
    },
  } as unknown as Storage;
  expect(loadKeyTips(full).counts).toEqual({ a: 1 });
  const next = withOff(clicks(loadKeyTips(full), "a", 1).s, true);
  saveKeyTips(next, full);
  expect(loadKeyTips(full)).toEqual(next);
  expect(loadKeyTips(full).off).toBe(true);
  // A later successful write hands the state back to storage.
  const ok = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as unknown as Storage;
  saveKeyTips(EMPTY, ok);
  expect(loadKeyTips(ok)).toEqual(EMPTY);
});
