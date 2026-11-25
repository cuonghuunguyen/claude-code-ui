// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { QuickCompactCard, QuickCompactSourceContext } from "./quick-compact-card.tsx";

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));

it("shows the digest folded with a link to the source session", async () => {
  const open = vi.fn();
  const text = "[claude-ui quick compact] source=abc\nDIGEST BODY";
  await act(async () => root.render(<QuickCompactSourceContext value={{ open, title: (id) => (id === "abc" ? "Old chat" : undefined) }}><QuickCompactCard text={text} /></QuickCompactSourceContext>));
  const card = el.querySelector('[data-testid="quick-compact-card"]')!;
  expect(card.textContent).toContain("Old chat");
  expect(el.querySelector('[data-testid="quick-compact-text"]')).toBeNull();
  const toggle = el.querySelector<HTMLButtonElement>('[data-testid="quick-compact-toggle"]')!;
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(el.querySelector('[data-testid="quick-compact-text"]')!.textContent).toContain("DIGEST BODY");
  await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="quick-compact-source"]')!.click());
  expect(open).toHaveBeenCalledWith("abc");
});
