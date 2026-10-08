// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SessionPane } from "./App.tsx";
import { applyEvent, emptySession } from "./store.ts";
import { MessageResponse } from "@/components/ai-elements/message";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};

const noop = () => {};
let unmount = noop;
afterEach(() => unmount());

const user = (text: string, images: string[] = []) =>
  applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "user_text", id: "u1", text, images } });

async function render(text: string, images: string[] = []) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const props: ComponentProps<typeof SessionPane> = {
    scrollKey: 0,
    onInserted: noop,
    session: { id: "s1", cwd: "/tmp", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"] },
    view: user(text, images),
    models: [],
    onModel: noop,
    onMode: noop,
    onEffort: noop,
    onUpload: async () => "/tmp/u/x.txt",
    onPrompt: async () => {},
    onSearch: async () => [],
    onInterrupt: noop,
    onRewindPreview: async () => ({ filesChanged: [], insertions: 0, deletions: 0, conversation: false }),
    onRewind: async () => {},
    onRespond: noop,
    onAnswer: noop,
    connected: true,
  };
  await act(async () => root.render(<SessionPane {...props} />));
  unmount = () => (root.unmount(), el.remove());
  return { el, bubble: el.querySelector<HTMLElement>('[data-testid="user-message"]')! };
}

it("user bubble renders markdown with the assistant renderer", async () => {
  const { bubble } = await render("**bold** and `code`\n\n```ts\nconst a = 1;\n```\n\n- a\n- b");
  expect(bubble.querySelector('[data-streamdown="strong"]')?.textContent).toBe("bold");
  expect(bubble.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe("code");
  expect(bubble.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
  expect(bubble.querySelectorAll("li")).toHaveLength(2);
});

it("typed HTML stays visible text", async () => {
  const a = await render("fix the <Button> component");
  expect(a.bubble.textContent).toContain("<Button>");
  unmount();
  const b = await render("<script>x</script>");
  expect(b.bubble.querySelector("script")).toBeNull();
  expect(b.bubble.textContent).toContain("<script>x</script>");
});

it("a single newline is a line break and the bubble does not use pre-wrap", async () => {
  const { bubble } = await render("one\ntwo");
  expect(bubble.querySelectorAll("br")).toHaveLength(1);
  expect(bubble.innerHTML).not.toContain("whitespace-pre-wrap");
});

it("a paragraph starting with a tag (HTML block) keeps its line breaks and shows as text", async () => {
  const a = await render(["<Button>", "a", "b"].join("\n"));
  expect(a.bubble.querySelectorAll("br")).toHaveLength(2);
  expect(a.bubble.textContent).toContain("<Button>");
  unmount();
  const b = await render(["<div> x", "y"].join("\n"));
  expect(b.bubble.querySelectorAll("br")).toHaveLength(1);
  expect(b.bubble.textContent).toContain("<div> x");
  unmount();
  const c = await render(["<script>alert(1)</script>", "z"].join("\n"));
  expect(c.bubble.querySelector("script")).toBeNull();
  expect(c.bubble.textContent).toContain("<script>alert(1)</script>");
  expect(c.bubble.textContent).toContain("z");
});

it("Copy copies the raw markdown", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const { el } = await render("**bold**");
  await act(async () => void el.querySelector<HTMLElement>('button[title="Copy"]')!.click());
  expect(writeText).toHaveBeenCalledWith("**bold**");
});

it("a code block in a user message is not syntax highlighted (no token spans to build on every scroll)", async () => {
  // Control: the assistant renderer highlights the same block once the highlighter has loaded.
  const code = "```ts\nconst a = 1;\nfunction f(x: number) { return x + a; }\n```";
  const box = document.createElement("div");
  document.body.append(box);
  const control = createRoot(box);
  await act(async () => control.render(<MessageResponse mode="static">{code}</MessageResponse>));
  const tokens = '[data-streamdown="code-block"] span[style*="--sdm-c"]';
  // Highlighted: a span per token (more than one per line).
  await vi.waitFor(() => expect(box.querySelectorAll(tokens).length).toBeGreaterThan(2), { timeout: 10_000 });
  const { bubble } = await render(code);
  await act(async () => new Promise((r) => setTimeout(r, 200)));
  expect(bubble.querySelector('[data-streamdown="code-block"]')?.textContent).toContain("const a = 1;");
  // Plain: at most one span per line, uncolored.
  expect(bubble.querySelectorAll(tokens).length).toBeLessThanOrEqual(2);
  expect(bubble.querySelector('[data-streamdown="code-block"] span[style*="--sdm-c: #"]')).toBeNull();
  control.unmount();
  box.remove();
});

it("uploads and images are unaffected", async () => {
  const { el, bubble } = await render("see @/tmp/claude-ui-Ab12Cd/u-Xy34Ef/notes.txt and more", ["data:image/png;base64,iVBORw0KGgo="]);
  expect(bubble.querySelector("img")).not.toBeNull();
  expect(bubble.textContent).not.toContain("u-Xy34Ef");
  expect(el.querySelector('[data-testid="attachment"]')).not.toBeNull();
});
