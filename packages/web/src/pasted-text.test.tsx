// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PasteChips, PastedBlock } from "./pasted-text.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));

const body = Array.from({ length: 200 }, (_, i) => `line-${i + 1}`).join("\n");

it("PastedBlock is collapsed with the line count and expands on click", async () => {
  await act(async () => root.render(<PastedBlock body={body} id="t:0" />));
  const trigger = el.querySelector<HTMLButtonElement>('[data-testid="pasted-block"]')!;
  expect(trigger.textContent).toContain("Pasted text · 199 lines");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(el.querySelector('[data-testid="pasted-block-body"]')?.textContent).toContain("line-200");
});

it("PastedBlock stays expanded when its bubble remounts (pending prompt replaced by the echo, scrolled out of the window)", async () => {
  const Pending = () => (
    <div data-testid="pending">
      <PastedBlock body={body} id="m1:0" />
    </div>
  );
  const Echoed = () => (
    <section>
      <PastedBlock body={body} id="m1:0" />
    </section>
  );
  await act(async () => root.render(<Pending />));
  await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="pasted-block"]')!.click());
  expect(el.querySelector('[data-testid="pasted-block-body"]')).not.toBeNull();
  await act(async () => root.render(<Echoed />)); // another element type: React remounts the block
  expect(el.querySelector('[data-testid="pasted-block"]')!.getAttribute("aria-expanded")).toBe("true");
  expect(el.querySelector('[data-testid="pasted-block-body"]')?.textContent).toContain("line-200");
  await act(async () => root.render(<PastedBlock body={body} id="m2:0" />)); // another block stays collapsed
  expect(el.querySelector('[data-testid="pasted-block"]')!.getAttribute("aria-expanded")).toBe("false");
  await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="pasted-block"]')!.click());
  await act(async () => root.render(<PastedBlock body={body} id="m1:0" />)); // collapsing again is remembered too
  await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="pasted-block"]')!.click());
  await act(async () => root.render(<Pending />));
  expect(el.querySelector('[data-testid="pasted-block"]')!.getAttribute("aria-expanded")).toBe("false");
});

it("PasteChips shows one chip per token in text order; Remove calls onRemove with its id; View opens the full text", async () => {
  const onRemove = vi.fn();
  const text = "x [Pasted text #2 +199 lines] y [Pasted text #1 +3 lines] [Pasted text #9]";
  await act(async () => root.render(<PasteChips text={text} pastes={{ 1: "a\nb\nc\nd", 2: body }} onRemove={onRemove} />));
  const chips = [...el.querySelectorAll('[data-testid="paste-chip"]')];
  expect(chips.map((c) => c.textContent)).toEqual(["Pasted text #2 · 199 lines", "Pasted text #1 · 3 lines"]);
  await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Remove pasted text #1"]')!.click());
  expect(onRemove).toHaveBeenCalledWith(1);
  await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="View pasted text #2"]')!.click());
  const viewer = document.querySelector('[data-testid="paste-viewer"]');
  expect(viewer?.textContent).toContain("line-200");
});
