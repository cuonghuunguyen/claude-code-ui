// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SessionPane } from "./App.tsx";
import { emptySession } from "./store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

it("a failed prompt goes back into the prompt box and shows the error in the pane", async () => {
  const onPrompt = vi.fn(() => Promise.reject(new Error("no session s1")));
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const noop = () => {};
  await act(async () =>
    root.render(
      <SessionPane
        scrollKey={0}
        onInserted={noop}
        session={{ id: "s1", cwd: "/tmp", state: "idle", model: "default" }}
        view={emptySession()}
        models={[]}
        onModel={noop}
        onPrompt={onPrompt}
        onSearch={async () => []}
        onInterrupt={noop}
        onRewindPreview={async () => ({ filesChanged: [], insertions: 0, deletions: 0, conversation: false })}
        onRewind={async () => {}}
        onRespond={noop}
        onAnswer={noop}
      />,
    ),
  );
  const box = el.querySelector("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(box, "hello sandbox2");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => void box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(onPrompt).toHaveBeenCalledWith("hello sandbox2", []);
  expect(box.value).toBe("hello sandbox2");
  expect(el.querySelector('[data-testid="prompt-error"]')?.textContent).toContain("no session s1");
  root.unmount();
});
