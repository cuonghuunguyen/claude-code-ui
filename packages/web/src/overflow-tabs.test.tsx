// @vitest-environment jsdom
// GH-512: a tab row shows the tabs that fit; the rest are in a `…` menu; the selected tab stays a tab.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fitTabs } from "./overflow-tabs.ts";
import { OverflowTabs } from "./overflow-tabs.tsx";

const RO = globalThis.ResizeObserver;
const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
let width = 200;
beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 60 });
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => width });
});
const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => {
  act(() => root.render(null));
  globalThis.ResizeObserver = RO;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidth!);
  Object.defineProperty(Element.prototype, "clientWidth", clientWidth!);
  document.body.querySelectorAll("[data-base-ui-inert], [role=menu]").forEach((n) => n.remove());
});

const KEYS = ["changes", "files", "graph", "plan", "artifacts"];
function mount(selected: string | undefined, onSelect = vi.fn()) {
  act(() =>
    root.render(
      <OverflowTabs
        keys={KEYS}
        selected={selected}
        label="Side panel"
        renderTab={(k) => (
          <button key={k} role="tab" data-overflow-key={k} data-testid={`pane-${k}`}>
            {k}
          </button>
        )}
        menuItem={(k) => ({ label: k, onSelect: () => onSelect(k), testId: `pane-${k}`, command: k === "files" ? "pane.files" : undefined })}
      />,
    ),
  );
  return onSelect;
}
const tabs = () => [...el.querySelectorAll("[role=tab]")].map((n) => (n as HTMLElement).dataset.overflowKey);
const more = () => el.querySelector<HTMLElement>("[data-testid=pane-overflow]");

it("hidden tabs move into the more menu", async () => {
  mount(undefined);
  expect(tabs()).toEqual(["changes", "files"]);
  expect(more()).not.toBeNull();
  expect(more()!.getAttribute("aria-label")).toBe("3 more panes");
});

it("the selected tab stays visible", () => {
  mount("artifacts");
  expect(tabs()).toEqual(["changes", "artifacts"]);
});

it("all tabs show when the row is wide", () => {
  width = 400;
  mount(undefined);
  width = 200;
  expect(tabs()).toEqual(KEYS);
  expect(more()).toBeNull();
});

it("a menu item selects its key and keeps data-testid / data-command", async () => {
  const onSelect = mount("changes");
  await act(async () => more()!.click());
  const items = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
  expect(items.map((i) => i.dataset.testid)).toEqual(["pane-graph", "pane-plan", "pane-artifacts"]);
  await act(async () => items[2]!.click());
  expect(onSelect).toHaveBeenCalledWith("artifacts");
});

it("a keyboard-opened menu focuses its first item", async () => {
  mount(undefined);
  await act(async () => {
    more()!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  });
  await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
  expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
});

describe("fitTabs", () => {
  it("all fit", () => expect(fitTabs([60, 60, 60], 200, 4, 32, 0)).toEqual([0, 1, 2]));
  it("undefined width shows all", () => expect(fitTabs([60, 60, 60], undefined, 4, 32, 0)).toEqual([0, 1, 2]));
  it("prefix leaves room for the more button", () => expect(fitTabs([60, 60, 60, 60, 60], 200, 4, 32, -1)).toEqual([0, 1]));
  it("a selected tab past the fit replaces the last shown ones, order kept", () => expect(fitTabs([60, 60, 60, 60, 60], 200, 4, 32, 4)).toEqual([0, 4]));
  it("selected wider than the budget still shows alone", () => expect(fitTabs([300], 100, 4, 32, 0)).toEqual([0]));
  it("no selection keeps at least the first tab", () => expect(fitTabs([300, 50], 100, 4, 32, -1)).toEqual([0]));
});
