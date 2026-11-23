// @vitest-environment jsdom
// Contract of the addon preview page (docs/spec.md "Addon preview"): it draws every listed part, and the parts with state attributes in each state the
// part list documents. A part added to PART_NAMES without a sample here, or a state the UI stops drawing, fails here instead of going unseen by addon authors.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { PARTS, PART_NAMES } from "@claude-ui/protocol";
import { afterEach, expect, it } from "vitest";
import { AddonPreview } from "./addon-preview.tsx";

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));

const show = async () => {
  await act(async () => root.render(<AddonPreview onBack={() => {}} />));
  // The palette is a modal: it opens on request.
  await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="addon-preview-palette"]')!.click());
};
const values = (selector: string, attr: string) => [...new Set([...el.querySelectorAll(selector)].map((n) => n.getAttribute(attr)))].sort();

/** Parts the page cannot show without a theme: `backdrop` is the real fixed element, present only while the theme has a background image (backdrop.test.tsx). */
const NEEDS_THEME = ["backdrop"];

it("draws every listed part", async () => {
  await show();
  const drawn = new Set([...el.querySelectorAll("[data-part]")].map((n) => n.getAttribute("data-part")));
  expect(PART_NAMES.filter((n) => !drawn.has(n) && !NEEDS_THEME.includes(n))).toEqual([]);
  expect(PARTS.length).toBeGreaterThan(0);
});

it("draws each documented state of a part", async () => {
  await show();
  expect(values('[data-part="session-item"]', "data-state")).toEqual(["closed", "error", "idle", "needs_input", "running"]);
  expect(values('[data-part="tab"]', "data-state")).toEqual(expect.arrayContaining(["idle", "needs_input", "running", "unread"]));
  expect(values('[data-part="tool-card"]', "data-status")).toEqual(["denied", "done", "error", "pending", "running", "stopped"]);
  expect(values('[data-part="send"]', "data-state")).toEqual(["disconnected", "idle", "needs_input", "running"]);
  expect(values('[data-part="plan-window"]', "data-level")).toEqual(["limit", "ok", "warning"]);
  expect(values('[data-part="session-area"]', "data-phase")).toEqual(["idle", "thinking", "waiting"]);
  // The turn that ends flips to idle after a short delay (data-just-finished is checked by the lifecycle test).
  expect(el.querySelector('[data-part="focus-page"]')!.hasAttribute("data-focus-opened")).toBe(true);
});

it("the stand-ins are the shells and the daemon-backed panels only", async () => {
  await show();
  const names = values("[data-preview-standin]", "data-part").filter((n): n is string => !!n);
  expect(names).toEqual(["changed-file", "commit-message", "file-diff", "graph-panel", "session-area", "side-panel", "sidebar", "terminal", "terminal-tab", "titlebar", "work-area"]);
});
