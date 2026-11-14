// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { InputDiff } from "./tool-card.tsx";
import { loadPierre } from "./diffs.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(async () => root.render(null)));

it("an Edit diff shows a skeleton of its size, then the library's diff once the chunk has loaded", async () => {
  await act(async () => root.render(<InputDiff tool="Edit" input={{ file_path: "/p/a.ts", old_string: "b = 2", new_string: "b = 3" }} />));
  // First render: Suspense fallback (jsdom resolves the dynamic import a tick later).
  const box = el.querySelector('[data-testid="edit-diff"]')!;
  expect(box).not.toBeNull();
  await vi.waitFor(() => expect(el.querySelector("diffs-container")).not.toBeNull(), { timeout: 10_000 });
  expect(el.querySelector('[data-testid="diff-skeleton"]')).toBeNull();
});

it("loadPierre registers the code themes, so a diff has them before it renders; a second call is the same load", async () => {
  const [a, b] = [loadPierre(), loadPierre()];
  expect(a).toBe(b);
  const pierre = await a;
  expect((await pierre.resolveTheme("claude-ui-light" as never)).name).toBe("claude-ui-light");
});
