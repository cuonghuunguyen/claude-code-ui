import { expect, it } from "vitest";
import { DRAFT_TOKEN } from "@claude-ui/protocol";
import { draftToken, newDraftToken, rotateDraftToken, uploadOwnerFor, uploadWithRetry } from "./upload-owner.ts";
import { vi } from "vitest";

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

it("uploadOwnerFor: the unprompted session of the same project by sessionId, else the draft token", () => {
  const T = "e".repeat(64);
  expect(uploadOwnerFor({ id: "s1", cwd: "/p/a" }, "/p/a", T)).toEqual({ sessionId: "s1" });
  expect(uploadOwnerFor({ id: "s1", cwd: "/p/a" }, "/p/b", T)).toEqual({ draft: T });
  expect(uploadOwnerFor(undefined, "/p/a", T)).toEqual({ draft: T });
});

it("uploadWithRetry: a spent draft token is rotated and the upload retried once; other errors and session uploads are not retried", async () => {
  const spent = Object.assign(new Error("draft already used"), { code: "draft_claimed" });
  const send = vi.fn(async (o: { draft?: string; sessionId?: string }) => {
    if (o.draft === "old") throw spent;
    return "/path";
  });
  const owner = { current: "old" };
  const rotate = vi.fn(() => (owner.current = "new"));
  expect(await uploadWithRetry(send, () => ({ draft: owner.current }), rotate)).toBe("/path");
  expect(send.mock.calls.map((c) => c[0])).toEqual([{ draft: "old" }, { draft: "new" }]);
  expect(rotate).toHaveBeenCalledTimes(1);
  // Still refused after the retry: the error shows.
  const always = vi.fn(async () => { throw spent; });
  await expect(uploadWithRetry(always, () => ({ draft: "x" }), rotate)).rejects.toBe(spent);
  expect(always).toHaveBeenCalledTimes(2);
  const other = vi.fn(async () => { throw Object.assign(new Error("big"), { code: "too_large" }); });
  await expect(uploadWithRetry(other, () => ({ draft: "x" }), rotate)).rejects.toThrow("big");
  expect(other).toHaveBeenCalledTimes(1);
  const bySession = vi.fn(async () => { throw spent; });
  await expect(uploadWithRetry(bySession, () => ({ sessionId: "s" }), rotate)).rejects.toBe(spent);
  expect(bySession).toHaveBeenCalledTimes(1);
});
