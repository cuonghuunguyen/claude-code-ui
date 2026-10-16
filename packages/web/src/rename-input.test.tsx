// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RenameInput } from "./session-actions.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => (root?.unmount(), (document.body.innerHTML = "")));

async function mount(fromMenu: boolean) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const onDone = vi.fn();
  await act(async () => root!.render(<RenameInput title="Old" onDone={onDone} fromMenu={fromMenu} />));
  return { onDone, input: el.querySelector("input")! };
}

it("opened from a menu: a blur right away is the closing menu's focus return; the editor takes the focus back", async () => {
  const { onDone, input } = await mount(true);
  await act(async () => input.blur());
  await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  expect(onDone).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(input);
});

it("opened by a double click: a blur right away ends the edit (a typed title is saved)", async () => {
  const { onDone, input } = await mount(false);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "New");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.blur());
  expect(onDone).toHaveBeenCalledWith("New");
});
