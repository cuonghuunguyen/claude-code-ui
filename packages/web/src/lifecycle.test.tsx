// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySession } from "./store.ts";
import { HOLD_MS, phaseOf, useHold, useJustFinished, useRootLifecycle, type Phase } from "./lifecycle.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view = (state: "idle" | "running" | "needs_input" | "error" | "closed", extra = {}) => ({ ...emptySession(), state, ...extra });

describe("phaseOf", () => {
  it.each([
    ["running", "thinking"],
    ["needs_input", "waiting"],
    ["idle", "idle"],
    ["error", "idle"],
    ["closed", "idle"],
  ] as const)("%s is %s", (state, phase) => expect(phaseOf(view(state))).toBe(phase));
  it("OpenCode retry row counts as thinking", () => expect(phaseOf(view("running", { retry: { attempt: 2, message: "rate limited" } }))).toBe("thinking"));
  it("no view is idle", () => expect(phaseOf(undefined)).toBe("idle"));
});

let host: HTMLElement;
let root: Root;
const render = (el: React.ReactElement) => act(() => root.render(el));
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function Probe({ id, phase }: { id: string; phase: Phase }) {
  return createElement("i", { "data-finished": useJustFinished(id, phase) ? "" : undefined });
}
const finished = () => host.querySelector("i")!.hasAttribute("data-finished");
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("useJustFinished", () => {
  it("is set for 1200 ms after thinking -> idle, then cleared", () => {
    render(createElement(Probe, { id: "a", phase: "thinking" }));
    expect(finished()).toBe(false);
    render(createElement(Probe, { id: "a", phase: "idle" }));
    expect(finished()).toBe(true);
    tick(HOLD_MS - 1);
    expect(finished()).toBe(true);
    tick(1);
    expect(finished()).toBe(false);
  });
  it("is not set on another session shown within the hold", () => {
    render(createElement(Probe, { id: "a", phase: "thinking" }));
    render(createElement(Probe, { id: "a", phase: "idle" }));
    tick(100);
    render(createElement(Probe, { id: "b", phase: "idle" }));
    expect(finished()).toBe(false);
  });
  it("is not set again when switching back to the finished session within the hold", () => {
    render(createElement(Probe, { id: "a", phase: "thinking" }));
    render(createElement(Probe, { id: "a", phase: "idle" }));
    render(createElement(Probe, { id: "b", phase: "idle" }));
    render(createElement(Probe, { id: "a", phase: "idle" }));
    expect(finished()).toBe(false);
  });
  it("is cleared at once when a new run starts", () => {
    render(createElement(Probe, { id: "a", phase: "thinking" }));
    render(createElement(Probe, { id: "a", phase: "idle" }));
    render(createElement(Probe, { id: "a", phase: "thinking" }));
    expect(finished()).toBe(false);
  });
  it("restarts the hold on the next finish", () => {
    render(createElement(Probe, { id: "a", phase: "thinking" }));
    render(createElement(Probe, { id: "a", phase: "idle" }));
    tick(1000);
    render(createElement(Probe, { id: "a", phase: "thinking" }));
    render(createElement(Probe, { id: "a", phase: "idle" }));
    tick(1000);
    expect(finished()).toBe(true);
    tick(200);
    expect(finished()).toBe(false);
  });
  it("is not set when waiting -> idle", () => {
    render(createElement(Probe, { id: "a", phase: "waiting" }));
    render(createElement(Probe, { id: "a", phase: "idle" }));
    expect(finished()).toBe(false);
  });
  it("is not set when the shown session changes from a running one to an idle one", () => {
    render(createElement(Probe, { id: "a", phase: "thinking" }));
    render(createElement(Probe, { id: "b", phase: "idle" }));
    expect(finished()).toBe(false);
  });
});

describe("useHold", () => {
  const Held = ({ stamp }: { stamp: number }) => createElement("i", { "data-on": useHold(stamp) ? "" : undefined });
  const on = () => host.querySelector("i")!.hasAttribute("data-on");
  it("is on from the first render for 1200 ms (focus page opened)", () => {
    render(createElement(Held, { stamp: 1 }));
    expect(on()).toBe(true);
    tick(HOLD_MS);
    expect(on()).toBe(false);
  });
  it("is off for stamp 0", () => {
    render(createElement(Held, { stamp: 0 }));
    expect(on()).toBe(false);
  });
});

describe("useRootLifecycle", () => {
  const html = document.documentElement;
  let reduce = false;
  let onChange: (() => void) | undefined;
  beforeEach(() => {
    reduce = false;
    onChange = undefined;
    window.matchMedia = ((q: string) => ({
      get matches() {
        return q.includes("prefers-reduced-motion") && reduce;
      },
      addEventListener: (_: string, f: () => void) => (onChange = f),
      removeEventListener: () => (onChange = undefined),
    })) as never;
  });
  afterEach(() => {
    for (const a of ["data-phase", "data-motion", "data-page-hidden"]) html.removeAttribute(a);
  });
  const Root = ({ phase }: { phase: Phase }) => (useRootLifecycle(phase), null);

  it("sets data-phase on <html>", () => {
    render(createElement(Root, { phase: "waiting" }));
    expect(html.getAttribute("data-phase")).toBe("waiting");
    render(createElement(Root, { phase: "thinking" }));
    expect(html.getAttribute("data-phase")).toBe("thinking");
  });
  it("data-motion follows prefers-reduced-motion live", () => {
    render(createElement(Root, { phase: "idle" }));
    expect(html.getAttribute("data-motion")).toBe("on");
    reduce = true;
    act(() => onChange!());
    expect(html.getAttribute("data-motion")).toBe("off");
  });
  it("data-page-hidden is set while the tab is hidden", () => {
    render(createElement(Root, { phase: "idle" }));
    expect(html.hasAttribute("data-page-hidden")).toBe(false);
    const state = vi.spyOn(document, "visibilityState", "get");
    state.mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(html.hasAttribute("data-page-hidden")).toBe(true);
    state.mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(html.hasAttribute("data-page-hidden")).toBe(false);
    state.mockRestore();
  });
  it("removes the attributes on unmount", () => {
    render(createElement(Root, { phase: "idle" }));
    act(() => root.unmount());
    root = createRoot(host);
    expect(html.hasAttribute("data-phase")).toBe(false);
    expect(html.hasAttribute("data-motion")).toBe(false);
  });
});
