import { describe, expect, it } from "vitest";
import { reloadOnStalePage } from "./preload-reload.ts";

const setup = () => {
  const target = new EventTarget();
  const m = new Map<string, string>();
  const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  let reloads = 0;
  reloadOnStalePage(target as never, storage, () => reloads++);
  const fail = (message: string) => {
    const e = Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload: { message } });
    target.dispatchEvent(e);
    return e;
  };
  return { fail, reloads: () => reloads };
};

describe("reloadOnStalePage", () => {
  it("reloads once for a failing chunk and not again for the same chunk", () => {
    const t = setup();
    expect(t.fail("Failed to fetch /assets/a-1.js").defaultPrevented).toBe(true);
    expect(t.reloads()).toBe(1);
    t.fail("Failed to fetch /assets/a-1.js");
    expect(t.reloads()).toBe(1);
  });

  it("reloads again for a different chunk", () => {
    const t = setup();
    t.fail("a");
    t.fail("b");
    expect(t.reloads()).toBe(2);
  });
});
