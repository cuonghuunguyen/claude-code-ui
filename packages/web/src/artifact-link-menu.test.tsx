// @vitest-environment jsdom
// GH-512: a claude.ai artifact link opens a menu (card: Preview / Open in tab / Open on claude.ai; assistant text: Open in tab / Open on claude.ai).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MessageResponse } from "@/components/ai-elements/message";
import { ArtifactPreview, ArtifactPreviewContext, ArtifactTabContext, ArtifactUrlContext } from "./artifact-preview.tsx";
import { FILE_LINK_PROPS } from "./file-links.tsx";
import type { ToolCall } from "./store.ts";
import { ToolCard } from "./tool-card.tsx";

const URL = "https://claude.ai/artifact/PoBGcADWcBidR9fyEttcXn";
const call = (file = "/tmp/page.html"): ToolCall => ({ type: "tool_call", id: "p1", toolUseId: "p1", tool: "Artifact", input: { action: "publish", file_path: file, title: "T" }, status: "done" });
const out = { type: "tool_result", toolUseId: "p1", output: `Published ${URL}`, isError: false } as never;
const load = async () => ({ url: "/artifact/x/a.html", size: 1, mtime: 1 });

const el = document.body.appendChild(document.createElement("div"));
const root = createRoot(el);
afterEach(async () => {
  await act(async () => root.render(null));
  document.querySelectorAll("[role=menu]").forEach((n) => n.remove());
});
const render = (n: React.ReactNode) => act(async () => root.render(n));
const card = (tab?: () => void, c = call()) =>
  render(
    <ArtifactTabContext value={tab}>
      <ArtifactPreviewContext value={load}>
        <ToolCard call={c} result={out} awaiting />
      </ArtifactPreviewContext>
    </ArtifactTabContext>,
  );
const link = () => el.querySelector<HTMLAnchorElement>(`a[href="${URL}"]`)!;
const click = (init: MouseEventInit = {}) => {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  act(() => void link().dispatchEvent(e));
  return e;
};
const items = () => [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];

it("a previewable artifact link opens Preview / Open in tab / Open on claude.ai", async () => {
  await card(() => {});
  const e = click();
  expect(e.defaultPrevented).toBe(true);
  await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  expect(items().map((i) => i.dataset.testid)).toEqual(["artifact-link-preview", "artifact-link-tab", "artifact-link-claude"]);
  const a = items()[2] as HTMLAnchorElement;
  expect(a.getAttribute("href")).toBe(URL);
  expect(a.target).toBe("_blank");
  expect(a.rel).toContain("noopener");
});

it("Preview expands the inline preview", async () => {
  await card(() => {});
  expect(el.querySelector("[data-testid=artifact-preview-toggle]")).not.toBeNull();
  click();
  await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  await act(async () => items()[0]!.click());
  expect(el.querySelector("[data-testid=artifact-preview-toggle]")).toBeNull();
  expect(el.textContent).toContain("Hide preview");
});

it("Open in tab calls the ArtifactTabContext with the part id", async () => {
  const tab = vi.fn();
  await card(tab);
  click();
  await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  await act(async () => items()[1]!.click());
  expect(tab).toHaveBeenCalledWith("p1");
});

it("Escape returns the focus to the link", async () => {
  await card(() => {});
  link().focus();
  click({ detail: 0 });
  await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
  expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
  await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
  expect(document.activeElement).toBe(link());
});

it("Ctrl / Cmd / Shift / Alt click is not intercepted", async () => {
  await card(() => {});
  for (const m of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) expect(click({ [m]: true }).defaultPrevented).toBe(false);
  expect(items()).toEqual([]);
});

it("without ArtifactTabContext the link is a plain new-tab link; a non-html publish keeps the plain link", async () => {
  await card(undefined);
  expect(click().defaultPrevented).toBe(false);
  expect(link().getAttribute("aria-haspopup")).toBeNull();
  await card(() => {}, call("/tmp/a.txt"));
  expect(click().defaultPrevented).toBe(false);
});

it("ArtifactPreview: a controlled open follows the prop", async () => {
  await render(
    <ArtifactPreviewContext value={load}>
      <ArtifactPreview partId="p1" title="T" open />
    </ArtifactPreviewContext>,
  );
  expect(el.textContent).toContain("Hide preview");
  await render(
    <ArtifactPreviewContext value={load}>
      <ArtifactPreview partId="p1" title="T" open={false} />
    </ArtifactPreviewContext>,
  );
  expect(el.textContent).toContain("Show preview");
});

const md = (urls?: Map<string, string>, tab?: () => void) =>
  render(
    <ArtifactTabContext value={tab}>
      <ArtifactUrlContext value={urls}>
        <MessageResponse mode="static" {...FILE_LINK_PROPS}>
          {`See [the page](${URL}) and [other](https://claude.ai/artifact/other).`}
        </MessageResponse>
      </ArtifactUrlContext>
    </ArtifactTabContext>,
  ).then(() => act(async () => void (await new Promise((r) => setTimeout(r, 50)))));

it("a claude.ai link of a session publish in assistant text offers Open in tab and Open on claude.ai, no Preview", async () => {
  const tab = vi.fn();
  await md(new Map([[URL, "p1"]]), tab);
  expect(click().defaultPrevented).toBe(true);
  await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  expect(items().map((i) => i.dataset.testid)).toEqual(["artifact-link-tab", "artifact-link-claude"]);
  await act(async () => items()[0]!.click());
  expect(tab).toHaveBeenCalledWith("p1");
});

it("an unknown claude.ai link stays a plain link", async () => {
  await md(new Map([[URL, "p1"]]), () => {});
  // Only the known publish link carries the menu.
  expect(el.querySelectorAll("[aria-haspopup=menu]").length).toBe(1);
  expect(el.textContent).toContain("other");
});
