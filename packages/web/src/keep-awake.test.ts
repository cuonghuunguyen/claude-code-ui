// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { anySessionRunning, createKeepAwake, loadKeepAwake, wakeLockReason, saveKeepAwake, subscribeKeepAwake, wakeLockSupported, type KeepAwakeStatus } from "./keep-awake.ts";

class Sentinel extends EventTarget {
  released = false;
  release = vi.fn(async () => {
    this.released = true;
    this.dispatchEvent(new Event("release"));
  });
}
function setup(opts: { reject?: string; hold?: boolean } = {}) {
  const sentinels: Sentinel[] = [];
  let resolve: (() => void) | undefined;
  const request = vi.fn(async () => {
    if (opts.reject) throw Object.assign(new Error("no"), { name: opts.reject });
    if (opts.hold) await new Promise<void>((r) => (resolve = r));
    const s = new Sentinel();
    sentinels.push(s);
    return s;
  });
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  const statuses: KeepAwakeStatus[] = [];
  const ctl = createKeepAwake({ wakeLock: { request } as never, doc: doc as never, onStatus: (s) => statuses.push(s) });
  const hide = (v: DocumentVisibilityState) => {
    doc.visibilityState = v;
    if (v === "hidden") sentinels.at(-1)?.dispatchEvent(new Event("release"));
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  return { request, sentinels, statuses, ctl, hide, doc, resolve: () => resolve?.() };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => (localStorage.clear(), vi.restoreAllMocks()));

describe("keep awake setting", () => {
  it("defaults to off, round-trips and notifies", () => {
    expect(loadKeepAwake()).toEqual({ on: false, onlyRunning: false });
    const l = vi.fn();
    const off = subscribeKeepAwake(l);
    saveKeepAwake({ on: true, onlyRunning: true });
    expect(l).toHaveBeenCalled();
    expect(loadKeepAwake()).toEqual({ on: true, onlyRunning: true });
    expect(JSON.parse(localStorage.getItem("claude-ui.keepAwake")!)).toEqual({ on: true, onlyRunning: true });
    off();
  });
  it("keeps the value in memory when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    saveKeepAwake({ on: true, onlyRunning: false });
    expect(loadKeepAwake().on).toBe(true);
  });
});

describe("anySessionRunning", () => {
  const item = (id: string, state: string, archived = false) => ({ id, state, archived }) as never;
  it("counts running and needs_input, not idle or archived", () => {
    expect(anySessionRunning([item("a", "idle")], {})).toBe(false);
    expect(anySessionRunning([item("a", "running")], {})).toBe(true);
    expect(anySessionRunning([item("a", "needs_input")], {})).toBe(true);
    expect(anySessionRunning([item("a", "running", true)], {})).toBe(false);
    expect(anySessionRunning([item("a", "idle")], { a: { state: "needs_input" } as never })).toBe(true);
  });
});

describe("wakeLockSupported", () => {
  it("needs a secure context and the API", () => {
    expect(wakeLockSupported({ wakeLock: { request() {} } } as never, { isSecureContext: true } as never)).toBe(true);
    expect(wakeLockSupported({ wakeLock: { request() {} } } as never, { isSecureContext: false } as never)).toBe(false);
    expect(wakeLockSupported({} as never, { isSecureContext: true } as never)).toBe(false);
  });
  it("a present but undefined or incomplete wakeLock is unsupported, not a TypeError", () => {
    expect(wakeLockSupported({ wakeLock: undefined } as never, { isSecureContext: true } as never)).toBe(false);
    expect(wakeLockSupported({ wakeLock: {} } as never, { isSecureContext: true } as never)).toBe(false);
  });
  it("the reason follows the secure context", () => {
    expect(wakeLockReason({ isSecureContext: false } as never)).toBe("needs HTTPS or localhost");
    expect(wakeLockReason({ isSecureContext: true } as never)).toBe("not supported by this browser");
  });
});

describe("keep awake controller", () => {
  it("requests once while visible and holds", async () => {
    const t = setup();
    t.ctl.update(true);
    t.ctl.update(true);
    await flush();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.statuses.at(-1)).toBe("held");
  });
  it("releases when turned off", async () => {
    const t = setup();
    t.ctl.update(true);
    await flush();
    t.ctl.update(false);
    await flush();
    expect(t.sentinels[0]!.release).toHaveBeenCalled();
    expect(t.statuses.at(-1)).toBe("off");
  });
  it("is idle after the page hides and re-requests when it shows", async () => {
    const t = setup();
    t.ctl.update(true);
    await flush();
    t.hide("hidden");
    await flush();
    expect(t.statuses.at(-1)).toBe("hidden");
    t.hide("visible");
    await flush();
    expect(t.request).toHaveBeenCalledTimes(2);
    expect(t.statuses.at(-1)).toBe("held");
  });
  it("makes no request while hidden", async () => {
    const t = setup();
    t.doc.visibilityState = "hidden";
    t.ctl.update(true);
    await flush();
    expect(t.request).not.toHaveBeenCalled();
    expect(t.statuses.at(-1)).toBe("hidden");
  });
  it("asks again when the browser drops the lock while the page is visible", async () => {
    const t = setup();
    t.ctl.update(true);
    await flush();
    t.sentinels[0]!.dispatchEvent(new Event("release"));
    await flush();
    expect(t.request).toHaveBeenCalledTimes(2);
    expect(t.statuses.at(-1)).toBe("held");
  });
  it("does not retry in a loop when the re-request after a drop is refused", async () => {
    const t = setup();
    t.ctl.update(true);
    await flush();
    t.request.mockRejectedValueOnce(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    t.sentinels[0]!.dispatchEvent(new Event("release"));
    await flush();
    await flush();
    expect(t.request).toHaveBeenCalledTimes(2);
    expect(t.statuses.at(-1)).toBe("refused");
  });
  it("reports a refusal without console noise or a retry loop", async () => {
    const t = setup({ reject: "NotAllowedError" });
    const err = vi.spyOn(console, "error");
    t.ctl.update(true);
    await flush();
    t.ctl.update(true);
    await flush();
    expect(t.statuses.at(-1)).toBe("refused");
    expect(t.ctl.error()).toBe("NotAllowedError");
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(err).not.toHaveBeenCalled();
    t.hide("visible");
    await flush();
    expect(t.request).toHaveBeenCalledTimes(2);
  });
  it("releases a request that resolves after turning off", async () => {
    const t = setup({ hold: true });
    t.ctl.update(true);
    t.ctl.update(false);
    t.resolve();
    await flush();
    expect(t.sentinels[0]!.release).toHaveBeenCalled();
    expect(t.statuses.at(-1)).toBe("off");
  });
  it("does not request while gated off", async () => {
    const t = setup();
    t.ctl.update(true, false);
    await flush();
    expect(t.request).not.toHaveBeenCalled();
    expect(t.statuses.at(-1)).toBe("idle");
    t.ctl.update(true, true);
    await flush();
    expect(t.statuses.at(-1)).toBe("held");
  });
  it("dispose releases and stops listening", async () => {
    const t = setup();
    t.ctl.update(true);
    await flush();
    t.ctl.dispose();
    await flush();
    expect(t.sentinels[0]!.release).toHaveBeenCalled();
    t.hide("visible");
    await flush();
    expect(t.request).toHaveBeenCalledTimes(1);
  });
});
