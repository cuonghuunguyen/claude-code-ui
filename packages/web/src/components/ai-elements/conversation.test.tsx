// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConversationScrollButton } from "./conversation.tsx";

vi.mock("use-stick-to-bottom", () => ({ StickToBottom: () => null, useStickToBottomContext: () => ({ isAtBottom: false, scrollToBottom: () => {} }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("the scroll-to-bottom button has an accessible name and is a 44px target on a coarse pointer", async () => {
  const el = document.createElement("div");
  await act(async () => createRoot(el).render(<ConversationScrollButton />));
  const btn = el.querySelector("button")!;
  expect(btn.getAttribute("aria-label")).toBe("Scroll to bottom");
  expect(btn.className).toContain("pointer-coarse:size-11");
});
