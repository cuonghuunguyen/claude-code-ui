// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KeyTips } from "./key-tip.tsx";
import { bind, resetAll } from "./keymap.ts";
import { loadKeyTips, markKeyUsed, resetAllKeyTips, setKeyTipsOn } from "./key-tips.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const onAssign = vi.fn();
const off = vi.fn();
const render = (hidden = false) => act(async () => root.render(<KeyTips hidden={hidden} onAssign={onAssign} onTurnedOff={off} />));

beforeEach(async () => {
  localStorage.clear();
  resetAll();
  resetAllKeyTips();
  onAssign.mockClear();
  off.mockClear();
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  document.body.innerHTML = `<button data-command="sidebar.toggle" id="sb"></button><button data-command="focus.open" id="fo"></button><button data-command="nope" id="x"></button><div aria-disabled="true"><button data-command="file.open" id="dis"></button></div><div id="host"></div>`;
  host = document.getElementById("host") as HTMLDivElement;
  root = createRoot(host);
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const mouse = (sel: string, type = "mouse", detail = 1) =>
  act(async () => {
    const el = document.querySelector(sel)!;
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: type }));
    el.dispatchEvent(new PointerEvent("click", { bubbles: true, pointerType: type, detail }));
  });
const times = async (n: number, sel: string, type = "mouse", detail = 1) => {
  for (let i = 0; i < n; i++) await mouse(sel, type, detail);
};
const toast = () => document.querySelector<HTMLElement>('[data-testid="toast"]');
const dismiss = () => act(async () => void document.querySelector<HTMLElement>('[aria-label="Dismiss"]')?.click());
// A shown toast goes only after its 280 ms exit: drop it for the next count.
const clear = async () => {
  await dismiss();
  await act(async () => void (await new Promise((r) => setTimeout(r, 300))));
};

it("the 2nd mouse click on Toggle sidebar shows 'Toggle sidebar: Ctrl+B'; the 1st, 3rd and 4th show nothing", async () => {
  await mouse("#sb");
  expect(toast()).toBeNull();
  await mouse("#sb");
  expect(toast()?.textContent).toContain("Toggle sidebar: Ctrl+B");
  await clear();
  await times(2, "#sb");
  expect(toast()).toBeNull();
  await mouse("#sb");
  expect(toast()?.textContent).toContain("Toggle sidebar: Ctrl+B");
});

it("the tip is announced by a polite live region that exists before its text, and does not take focus", async () => {
  const region = document.querySelector<HTMLElement>('[data-testid="key-tip-status"]')!;
  expect(region).not.toBeNull();
  expect(region.getAttribute("role")).toBe("status");
  expect(region.getAttribute("aria-live")).toBe("polite");
  expect(region.textContent).toBe("");
  const x = document.getElementById("x") as HTMLButtonElement;
  x.focus();
  await times(2, "#sb");
  // The same element, now filled; the visible toast is not a second announcement.
  expect(document.querySelector('[data-testid="key-tip-status"]')).toBe(region);
  expect(region.textContent).toBe("Toggle sidebar: Ctrl+B");
  expect(toast()!.getAttribute("role")).toBeNull();
  expect(document.activeElement).toBe(x);
});

it("an open modal dialog hides the tip until it closes", async () => {
  const dlg = document.createElement("div");
  dlg.setAttribute("aria-modal", "true");
  await act(async () => void document.body.append(dlg));
  await times(2, "#sb");
  expect(toast()).toBeNull();
  expect(document.querySelector('[data-testid="key-tip-status"]')!.textContent).toBe("");
  await act(async () => void dlg.remove());
  expect(toast()?.textContent).toContain("Toggle sidebar: Ctrl+B");
});

it("touch and pen clicks never count or tip", async () => {
  await times(10, "#sb", "touch");
  await times(10, "#sb", "pen");
  expect(toast()).toBeNull();
  expect(loadKeyTips().counts).toEqual({});
});

it("keyboard activation (detail 0) does not count", async () => {
  await times(5, "#sb", "mouse", 0);
  expect(toast()).toBeNull();
  expect(loadKeyTips().counts).toEqual({});
});

it("after the shortcut was used no tip shows", async () => {
  markKeyUsed("sidebar.toggle");
  await times(10, "#sb");
  expect(toast()).toBeNull();
});

it("switching tips off stops all and removes a shown tip", async () => {
  await times(2, "#sb");
  expect(toast()).not.toBeNull();
  await act(async () => setKeyTipsOn(false));
  expect(toast()).toBeNull();
  await times(10, "#sb");
  expect(toast()).toBeNull();
  expect(loadKeyTips().counts["sidebar.toggle"]).toBe(2);
});

it("Turn off tips in the tip turns them off and calls onTurnedOff", async () => {
  await times(2, "#sb");
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "Turn off tips")!;
  await act(async () => void b.click());
  expect(loadKeyTips().off).toBe(true);
  expect(off).toHaveBeenCalledOnce();
});

it("a command without a binding offers Assign a shortcut…, which calls onAssign with its id", async () => {
  await times(2, "#fo");
  expect(toast()!.textContent).toContain("Open Focus has no shortcut.");
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "Assign a shortcut…")!;
  await act(async () => void b.click());
  expect(onAssign).toHaveBeenCalledWith("focus.open");
  await act(async () => void (await new Promise((r) => setTimeout(r, 300))));
  expect(toast()).toBeNull();
});

it("a removed binding also offers Assign", async () => {
  bind("sidebar.toggle", null);
  await times(2, "#sb");
  expect(toast()!.textContent).toContain("Toggle sidebar has no shortcut.");
});

it("a rebinding shows in the tip", async () => {
  bind("sidebar.toggle", "mod+alt+b");
  await times(2, "#sb");
  expect(toast()!.textContent).toContain("Toggle sidebar: Ctrl+Alt+B");
});

it("commands outside the registry and disabled controls do not count", async () => {
  await times(10, "#x");
  await times(10, "#dis");
  expect(toast()).toBeNull();
  expect(loadKeyTips().counts).toEqual({});
});

it("hidden: the tip waits and shows when hidden turns false", async () => {
  await render(true);
  await times(2, "#sb");
  expect(toast()).toBeNull();
  await render(false);
  expect(toast()?.textContent).toContain("Toggle sidebar: Ctrl+B");
});

it("below md the tip's buttons are 44 px targets, also for a mouse", async () => {
  await times(2, "#sb");
  const action = [...document.querySelectorAll("button")].find((x) => x.textContent === "Turn off tips")!;
  const dismissBtn = document.querySelector('[aria-label="Dismiss"]')!;
  expect(action.className).toContain("max-md:min-h-11");
  expect(action.className).toContain("max-md:min-w-11");
  expect(dismissBtn.className).toContain("max-md:size-11");
  expect(dismissBtn.className).toContain("max-md:-m-3");
});
