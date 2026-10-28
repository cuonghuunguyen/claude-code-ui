// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MessageResponse } from "@/components/ai-elements/message";
import { FILE_LINK_PROPS, FileBaseContext, FileLinkContext } from "./file-links.tsx";
import { CwdContext } from "./tool-card.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MD = "Edit `src/a.ts:12` and `process.env`, see [the doc](docs/x.md#L3), [up](./y.md), [web](https://example.com/a) and [none](README).";

async function render(open: ((p: string, l?: number) => void) | undefined, base?: { base: string; root: string }) {
  const el = document.createElement("div");
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <CwdContext value="/w">
        <FileLinkContext value={open}>
          <FileBaseContext value={base}>
            <MessageResponse mode="static" {...FILE_LINK_PROPS}>
              {MD}
            </MessageResponse>
          </FileBaseContext>
        </FileLinkContext>
      </CwdContext>,
    ),
  );
  await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
  return { el, done: () => act(() => root.render(null)) };
}

it("inline code and relative links that are file references become buttons that call the handler with path and line; other code and links stay as they are", async () => {
  const open = vi.fn();
  const { el, done } = await render(open);
  const buttons = [...el.querySelectorAll<HTMLButtonElement>("button[title='Open in file dialog']")];
  expect(buttons.map((b) => b.textContent)).toEqual(["src/a.ts:12", "the doc", "up", "none"]);
  buttons[0]!.click();
  expect(open).toHaveBeenLastCalledWith("/w/src/a.ts", 12);
  buttons[1]!.click();
  expect(open).toHaveBeenLastCalledWith("/w/docs/x.md", 3);
  buttons[2]!.click();
  expect(open).toHaveBeenLastCalledWith("/w/y.md", undefined);
  expect([...el.querySelectorAll("code")].map((c) => c.textContent)).toEqual(["process.env"]);
  // An external link keeps Streamdown's own link (with its safety prompt).
  expect([...el.querySelectorAll("[data-streamdown=link]")].map((l) => l.textContent)).toEqual(["web"]);
  expect(el.textContent).toContain("none");
  expect(el.querySelector("[title^='Blocked']")).toBeNull();
  await done();
});

it("without a provider the same markdown is plain code and no file buttons", async () => {
  const { el, done } = await render(undefined);
  expect(el.querySelector("button[title='Open in file dialog']")).toBeNull();
  expect([...el.querySelectorAll("code")].map((c) => c.textContent)).toContain("src/a.ts:12");
  await done();
});

it("a FileBaseContext resolves relative references from the markdown file's folder", async () => {
  const open = vi.fn();
  const { el, done } = await render(open, { base: "/w/docs", root: "/w" });
  [...el.querySelectorAll<HTMLButtonElement>("button[title='Open in file dialog']")].at(-2)!.click();
  expect(open).toHaveBeenLastCalledWith("/w/docs/y.md", undefined);
  await done();
});

it("explicit link targets in a markdown file all open: ../, a bare name, an image file, #heading, %20, a #LN line", async () => {
  const open = vi.fn();
  const el = document.createElement("div");
  const root = createRoot(el);
  const md = "[readme](../README.md) [license](LICENSE) [logo](logo.png) [setup](setup.md#install) [notes](my%20notes.md) [line](a.ts#L7) [out](../../x.md)";
  await act(async () =>
    root.render(
      <CwdContext value="/w">
        <FileLinkContext value={open}>
          <FileBaseContext value={{ base: "/w/docs", root: "/w" }}>
            <MessageResponse mode="static" {...FILE_LINK_PROPS}>
              {md}
            </MessageResponse>
          </FileBaseContext>
        </FileLinkContext>
      </CwdContext>,
    ),
  );
  await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
  const buttons = [...el.querySelectorAll<HTMLButtonElement>("button[title='Open in file dialog']")];
  expect(buttons.map((b) => b.textContent)).toEqual(["readme", "license", "logo", "setup", "notes", "line"]);
  buttons.forEach((b) => b.click());
  expect(open.mock.calls).toEqual([["/w/README.md", undefined], ["/w/docs/LICENSE", undefined], ["/w/docs/logo.png", undefined], ["/w/docs/setup.md", undefined], ["/w/docs/my notes.md", undefined], ["/w/docs/a.ts", 7]]);
  expect(el.textContent).toContain("out");
  act(() => root.render(null));
});
