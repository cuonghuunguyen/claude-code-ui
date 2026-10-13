// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { QueuedPrompt } from "@claude-ui/protocol";
import { QueueChips } from "./queue-chips.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let unmount = () => {};
afterEach(() => unmount());

const item = (id: string, text: string, imageCount = 0): QueuedPrompt => ({ id, text, imageCount });

async function render(ui: React.ReactElement) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(ui));
  unmount = () => (root.unmount(), el.remove());
  return el;
}
const click = (el: Element | null | undefined) => act(async () => void (el as HTMLElement).click());

it("lists the messages with a count, an image badge and three labelled buttons per row", async () => {
  const el = await render(<QueueChips items={[item("a", "first message"), item("b", "with pics", 2)]} onSendNow={() => {}} onEdit={() => {}} onDelete={() => {}} />);
  const section = el.querySelector('section[aria-label="Queued messages"]')!;
  expect(section.textContent).toContain("Queued · 2");
  const rows = section.querySelectorAll("li");
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toContain("first message");
  expect(rows[1]!.textContent).toContain("+2 images");
  expect(rows[0]!.querySelector('[aria-label="Send now: first message"]')).not.toBeNull();
  expect(rows[0]!.querySelector('[aria-label="Edit: first message"]')).not.toBeNull();
  expect(rows[0]!.querySelector('[aria-label="Delete: first message"]')).not.toBeNull();
});

it("renders nothing for an empty queue", async () => {
  const el = await render(<QueueChips items={[]} onSendNow={() => {}} onEdit={() => {}} onDelete={() => {}} />);
  expect(el.querySelector("section")).toBeNull();
});

it("buttons call back with the item id", async () => {
  const onSendNow = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const el = await render(<QueueChips items={[item("a", "one"), item("b", "two")]} onSendNow={onSendNow} onEdit={onEdit} onDelete={onDelete} />);
  await click(el.querySelector('[aria-label="Send now: two"]'));
  await click(el.querySelector('[aria-label="Edit: one"]'));
  await click(el.querySelector('[aria-label="Delete: two"]'));
  expect(onSendNow).toHaveBeenCalledWith("b");
  expect(onEdit).toHaveBeenCalledWith("a");
  expect(onDelete).toHaveBeenCalledWith("b");
});

it("shows why the queue is paused", async () => {
  const at = new Date(2026, 0, 2, 14, 5).getTime();
  const held = async (h: React.ComponentProps<typeof QueueChips>["held"]) => {
    const el = await render(<QueueChips items={[item("a", "x")]} held={h} onSendNow={() => {}} onEdit={() => {}} onDelete={() => {}} />);
    const t = el.querySelector('[data-testid="queue-held"]')?.textContent ?? null;
    unmount();
    return t;
  };
  expect(await held(undefined)).toBeNull();
  expect(await held({ reason: "usage_limit", until: at })).toMatch(/^Paused until .*(14:05|2:05).* \(usage limit\)$/);
  expect(await held({ reason: "usage_limit" })).toBe("Paused until you send a message (usage limit)");
  expect(await held({ reason: "not_live" })).toBe("Paused: the session stopped with an error");
});

it("after Delete focus moves to the same button of the next row, else the previous row, else onEmpty", async () => {
  const onEmpty = vi.fn();
  function Host() {
    const [items, setItems] = useState([item("a", "one"), item("b", "two"), item("c", "three")]);
    return <QueueChips items={items} onSendNow={() => {}} onEdit={() => {}} onDelete={(id) => setItems((l) => l.filter((i) => i.id !== id))} onEmpty={onEmpty} />;
  }
  const el = await render(<Host />);
  await click(el.querySelector('[aria-label="Delete: two"]'));
  expect(document.activeElement).toBe(el.querySelector('[aria-label="Delete: three"]'));
  await click(el.querySelector('[aria-label="Delete: three"]'));
  expect(document.activeElement).toBe(el.querySelector('[aria-label="Delete: one"]'));
  await click(el.querySelector('[aria-label="Delete: one"]'));
  expect(onEmpty).toHaveBeenCalled();
});

it("touch targets are 44px (size-11) below md and on coarse pointers; rows truncate", async () => {
  const el = await render(<QueueChips items={[item("a", "x".repeat(300))]} onSendNow={() => {}} onEdit={() => {}} onDelete={() => {}} />);
  const b = el.querySelector("li button")!;
  expect(b.className).toContain("size-7");
  expect(b.className).toContain("pointer-coarse:size-11");
  expect(b.className).toContain("max-md:size-11");
  expect(el.querySelector("li .truncate")!.getAttribute("title")).toBe("x".repeat(300));
});
