// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { DeleteDialog } from "./session-actions.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => root?.unmount());

it("delete dialog: 12px radius like the other dialogs (rounded-2xl), pointer cursor on both buttons", async () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<DeleteDialog title="Fix login" onConfirm={() => {}} onCancel={() => {}} />));
  expect(document.querySelector('[data-testid="delete-dialog"]')!.className).toMatch(/\brounded-2xl\b/);
  for (const id of ["delete-cancel", "delete-confirm"]) expect(document.querySelector(`[data-testid="${id}"]`)!.className).toMatch(/\bcursor-pointer\b/);
});
