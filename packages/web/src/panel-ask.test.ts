import { afterEach, expect, it, vi } from "vitest";
import { askPanel, onPanelAsk, takePanelAsk } from "./panel-ask.ts";

afterEach(() => {
  vi.useRealTimers();
  takePanelAsk("rollback");
  takePanelAsk("stash");
});

it("GH-722: an ask reaches a mounted listener of its kind, once", () => {
  vi.useFakeTimers();
  const fn = vi.fn();
  const off = onPanelAsk("stash", fn);
  askPanel({ kind: "rollback" });
  askPanel({ kind: "stash" });
  vi.runAllTimers();
  expect(fn).toHaveBeenCalledTimes(1);
  expect(fn).toHaveBeenCalledWith({ kind: "stash" });
  off();
});

it("GH-722: a listener that mounts late takes the ask within 2 s", () => {
  vi.useFakeTimers();
  askPanel({ kind: "annotate", path: "/w/a.ts" });
  vi.advanceTimersByTime(1000);
  const fn = vi.fn();
  const off = onPanelAsk("annotate", fn);
  expect(fn).toHaveBeenCalledWith({ kind: "annotate", path: "/w/a.ts" });
  off();
  expect(takePanelAsk("annotate")).toBeUndefined();
});

it("GH-722: an ask older than 2 s is dropped", () => {
  vi.useFakeTimers();
  askPanel({ kind: "rollback" });
  vi.advanceTimersByTime(2500);
  expect(takePanelAsk("rollback")).toBeUndefined();
});

it("GH-722: a handler that returns false leaves the ask for another panel", () => {
  vi.useFakeTimers();
  const no = vi.fn(() => false);
  const yes = vi.fn();
  const a = onPanelAsk("sendSelection", no);
  const b = onPanelAsk("sendSelection", yes);
  askPanel({ kind: "sendSelection" });
  vi.runAllTimers();
  expect(no).toHaveBeenCalledTimes(1);
  expect(yes).toHaveBeenCalledTimes(1);
  a();
  b();
});
