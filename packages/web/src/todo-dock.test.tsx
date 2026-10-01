// @vitest-environment jsdom
import type { TodoItem } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { showTodoDock, TodoDock } from "./todo-dock.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));

const items: TodoItem[] = [
  { content: "Inspect", status: "completed" },
  { content: "Change b", status: "in_progress", activeForm: "Changing b" },
  { content: "Test", status: "pending" },
];
const render = (todos: TodoItem[]) => act(async () => root.render(<TodoDock items={todos} />));
const toggle = () => el.querySelector<HTMLButtonElement>('[data-testid="todo-dock"] button')!;

describe("TodoDock", () => {
  it("shows progress, each item, and the active form of the in-progress item", async () => {
    await render(items);
    expect(toggle().textContent).toContain("1 of 3 todos completed");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const rows = [...el.querySelectorAll<HTMLElement>("[role=listitem]")];
    // Status is announced as text, not only by the aria-hidden mark and strikethrough.
    expect(rows.map((r) => [r.dataset.status, r.textContent])).toEqual([
      ["completed", "Completed: Inspect"],
      ["in_progress", "In progress: Changing b"],
      ["pending", "Pending: Test"],
    ]);
  });

  it("collapses to the header with the active todo as preview, and expands again", async () => {
    await render(items);
    expect(el.querySelector('[data-testid="todo-preview"]')).toBeNull();
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector("[role=listitem]")).toBeNull();
    expect(el.querySelector('[data-testid="todo-preview"]')?.textContent).toBe("Changing b");
    // Chevron down while open, up while collapsed (OpenCode).
    expect(toggle().querySelector("svg")!.getAttribute("class")).toContain("rotate-180");
    await act(async () => toggle().click());
    expect(toggle().querySelector("svg")!.getAttribute("class")).not.toContain("rotate-180");
    expect(el.querySelectorAll("[role=listitem]")).toHaveLength(3);
  });

  it("updates live: a new TodoWrite state replaces the list and keeps the collapse state", async () => {
    await render(items);
    await act(async () => toggle().click());
    await render([
      { content: "Inspect", status: "completed" },
      { content: "Change b", status: "completed" },
      { content: "Test", status: "in_progress", activeForm: "Testing" },
    ]);
    expect(toggle().textContent).toContain("2 of 3 todos completed");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector('[data-testid="todo-preview"]')?.textContent).toBe("Testing");
  });
});

describe("showTodoDock", () => {
  it("only while the turn is live and not blocked, with a list that is not all done (OpenCode)", () => {
    const done: TodoItem[] = [{ content: "a", status: "completed" }];
    expect(showTodoDock("running", items, false)).toBe(true);
    expect(showTodoDock("needs_input", items, false)).toBe(true);
    // A permission or question panel is open: OpenCode hides the composer region, dock included.
    expect(showTodoDock("needs_input", items, true)).toBe(false);
    expect(showTodoDock("running", items, true)).toBe(false);
    expect(showTodoDock("idle", items, false)).toBe(false);
    expect(showTodoDock("running", [], false)).toBe(false);
    expect(showTodoDock("running", done, false)).toBe(false);
  });
});
