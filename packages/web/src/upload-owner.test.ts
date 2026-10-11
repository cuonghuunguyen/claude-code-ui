import { expect, it } from "vitest";
import { DRAFT_TOKEN } from "@claude-ui/protocol";
import { draftToken, newDraftToken, rotateDraftToken } from "./upload-owner.ts";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

it("newDraftToken is 64 lowercase hex characters", () => {
  const t = newDraftToken((a) => (a.fill(0xab), a));
  expect(t).toBe("ab".repeat(32));
  expect(t).toMatch(DRAFT_TOKEN);
  expect(newDraftToken()).toMatch(DRAFT_TOKEN);
});

it("draftToken keeps one token per tab; rotateDraftToken replaces it", () => {
  const store = memory();
  const a = draftToken(store);
  expect(draftToken(store)).toBe(a);
  const b = rotateDraftToken(store);
  expect(b).not.toBe(a);
  expect(b).toMatch(DRAFT_TOKEN);
  expect(draftToken(store)).toBe(b);
});

it("a storage that throws still gives a valid token", () => {
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  expect(draftToken(broken)).toMatch(DRAFT_TOKEN);
  expect(rotateDraftToken(broken)).toMatch(DRAFT_TOKEN);
});
