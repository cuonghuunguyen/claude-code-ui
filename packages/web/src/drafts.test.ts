import { describe, expect, it } from "vitest";
import { clearDrafts, loadDraft, MAX_DRAFTS, saveDraft } from "./drafts.ts";

const memory = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

describe("drafts", () => {
  it("saves and loads per key; empty text removes the draft", () => {
    const s = memory();
    saveDraft("a", "hello", s);
    saveDraft("b", "world", s);
    expect(loadDraft("a", s)).toBe("hello");
    expect(loadDraft("b", s)).toBe("world");
    expect(loadDraft("c", s)).toBe("");
    saveDraft("a", "", s);
    expect(loadDraft("a", s)).toBe("");
    expect(s.m.has("claude-ui.draft.a")).toBe(false);
  });

  it("keeps the 30 most recently saved drafts", () => {
    const s = memory();
    for (let i = 0; i < MAX_DRAFTS + 5; i++) saveDraft(`k${i}`, `t${i}`, s, 1000 + i);
    expect(loadDraft("k0", s)).toBe("");
    expect(loadDraft("k4", s)).toBe("");
    expect(loadDraft("k5", s)).toBe("t5");
    expect(loadDraft(`k${MAX_DRAFTS + 4}`, s)).toBe(`t${MAX_DRAFTS + 4}`);
    expect([...s.m.keys()].filter((k) => k.startsWith("claude-ui.draft."))).toHaveLength(MAX_DRAFTS);
    // Saving an old one again makes it recent.
    saveDraft("k5", "again", s, 5000);
    saveDraft("new", "x", s, 5001);
    expect(loadDraft("k5", s)).toBe("again");
    expect(loadDraft("k6", s)).toBe("");
  });

  it("clearDrafts removes every draft and the index, nothing else", () => {
    const s = memory();
    s.setItem("claude-ui.token", "tok");
    saveDraft("a", "1", s);
    saveDraft("b", "2", s);
    clearDrafts(s);
    expect([...s.m.keys()]).toEqual(["claude-ui.token"]);
  });

  it("survives a storage that throws", () => {
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(() => saveDraft("a", "x", bad)).not.toThrow();
    expect(loadDraft("a", bad)).toBe("");
    expect(() => clearDrafts(bad)).not.toThrow();
  });
});
