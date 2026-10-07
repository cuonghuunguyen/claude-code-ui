// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SessionPane } from "./App.tsx";
import { applyEvent, emptySession } from "./store.ts";

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

it("Copy copies the raw markdown", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const { el } = await render("**bold**");
  await act(async () => void el.querySelector<HTMLElement>('button[title="Copy"]')!.click());
  expect(writeText).toHaveBeenCalledWith("**bold**");
});

it("uploads and images are unaffected", async () => {
  const { el, bubble } = await render("see @/tmp/claude-ui-Ab12Cd/u-Xy34Ef/notes.txt and more", ["data:image/png;base64,iVBORw0KGgo="]);
  expect(bubble.querySelector("img")).not.toBeNull();
  expect(bubble.textContent).not.toContain("u-Xy34Ef");
  expect(el.querySelector('[data-testid="attachment"]')).not.toBeNull();
});
