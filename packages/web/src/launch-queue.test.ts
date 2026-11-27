import { describe, expect, it } from "vitest";
import { applyLaunch, consumeLaunches, type LaunchParams } from "./launch-queue.ts";

describe("launch queue (claude-ui open into the open app window)", () => {
  const loc = () => ({ origin: "http://127.0.0.1:4744", hash: "#old" });
  it("sets the hash of a same-origin launch URL: pairing token and session deep link", () => {
    const l = loc();
    expect(applyLaunch({ targetURL: "http://127.0.0.1:4744/#token=abc" }, l)).toBe(true);
    expect(l.hash).toBe("#token=abc");
    expect(applyLaunch({ targetURL: "http://127.0.0.1:4744/#sess-2" }, l)).toBe(true);
    expect(l.hash).toBe("#sess-2");
  });
  it("ignores another origin, no fragment, the same fragment and a missing URL", () => {
    const l = loc();
    for (const targetURL of ["http://evil.example/#x", "http://127.0.0.1:4744/", "http://127.0.0.1:4744/#old", undefined]) expect(applyLaunch({ targetURL }, l)).toBe(false);
    expect(l.hash).toBe("#old");
  });
  it("registers one consumer on launchQueue; no launchQueue is fine", () => {
    let fn: ((p: LaunchParams) => void) | undefined;
    consumeLaunches({ setConsumer: (f) => (fn = f) });
    expect(fn).toBeTypeOf("function");
    expect(() => consumeLaunches(undefined)).not.toThrow();
  });
});
