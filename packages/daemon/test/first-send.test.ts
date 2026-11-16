import { expect, it, vi } from "vitest";
import { createFirstSend, sendOnce } from "../src/first-send.ts";

it("a repeat with the same key gets the first outcome, reply included, without sending again (also a queued bash item)", async () => {
  const f = createFirstSend();
  const send = vi.fn(async () => ({ reply: { itemId: "q1" } }));
  const [a, b] = await Promise.all([sendOnce(f, "s1", "k", send), sendOnce(f, "s1", "k", send)]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(a).toEqual(b);
  expect(b.reply).toEqual({ itemId: "q1" });
});

it("a failed send is forgotten (retry runs); a success spends the draft token", async () => {
  const f = createFirstSend();
  f.byDraft.set("d", "s1");
  const send = vi.fn().mockResolvedValueOnce({ err: { code: "x", message: "no" } }).mockResolvedValueOnce({ reply: {} });
  expect((await sendOnce(f, "s1", "k", send)).err?.code).toBe("x");
  expect(f.byDraft.get("d")).toBe("s1");
  expect((await sendOnce(f, "s1", "k", send)).err).toBeUndefined();
  expect(send).toHaveBeenCalledTimes(2);
  expect(f.byDraft.has("d")).toBe(false);
});
