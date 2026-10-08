// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GuideTour, type GuideTourProps } from "./guide-tour.tsx";
import type { GuideHost } from "./guide.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

let reduced = false;
let coarse = false;
let app: HTMLElement;
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let opener: HTMLButtonElement;
const keys: Record<string, string> = { "palette.open": "mod+k", "session.new": "mod+shift+s" };
const guestHost: GuideHost = { keyOf: (id) => keys[id], openProject: vi.fn(), openSettings: vi.fn() };

beforeEach(() => {
  reduced = false;
  coarse = false;
  window.matchMedia = ((q: string) => ({
    matches: q.includes("prefers-reduced-motion") ? reduced : q.includes("any-pointer: coarse") ? coarse : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  // The app root, like #root > div: the tour makes it inert.
  app = document.createElement("div");
  app.innerHTML = `<button id="opener">opener</button><button data-command="session.new" id="plus">+</button>`;
  document.body.append(app);
  opener = app.querySelector("#opener")!;
  Object.defineProperty(opener, "getClientRects", { value: () => [{}] });
  opener.focus();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const IDS = ["welcome", "project", "new-session", "sidebar", "palette", "basics-end"];
async function show(over: Partial<GuideTourProps> = {}) {
  const onEnd = vi.fn();
  const onStep = vi.fn();
  const props: GuideTourProps = { ids: IDS, host: guestHost, narrow: false, onEnd, onStep, visible: () => true, ...over };
  await act(async () => root.render(<GuideTour {...props} />));
  return { onEnd, onStep };
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const pop = () => q("guide-popover")!;
const button = (name: string) => [...pop().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name || b.getAttribute("aria-label") === name)!;
const click = (name: string) => act(async () => button(name).click());
const key = (k: string, init: KeyboardEventInit = {}) => act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })));

it("is a modal dialog named by its title, showing 'Step 1 of N' with the focus on Start tour", async () => {
  await show();
  expect(pop().getAttribute("role")).toBe("dialog");
  expect(pop().getAttribute("aria-modal")).toBe("true");
  expect(document.getElementById(pop().getAttribute("aria-labelledby")!)!.textContent).toBe("Welcome to Claude UI");
  expect(q("guide-progress")!.textContent).toBe("Step 1 of 6");
  expect(document.activeElement).toBe(button("Start tour"));
});

it("Next, Back, ArrowRight and ArrowLeft move between steps", async () => {
  const { onStep } = await show();
  await click("Start tour");
  expect(q("guide-progress")!.textContent).toBe("Step 2 of 6");
  expect(pop().textContent).toContain("Add a project");
  await key("ArrowRight");
  expect(pop().dataset.step).toBe("new-session");
  await key("ArrowLeft");
  expect(pop().dataset.step).toBe("project");
  await click("Back");
  expect(pop().dataset.step).toBe("welcome");
  expect(button("Back")).toBeUndefined();
  expect(onStep.mock.calls.map((c) => c[0])).toEqual(["welcome", "project", "new-session", "project", "welcome"]);
});

it("Next on the last step ends as done; the last step offers Add project and no Skip tour", async () => {
  const { onEnd } = await show({ start: "basics-end" });
  expect(button("Skip tour")).toBeUndefined();
  expect(button("Done")).toBeDefined();
  await click("Done");
  expect(onEnd).toHaveBeenCalledWith("done");
});

it("Add project on the end card runs the host action and ends as done", async () => {
  const { onEnd } = await show({ start: "basics-end" });
  await click("Add project");
  expect(guestHost.openProject).toHaveBeenCalled();
  expect(onEnd).toHaveBeenCalledWith("done");
});

it("Skip tour, Close and Esc end as skipped", async () => {
  for (const how of [() => click("Skip tour"), () => click("Close tour"), () => key("Escape")]) {
    const { onEnd } = await show();
    await how();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith("skipped");
  }
});

it("a click outside the popover does nothing", async () => {
  const { onEnd } = await show();
  await act(async () => q("guide-shield")!.click());
  expect(onEnd).not.toHaveBeenCalled();
  expect(q("guide-popover")).not.toBeNull();
});

it("Tab wraps inside the popover", async () => {
  await show({ start: "project" });
  const buttons = [...pop().querySelectorAll<HTMLButtonElement>("button")];
  buttons.at(-1)!.focus();
  await key("Tab");
  expect(document.activeElement).toBe(buttons[0]);
  await key("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(buttons.at(-1));
});

it("Tab with the focus outside the popover brings it back to Next", async () => {
  await show({ start: "project" });
  (document.activeElement as HTMLElement).blur();
  await key("Tab");
  expect(pop().contains(document.activeElement)).toBe(true);
});

it("makes the app inert while it shows, and gives the focus back to the opener at the end", async () => {
  await show();
  expect(app.hasAttribute("inert")).toBe(true);
  expect(pop().closest("[inert]")).toBeNull();
  await act(async () => root.render(<></>));
  expect(app.hasAttribute("inert")).toBe(false);
  expect(document.activeElement).toBe(opener);
});

it("returnFocus wins over the opener", async () => {
  await show({ returnFocus: () => app.querySelector<HTMLElement>("#plus") });
  await act(async () => root.render(<></>));
  expect(document.activeElement?.id).toBe("plus");
});

it("announces each step once in a polite live region", async () => {
  await show();
  const live = q("guide-live")!;
  expect(live.getAttribute("aria-live")).toBe("polite");
  await click("Start tour");
  expect(live.textContent).toBe("Step 2 of 6. Add a project. A project is a folder on this machine. Sessions run in it, and its files, changes and git history show beside the chat.");
  await click("Next");
  expect(live.textContent).toContain("Step 3 of 6. Start a session. + opens a New session tab");
  expect(live.textContent).not.toContain("**");
});

it("shows key chips from the host's key specs and hides the line for an unbound command", async () => {
  await show({ start: "palette" });
  const chips = [...q("guide-keys")!.querySelectorAll("kbd span")].map((s) => s.textContent);
  expect(chips).toEqual(["Ctrl", "K"]);
  await act(async () => root.render(<GuideTour ids={IDS} start="palette" host={{ ...guestHost, keyOf: () => undefined }} narrow={false} onEnd={() => {}} visible={() => true} />));
  expect(q("guide-keys")).toBeNull();
});

it("a coarse-only pointer reads 'With a keyboard'", async () => {
  coarse = true;
  await show({ start: "palette" });
  expect(q("guide-keys")!.textContent).toContain("With a keyboard");
});

it("a step with no visible anchor is centered with no cutout and a full dim", async () => {
  await show({ start: "palette" });
  expect(q("guide-spotlight")).toBeNull();
  expect(pop().dataset.placement).toBe("center");
  expect(q("guide-shield")!.className).toContain("bg-overlay");
});

it("a visible anchor gets a spotlight cutout and an arrow", async () => {
  const plus = app.querySelector<HTMLElement>("#plus")!;
  plus.getBoundingClientRect = () => ({ left: 100, top: 10, width: 28, height: 28, right: 128, bottom: 38, x: 100, y: 10, toJSON() {} });
  await show({ start: "new-session", visible: (el) => el === plus });
  const s = q("guide-spotlight")!;
  expect(s.style.left).toBe("96px");
  expect(s.style.width).toBe("36px");
  expect(s.style.boxShadow).toContain("var(--overlay)");
  expect(pop().dataset.placement).toBe("bottom");
  expect(q("guide-arrow")).not.toBeNull();
  expect(q("guide-shield")!.className).not.toContain("bg-overlay");
});

it("below sm the popover is a bottom sheet (a top sheet when the anchor is low)", async () => {
  const plus = app.querySelector<HTMLElement>("#plus")!;
  const at = (top: number) => (plus.getBoundingClientRect = () => ({ left: 10, top, width: 28, height: 28, right: 38, bottom: top + 28, x: 10, y: top, toJSON() {} }));
  const w = innerWidth;
  const h = innerHeight;
  Object.assign(window, { innerWidth: 390, innerHeight: 844 });
  at(10);
  await show({ start: "new-session", visible: (el) => el === plus });
  expect(pop().dataset.placement).toBe("sheet-bottom");
  expect(pop().style.left).toBe("16px");
  expect(pop().style.right).toBe("16px");
  expect(q("guide-arrow")).toBeNull();
  at(700);
  await show({ start: "new-session", visible: (el) => el === plus });
  expect(pop().dataset.placement).toBe("sheet-top");
  Object.assign(window, { innerWidth: w, innerHeight: h });
});

it("under prefers-reduced-motion nothing moves or fades", async () => {
  reduced = true;
  await show({ start: "palette" });
  expect(pop().className).not.toContain("transition");
  expect(pop().className).not.toContain("animate-");
});

it("the narrow variant swaps the body and drops the key line", async () => {
  await show({ start: "sidebar", narrow: true });
  expect(pop().textContent).toContain("☰ opens projects and sessions.");
  expect(q("guide-keys")).toBeNull();
});

it("re-resolves the anchor when the layout changes", async () => {
  vi.useFakeTimers();
  let found = false;
  const plus = app.querySelector<HTMLElement>("#plus")!;
  await show({ start: "new-session", visible: (el) => found && el === plus });
  expect(q("guide-spotlight")).toBeNull();
  found = true;
  await act(async () => vi.advanceTimersByTime(600));
  expect(q("guide-spotlight")).not.toBeNull();
});

it("with nothing focused at the start the focus goes to the shown prompt box at the end", async () => {
  (document.activeElement as HTMLElement).blur();
  const prompt = document.createElement("textarea");
  prompt.setAttribute("aria-label", "Prompt");
  Object.defineProperty(prompt, "offsetParent", { get: () => document.body });
  app.append(prompt);
  await show();
  await act(async () => root.render(<></>));
  expect(document.activeElement).toBe(prompt);
});

it("walking every step with no anchor visible (panel hidden) never crashes, and the panel steps show the panel toggle key", async () => {
  const all = ["welcome", "project", "new-session", "sidebar", "palette", "tabs", "files", "changes", "graph", "terminal", "replay"];
  const withKeys: GuideHost = { ...guestHost, keyOf: (id) => ({ "panel.toggle": "mod+shift+r", "filetree.toggle": "mod+\\" })[id] };
  const toggle = app.querySelector<HTMLElement>("#plus")!;
  toggle.setAttribute("data-command", "panel.toggle");
  // Only the panel toggle is on screen: Files, Changes and Git graph use their alternative, Terminal has none.
  await show({ ids: all, host: withKeys, visible: (el) => el === toggle });
  for (const id of all) {
    expect(pop().dataset.step).toBe(id);
    if (["files", "changes", "graph"].includes(id)) {
      expect(pop().textContent).toContain("Show the side panel");
      expect([...q("guide-keys")!.querySelectorAll("kbd span")].map((s) => s.textContent)).toEqual(["Ctrl", "Shift", "R"]);
    }
    if (id === "terminal") expect(pop().textContent).toContain("A shell in the project folder");
    if (id !== "replay") await key("ArrowRight");
  }
});
