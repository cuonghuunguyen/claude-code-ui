// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Chooser } from "./toolbar.tsx";

Element.prototype.scrollIntoView ??= () => {};

const items = [
  { value: "ask", label: "Ask" },
  { value: "plan", label: "Plan" },
  { value: "dont", label: "Don't ask" },
];
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => root?.unmount());

const mount = async (value: string, onChange = vi.fn(), list = items) => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const show = (v: string, l = list) => act(async () => root!.render(<Chooser label="Mode" value={v} items={l} onChange={onChange} testId="c" />));
  await show(value);
  const trigger = () => el.querySelector<HTMLElement>('[data-testid="c"]')!;
  return { onChange, show, trigger };
};

it("typeahead on a closed trigger commits the matching item", async () => {
  const { onChange, trigger } = await mount("ask");
  // Opened once: Base UI has registered the items (a closed picker that was never opened has none to match).
  await act(async () => trigger().click());
  await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  trigger().focus();
  await act(async () => void trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true, cancelable: true })));
  expect(onChange).toHaveBeenCalledWith("plan");
});

it("items that drop the current value do not reset it to the mounted value (Base UI reason none, no key press)", async () => {
  const withAuto = [...items, { value: "auto", label: "Auto mode" }];
  const { onChange, show, trigger } = await mount("dont", undefined, withAuto);
  // Opened once: Base UI has registered the items.
  await act(async () => trigger().click());
  await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await show("auto", withAuto);
  // A model switch drops Auto mode from the items for a render; Base UI resets to the value it mounted with ("dont").
  await show("auto", items);
  expect(onChange).not.toHaveBeenCalled();
});

it("GH-656: consecutive items of one group sit under a muted, non-selectable label", async () => {
  const grouped = [
    { value: "a", label: "A", group: "Acme" },
    { value: "b", label: "B", group: "Acme" },
    { value: "c", label: "C", group: "Beta" },
    { value: "d", label: "D" },
  ];
  const { trigger } = await mount("a", vi.fn(), grouped);
  await act(async () => trigger().click());
  const labels = [...document.querySelectorAll('[data-slot="select-label"]')];
  expect(labels.map((l) => l.textContent)).toEqual(["Acme", "Beta"]);
  expect(labels.every((l) => l.closest('[role="option"]') === null && l.className.includes("text-xs text-muted-foreground"))).toBe(true);
  expect(document.querySelectorAll('[data-slot="select-group"] [role="option"]')).toHaveLength(3);
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(4);
});
