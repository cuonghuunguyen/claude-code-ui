import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoContinue } from "../src/auto-continue.ts";

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
function setup(enabled = { on: true }, sendResult = true) {
  const send = vi.fn(async (_id: string, _wanted: () => boolean) => sendResult);
  const show = vi.fn((_id: string, _at: number | null) => {});
  const ac = createAutoContinue({ enabled: () => enabled.on, send, show });
  return { ac, send, show, enabled };
}

describe("auto-continue", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(T0);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("schedules nothing while the setting is off", async () => {
    const { ac, send, show } = setup({ on: false });
    ac.schedule("a", T0 + 1000);
    expect(show).not.toHaveBeenCalled();
    expect(ac.scheduled().size).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends continue at reset + 10 s, not before, and clears the indicator", async () => {
    const { ac, send, show } = setup();
    ac.schedule("a", T0 + 60_000);
    expect(show).toHaveBeenCalledWith("a", T0 + 70_000);
    await vi.advanceTimersByTimeAsync(69_999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("a", expect.any(Function));
    expect(show).toHaveBeenLastCalledWith("a", null);
  });

  it("spaces sessions stopped by the same limit 5 s apart, in stop order", async () => {
    const { ac, send } = setup();
    const at: Record<string, number> = {};
    send.mockImplementation(async (id: string) => ((at[id] = Date.now() - T0), true));
    for (const id of ["a", "b", "c"]) ac.schedule(id, T0 + 60_000);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(send.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
    expect(at).toEqual({ a: 70_000, b: 75_000, c: 80_000 });
  });

  it("cancel drops the schedule and the indicator; nothing is sent", async () => {
    const { ac, send, show } = setup();
    ac.schedule("a", T0 + 60_000);
    ac.cancel("a");
    expect(show).toHaveBeenLastCalledWith("a", null);
    expect(ac.scheduled().size).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).not.toHaveBeenCalled();
  });

  it("clear drops every schedule", async () => {
    const { ac, send } = setup();
    ac.schedule("a", T0 + 60_000);
    ac.schedule("b", T0 + 60_000);
    ac.clear();
    expect(ac.scheduled().size).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).not.toHaveBeenCalled();
  });

  it("the setting turned off before the reset: nothing is sent", async () => {
    const { ac, send, enabled } = setup();
    ac.schedule("a", T0 + 60_000);
    enabled.on = false;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).not.toHaveBeenCalled();
  });

  it("a send the session refuses is dropped, not retried", async () => {
    const { ac, send } = setup(undefined, false);
    ac.schedule("a", T0 + 60_000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ac.scheduled().size).toBe(0);
  });

  it("the same reset again retries after 60 s, at most 3 tries; a new reset starts over", async () => {
    const { ac, send } = setup();
    const reset = T0 + 60_000;
    ac.schedule("a", reset);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(send).toHaveBeenCalledTimes(1);
    ac.schedule("a", reset); // limit hit again, same reset
    expect(ac.scheduled().get("a")).toBe(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(2);
    ac.schedule("a", reset);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(3);
    ac.schedule("a", reset); // 4th: given up
    expect(ac.scheduled().size).toBe(0);
    const next = Date.now() + 3_600_000;
    ac.schedule("a", next);
    expect(ac.scheduled().get("a")).toBe(next + 10_000);
  });

  it("a limit hit without a reset time right after a sent continue retries with the remembered reset time", async () => {
    const { ac, send } = setup();
    ac.schedule("a", T0 + 60_000);
    await vi.advanceTimersByTimeAsync(70_000);
    ac.schedule("a", undefined);
    expect(ac.scheduled().get("a")).toBe(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("without a reset time and no continue sent before, nothing is scheduled", () => {
    const { ac } = setup();
    ac.schedule("a", undefined);
    expect(ac.scheduled().size).toBe(0);
  });

  it("tries count when the continue is sent: scheduling the same reset twice before it fires is one try", async () => {
    const { ac, send } = setup();
    ac.schedule("a", T0 + 60_000);
    ac.schedule("a", T0 + 60_000);
    ac.schedule("a", T0 + 60_000);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(send).toHaveBeenCalledTimes(1);
    ac.schedule("a", T0 + 60_000);
    expect(ac.scheduled().size).toBe(1);
  });

  it("a cancel while the send runs makes wanted() false", async () => {
    const { ac, send } = setup();
    let wanted!: () => boolean;
    let release!: () => void;
    send.mockImplementation((_id, w) => ((wanted = w), new Promise<boolean>((r) => (release = () => r(true)))));
    ac.schedule("a", T0 + 60_000);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(wanted()).toBe(true);
    ac.cancel("a");
    expect(wanted()).toBe(false);
    release();
  });

  it("a reset already past schedules at now + 10 s", () => {
    const { ac } = setup();
    ac.schedule("a", T0 - 20_000);
    expect(ac.scheduled().get("a")).toBe(T0 + 10_000);
  });
});
