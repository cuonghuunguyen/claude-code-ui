// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Label } from "@claude-ui/protocol";
import { LabelDialog } from "./label-dialog.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

async function render(o: { label?: Label; onSave?: (l: Label | undefined) => Promise<void> } = {}) {
  const onSave = vi.fn(o.onSave ?? (async () => {}));
  const onClose = vi.fn();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<LabelDialog open title="Name and icon of app" fallbackName="app" label={o.label} onSave={onSave} onClose={onClose} />));
  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const type = async (id: string, v: string) =>
    act(async () => {
      const i = q(id) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(i, v);
      i.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const click = async (id: string) => act(async () => q(id)!.click());
  const file = async (f: File) =>
    act(async () => {
      const i = q("label-file") as HTMLInputElement;
      Object.defineProperty(i, "files", { value: [f], configurable: true });
      i.dispatchEvent(new Event("change", { bubbles: true }));
    });
  return { q, type, click, file, onSave, onClose };
}

it("Save sends the trimmed name and the emoji, then closes", async () => {
  const { type, click, onSave, onClose } = await render();
  await type("label-name", "  Shop ");
  await click("label-icon-emoji");
  await type("label-emoji", "🛒");
  await click("label-save");
  expect(onSave).toHaveBeenCalledWith({ name: "Shop", icon: "🛒" });
  expect(onClose).toHaveBeenCalled();
});

it("Save with nothing set resets; Reset sends undefined and is disabled without a label", async () => {
  const a = await render();
  expect((a.q("label-reset") as HTMLButtonElement).disabled).toBe(true);
  await a.click("label-save");
  expect(a.onSave).toHaveBeenCalledWith(undefined);
  act(() => root!.unmount());
  document.body.innerHTML = "";
  const b = await render({ label: { name: "Shop", icon: "🛒" } });
  expect((b.q("label-name") as HTMLInputElement).value).toBe("Shop");
  expect((b.q("label-emoji") as HTMLInputElement).value).toBe("🛒");
  await b.click("label-reset");
  expect(b.onSave).toHaveBeenCalledWith(undefined);
});

it("a daemon refusal shows inline and keeps the dialog open", async () => {
  const { type, click, q, onClose } = await render({ onSave: async () => Promise.reject(new Error("Project names and icons must be x")) });
  await type("label-name", "Shop");
  await click("label-save");
  expect(q("label-error")?.textContent).toBe("Project names and icons must be x");
  expect(q("label-error")?.getAttribute("role")).toBe("alert");
  expect(onClose).not.toHaveBeenCalled();
});

it("an image of a wrong type or over 10 MB is refused with a message", async () => {
  const { click, file, q } = await render();
  await click("label-icon-image");
  await file(new File(["x"], "a.svg", { type: "image/svg+xml" }));
  expect(q("label-error")?.textContent).toContain("not a PNG");
  await file(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }));
  expect(q("label-error")?.textContent).toContain("10 MB");
  expect(q("label-crop")).toBeNull();
});

it("an image that cannot be decoded shows the decode error", async () => {
  URL.createObjectURL ??= () => "blob:x";
  URL.revokeObjectURL ??= () => {};
  const orig = globalThis.Image;
  globalThis.Image = class {
    onload?: () => void;
    onerror?: () => void;
    set src(_: string) {
      queueMicrotask(() => this.onerror?.());
    }
  } as never;
  try {
    const { click, file, q } = await render();
    await click("label-icon-image");
    await file(new File(["x"], "a.png", { type: "image/png" }));
    await act(async () => {});
    expect(q("label-error")?.textContent).toContain("cannot be read");
  } finally {
    globalThis.Image = orig;
  }
});
