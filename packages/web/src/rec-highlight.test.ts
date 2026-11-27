// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { sessionRow } from "./rec-highlight.ts";

// GH-1015: the quick-compact tip needs a sidebar row the user can see.
const row = (rect: { left: number; right: number }, display?: boolean) => {
  const el = document.createElement("button");
  el.setAttribute("data-testid", "session-item");
  el.setAttribute("data-session-id", "s1");
  el.getBoundingClientRect = () => ({ ...rect, top: 0, bottom: 10, width: rect.right - rect.left, height: 10, x: rect.left, y: 0, toJSON: () => ({}) });
  el.checkVisibility = () => display !== false;
  document.body.append(el);
  return el;
};
beforeEach(() => void (document.body.innerHTML = ""));

it("finds a row inside the window", () => {
  const el = row({ left: 0, right: 300 });
  expect(sessionRow("s1")).toBe(el);
});
it("ignores a row of a closed phone drawer (moved off screen), a display:none row and another session", () => {
  row({ left: -400, right: -40 });
  row({ left: 0, right: 300 }, false);
  expect(sessionRow("s1")).toBeUndefined();
  expect(sessionRow("s2")).toBeUndefined();
});
