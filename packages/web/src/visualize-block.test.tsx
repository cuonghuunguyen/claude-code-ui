// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageResponse } from "./components/ai-elements/message.tsx";
import { VisualizeBlock, VisualizeContext, VisualizeFence } from "./visualize-block.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no IntersectionObserver: every block is "near".
beforeEach(() => {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    constructor(private cb: (e: { target: Element; isIntersecting: boolean }[]) => void) {}
    observe(target: Element) {
      this.cb([{ target, isIntersecting: true }]);
    }
    unobserve() {}
    disconnect() {}
  };
});
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => (act(() => root?.unmount()), (document.body.innerHTML = "")));
async function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(node));
  return el;
}
const frameOf = (el: Element) => el.querySelector<HTMLIFrameElement>('[data-testid="visualize-frame"]')!;
/** A message from `source` to the window, as the frame would post it. */
const from = (source: unknown, data: unknown) => act(async () => void window.dispatchEvent(new MessageEvent("message", { source: source as Window, data })));

it("an incomplete fence is a code block without a frame", async () => {
  const el = await mount(<VisualizeFence code="<p>x</p>" isIncomplete language="visualize" />);
  expect(el.querySelector("iframe")).toBeNull();
  expect(el.textContent).toContain("<p>x</p>");
});

it("a complete fence is a frame of /visualize with exactly allow-scripts", async () => {
  const el = await mount(<VisualizeFence code="<p>x</p>" isIncomplete={false} language="visualize" />);
  const f = frameOf(el);
  expect(f.getAttribute("sandbox")).toBe("allow-scripts");
  expect(f.getAttribute("src")).toBe("/visualize");
  expect(f.getAttribute("referrerpolicy")).toBe("no-referrer");
});

it("only the frame's own messages count: ready posts the code, height is clamped, junk is ignored", async () => {
  const el = await mount(<VisualizeBlock code="<p>hi</p>" />);
  const f = frameOf(el);
  const post = vi.fn();
  Object.defineProperty(f, "contentWindow", { value: { postMessage: post } });
  await from({}, { v: 1, type: "ready" }); // another window
  expect(post).not.toHaveBeenCalled();
  await from(f.contentWindow, { v: 2, type: "ready" }); // wrong version
  expect(post).not.toHaveBeenCalled();
  await from(f.contentWindow, { v: 1, type: "ready" });
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ v: 1, type: "render", html: "<p>hi</p>" }), "*");
  await from(f.contentWindow, { v: 1, type: "height", height: 5000 });
  expect(frameOf(el).style.height).toBe("800px");
  await from(f.contentWindow, { v: 1, type: "height", height: "x" });
  await from(f.contentWindow, { v: 1, type: "height", height: Infinity });
  expect(frameOf(el).style.height).toBe("800px");
  await from(f.contentWindow, { v: 1, type: "height", height: 120 });
  expect(frameOf(el).style.height).toBe("120px");
});

it("a theme change re-sends the colours with the scheme to the frame", async () => {
  document.documentElement.classList.remove("dark");
  const el = await mount(<VisualizeBlock code="<p>hi</p>" />);
  const f = frameOf(el);
  const post = vi.fn();
  Object.defineProperty(f, "contentWindow", { value: { postMessage: post } });
  await act(async () => {
    document.documentElement.classList.add("dark");
    await new Promise((r) => setTimeout(r, 0)); // MutationObserver
  });
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ v: 1, type: "theme", vars: expect.objectContaining({ "--scheme": "dark" }) }), "*");
  document.documentElement.classList.remove("dark");
});

it("Show code swaps the frame for the source and back", async () => {
  const el = await mount(<VisualizeBlock code="<p>src</p>" />);
  const btn = () => el.querySelector<HTMLElement>('[data-testid="visualize-show-code"]')!;
  await act(async () => btn().click());
  expect(el.querySelector("iframe")).toBeNull();
  expect(el.textContent).toContain("<p>src</p>");
  expect(btn().getAttribute("aria-pressed")).toBe("true");
  await act(async () => btn().click());
  expect(frameOf(el)).not.toBeNull();
});

it("MessageResponse: the setting on draws the frame, off shows the fence as code", async () => {
  const md = "```visualize\n<p>chart</p>\n```";
  const on = await mount(
    <VisualizeContext value>
      <MessageResponse mode="static">{md}</MessageResponse>
    </VisualizeContext>,
  );
  expect(frameOf(on)).not.toBeNull();
  act(() => root?.unmount());
  const off = await mount(<MessageResponse mode="static">{md}</MessageResponse>);
  expect(off.querySelector("iframe")).toBeNull();
  expect(off.textContent).toContain("chart");
});
