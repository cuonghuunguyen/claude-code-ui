// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ModelChooser, ModelFooter } from "./toolbar.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};

const many = [
  { value: "acme/alpha", label: "Alpha Pro", group: "Acme" },
  { value: "acme/beta", label: "Beta", group: "Acme" },
  { value: "zen/gamma", label: "Gamma", group: "Zenith AI" },
  { value: "zen/delta", label: "Delta", group: "Zenith AI" },
  { value: "m5", label: "Model 5" },
  { value: "m6", label: "Model 6" },
  { value: "m7", label: "Model 7" },
  { value: "m8", label: "Model 8" },
  { value: "m9", label: "Model 9" },
];
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => root?.unmount());

const mount = async (items = many, onChange = vi.fn(), footer?: (close: () => void) => React.ReactNode) => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<ModelChooser label="Model" value="acme/beta" items={items} onChange={onChange} testId="m" footer={footer} />));
  await act(async () => el.querySelector<HTMLElement>('[data-testid="m"]')!.click());
  return onChange;
};
const search = () => document.querySelector<HTMLInputElement>('input[type="search"], input[role="combobox"]');
const type = async (text: string) => {
  const input = search()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const options = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
const labels = () => [...document.querySelectorAll('[data-slot="select-label"]')].map((o) => o.textContent);

it("a long model list has a search field that filters by model name", async () => {
  await mount();
  expect(search()).not.toBeNull();
  expect(options()).toHaveLength(9);
  await type("alp");
  expect(options()).toEqual(["Alpha Pro"]);
});

it("matches the model id and the provider name, case-insensitively, and hides groups without a match", async () => {
  await mount();
  await type("ZEN/");
  expect(options()).toEqual(["Gamma", "Delta"]);
  expect(labels()).toEqual(["Zenith AI"]);
  await type("acme");
  expect(options()).toEqual(["Alpha Pro", "Beta"]);
  expect(labels()).toEqual(["Acme"]);
});

it("shows a message when nothing matches", async () => {
  await mount();
  await type("nope");
  expect(options()).toEqual([]);
  expect(document.body.textContent).toContain("No models match");
});

it("picking a filtered model reports it", async () => {
  const onChange = await mount();
  await type("gam");
  await act(async () => document.querySelector<HTMLElement>('[role="option"]')!.click());
  expect(onChange).toHaveBeenCalledWith("zen/gamma");
});

it("a short list has no search field", async () => {
  await mount(many.slice(0, 3));
  expect(search()).toBeNull();
  expect(options()).toHaveLength(3);
});

const withFooter = (onConnect = vi.fn()) => (close: () => void) => <ModelFooter error="499" onRetry={() => {}} onConnect={onConnect} close={close} />;
const footerEl = () => document.querySelector<HTMLElement>('[data-slot="select-footer"]');

it("GH-679 + GH-680: the search field and the pinned footer show together, and filtering keeps the footer", async () => {
  await mount(many, vi.fn(), withFooter());
  expect(search()).not.toBeNull();
  const popup = document.querySelector<HTMLElement>('[role="listbox"]')!.closest<HTMLElement>('[class*="overflow-hidden"]')!;
  expect(footerEl()!.parentElement).toBe(popup);
  expect(document.querySelector('[role="listbox"]')!.contains(footerEl())).toBe(false);
  expect(footerEl()!.querySelector('[data-testid="models-connect"]')).not.toBeNull();
  expect(footerEl()!.querySelector('[role="alert"]')).not.toBeNull();
  await type("gam");
  expect(options()).toEqual(["Gamma"]);
  expect(footerEl()!.querySelector('[data-testid="models-connect"]')).not.toBeNull();
  await type("nope");
  expect(options()).toEqual([]);
  expect(document.body.textContent).toContain("No models match");
  expect(footerEl()!.querySelector('[data-testid="models-connect"]')).not.toBeNull();
});

it("the footer's Connect closes the picker and calls back; a short list keeps the footer without a search field", async () => {
  const onConnect = vi.fn();
  await mount(many, vi.fn(), withFooter(onConnect));
  const trigger = document.querySelector<HTMLElement>('[data-testid="m"]')!;
  await act(async () => footerEl()!.querySelector<HTMLElement>('[data-testid="models-connect"]')!.click());
  expect(onConnect).toHaveBeenCalledTimes(1);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await act(async () => root!.unmount());
  document.body.innerHTML = "";
  await mount(many.slice(0, 3), vi.fn(), withFooter());
  expect(search()).toBeNull();
  expect(footerEl()!.querySelector('[data-testid="models-connect"]')).not.toBeNull();
});
