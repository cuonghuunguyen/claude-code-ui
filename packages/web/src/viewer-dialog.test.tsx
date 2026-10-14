// @vitest-environment jsdom
import type { Part } from "@claude-ui/protocol";
import { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { sessionDiffChoice } from "./diff-mode.ts";
import { applyEvent, emptySession, type ToolCall } from "./store.ts";
import { CwdContext, ToolCard } from "./tool-card.tsx";
import { ViewerContext, useOpenViewer, type OpenViewer, type ViewerTarget } from "./viewer.ts";
import { ViewerDialog } from "./viewer-dialog.tsx";

vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: () => <div data-testid="pierre-diff" />,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
// jsdom has no layout: CodeMirror measures text through Range rects when it scrolls to the first line.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => {
  act(() => root.render(null));
  sessionDiffChoice.clear();
  localStorage.clear();
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join("\n");
type Req = { type: string; path?: string };
function fakeClient(handler: (m: Req) => unknown = (m) => (m.type === "fs.read" ? { content: lines(50), mtime: 1 } : {})) {
  const request = vi.fn(async (m: Req) => handler(m));
  return Object.assign({ request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>, { calls: request });
}
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const call = (tool: string, input: unknown): ToolCall => ({ type: "tool_call", id: "t1", toolUseId: "t1", tool, input, status: "done" });
const dialog = (p: { target?: ViewerTarget; client?: ReturnType<typeof fakeClient>; onClose?: () => void; opener?: HTMLElement | null; sessionId?: string; view?: ReturnType<typeof emptySession>; onOpenInEditor?: (path: string, line?: number) => void }) => (
  <ViewerDialog target={p.target} client={p.client ?? fakeClient()} cwd="/w" view={p.view} sessionId={p.sessionId} opener={p.opener} onClose={p.onClose ?? (() => {})} onOpenInEditor={p.onOpenInEditor ?? (() => {})} />
);
const open = async (p: Parameters<typeof dialog>[0]) => {
  await act(async () => root.render(dialog(p)));
  await flush();
};
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const click = (sel: string) => act(async () => (q(sel)!.click(), undefined));
const esc = (t: Element = document.activeElement ?? document.body) => act(async () => void t.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

it("a file target reads the file and shows it read-only at the given line", async () => {
  await open({ target: { kind: "file", path: "/w/a.ts", line: 40 } });
  expect(q("[data-testid=code-editor]")).not.toBeNull();
  const content = q(".cm-content")!;
  expect(content.textContent).toContain("l40");
  expect(content.getAttribute("tabindex")).toBe("0");
  const view = EditorView.findFromDOM(q(".cm-editor")!)!;
  expect(view.state.readOnly).toBe(true);
  expect(view.state.selection.main.head).toBe(view.state.doc.line(40).from);
});

it("a media file opens in the media viewer", async () => {
  const client = fakeClient((m) => (m.type === "fs.media" ? { url: "/media/x/p.png", mime: "image/png", size: 3, mtime: 1 } : {}));
  await open({ target: { kind: "file", path: "/w/p.png" }, client });
  expect(q<HTMLImageElement>("[data-testid=media-image]")!.getAttribute("src")).toMatch(/\/media\/x\/p\.png$/);
  expect(client.calls.mock.calls.some(([m]) => m.type === "fs.read")).toBe(false);
});

it("a file that cannot be read says why", async () => {
  const client = fakeClient(() => {
    throw Object.assign(new Error("binary"), { code: "binary", size: 2048 });
  });
  await open({ target: { kind: "file", path: "/w/a.bin" }, client });
  const err = q("[data-testid=viewer-error]")!;
  expect(err.textContent).toBe("Binary file, not shown (2 KB)");
  expect(err.getAttribute("role")).toBe("status");
});

it("Reload from disk reads the file again", async () => {
  const client = fakeClient();
  await open({ target: { kind: "file", path: "/w/a.ts" }, client });
  await click('[aria-label="Reload from disk"]');
  await flush();
  expect(client.calls.mock.calls.filter(([m]) => m.type === "fs.read")).toHaveLength(2);
});

it("a diff target shows the call's diff; File shows the current file", async () => {
  const client = fakeClient();
  const c = call("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" });
  await open({ target: { kind: "diff", call: c }, client });
  expect(q("[data-testid=edit-diff]")).not.toBeNull();
  expect(q("[data-testid=viewer-show-diff]")!.getAttribute("aria-pressed")).toBe("true");
  await click("[data-testid=viewer-show-file]");
  await flush();
  expect(client.calls).toHaveBeenCalledWith({ type: "fs.read", path: "/w/a.ts" });
  expect(q("[data-testid=code-editor]")).not.toBeNull();
  expect(q("[data-testid=viewer-show-file]")!.getAttribute("aria-pressed")).toBe("true");
});

it("a plan target renders markdown", async () => {
  await open({ target: { kind: "plan", plan: "# Plan\n\n- **one**" } });
  expect(q("[data-testid=viewer-plan]")!.querySelector('[data-streamdown="strong"]')).not.toBeNull();
});

it("the dialog is modal and labelled", async () => {
  await open({ target: { kind: "plan", plan: "x" } });
  const d = q("[role=dialog]")!;
  expect(d.getAttribute("aria-modal")).toBe("true");
  expect(document.getElementById(d.getAttribute("aria-labelledby")!)!.textContent).toBe("Plan");
  await open({ target: { kind: "file", path: "/w/src/a.ts" } });
  expect(document.getElementById(q("[role=dialog]")!.getAttribute("aria-labelledby")!)!.textContent).toBe("src/a.ts");
});

it("Esc closes and focus returns to the opener", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const onClose = vi.fn();
  await open({ target: { kind: "plan", plan: "x" }, opener, onClose });
  await esc();
  expect(onClose).toHaveBeenCalledOnce();
  await open({ target: undefined, opener, onClose });
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  opener.remove();
});

it("closing as App does (target and opener both cleared) returns focus to the opener, not the visible prompt box", async () => {
  const prompt = document.createElement("textarea");
  prompt.setAttribute("aria-label", "Prompt");
  // jsdom has no layout: the shown prompt box is the one with an offsetParent.
  Object.defineProperty(prompt, "offsetParent", { get: () => document.body });
  const opener = document.createElement("button");
  document.body.append(prompt, opener);
  opener.focus();
  await open({ target: { kind: "plan", plan: "x" }, opener });
  await open({ target: undefined, opener: undefined });
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  prompt.remove();
  opener.remove();
});

it("Esc inside an open CodeMirror search panel closes the panel, not the dialog", async () => {
  const onClose = vi.fn();
  await open({ target: { kind: "file", path: "/w/a.ts" }, onClose });
  const view = EditorView.findFromDOM(q(".cm-editor")!)!;
  await act(async () => (view.focus(), openSearchPanel(view)));
  expect(q(".cm-search")).not.toBeNull();
  await esc(q(".cm-search input")!);
  expect(q(".cm-search")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  await esc(view.contentDOM);
  expect(onClose).toHaveBeenCalledOnce();
});

it("Tab wraps inside the dialog", async () => {
  await open({ target: { kind: "plan", plan: "x" } });
  const close = q<HTMLElement>("[data-testid=viewer-close]")!;
  close.focus();
  await act(async () => void close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(q("[role=dialog]")!.contains(document.activeElement)).toBe(true);
  await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  expect(q("[role=dialog]")!.contains(document.activeElement)).toBe(true);
});

it("the changes target shows the Changes view without writing the side panel's mode", async () => {
  sessionDiffChoice.set("s1", { mode: "uncommitted" });
  const part: Part = { type: "tool_call", id: "e1", toolUseId: "e1", tool: "Edit", input: { file_path: "/w/a.ts", old_string: "a", new_string: "b" }, status: "done" };
  const view = applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part });
  const client = fakeClient((m) => (m.type === "git.status" ? { status: { branch: "main", added: 0, removed: 0 } } : m.type === "git.diff" ? { diff: { prefix: "", base: "b".repeat(40), files: [] } } : m.type === "git.log" ? { log: { commits: [], more: false, branches: [] } } : { content: "b\n", mtime: 1 }));
  await open({ target: { kind: "changes" }, client, view, sessionId: "s1" });
  expect(q("[data-testid=diff-mode]")!.textContent).toContain("Uncommitted");
  await click("[data-testid=diff-mode]");
  await act(async () => (q('[data-testid="diff-mode-session"]')!.click(), undefined));
  await flush();
  expect(q("[data-testid=diff-mode]")!.textContent).toContain("Session changes");
  expect(sessionDiffChoice.get("s1")).toEqual({ mode: "uncommitted" });
});

it("clicking a card's open button calls the viewer with the card's target and does not expand the card", async () => {
  const c = call("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" });
  const open = vi.fn();
  await act(async () =>
    root.render(
      <ViewerContext value={open}>
        <CwdContext value="/w">
          <ToolCard call={c} />
        </CwdContext>
      </ViewerContext>,
    ),
  );
  await click("[data-testid=viewer-open]");
  // The clicked button is the opener: Safari and Firefox on macOS do not focus a button on click.
  expect(open).toHaveBeenCalledWith({ kind: "diff", call: c }, q("[data-testid=viewer-open]"));
  expect(q("[data-testid=tool-card] [data-panel-open]")).toBeNull();
  // Expanding the card (its trigger carries data-panel-open) keeps the button visible: the head group must match that attribute.
  await act(async () => (q<HTMLElement>("[data-testid=tool-card] button[aria-expanded]")!.click(), undefined));
  const trigger = q("[data-testid=tool-card] [data-panel-open]")!;
  expect(trigger).not.toBeNull();
  const head = q("[data-testid=viewer-open]")!.parentElement!;
  expect(head.contains(trigger)).toBe(true);
  expect(head.className).toContain("group/head");
  expect(q("[data-testid=viewer-open]")!.className).toContain("group-has-[[data-panel-open]]/head:opacity-100");
  expect(q("[data-testid=viewer-open]")!.className).toContain("max-md:size-11");
});

it("useOpenViewer keeps one identity across renders and opens for the latest shown session", async () => {
  const seen: OpenViewer[] = [];
  const set = vi.fn();
  function Probe({ id }: { id: string }) {
    seen.push(useOpenViewer({ id, cwd: `/${id}` }, set));
    return null;
  }
  await act(async () => root.render(<Probe id="a" />));
  await act(async () => root.render(<Probe id="b" />));
  expect(seen.length).toBeGreaterThan(1);
  expect(new Set(seen).size).toBe(1);
  const btn = document.createElement("button");
  seen[0]!({ kind: "changes" }, btn);
  expect(set).toHaveBeenCalledWith({ target: { kind: "changes" }, sessionId: "b", cwd: "/b", opener: btn });
});

it("Open in Files tab on a file target calls onOpenInEditor with the path and the line; on a diff target with the edited file", async () => {
  const onOpenInEditor = vi.fn();
  await open({ target: { kind: "file", path: "/w/a.ts", line: 40 }, onOpenInEditor });
  expect(q("[data-testid=viewer-open-editor]")!.getAttribute("aria-label")).toBe("Open in Files tab");
  expect(q("[data-testid=viewer-open-editor]")!.className).toContain("max-md:size-11");
  await click("[data-testid=viewer-open-editor]");
  expect(onOpenInEditor).toHaveBeenLastCalledWith("/w/a.ts", 40);
  await open({ target: { kind: "diff", call: call("Edit", { file_path: "/w/b.ts", old_string: "a", new_string: "b" }) }, onOpenInEditor });
  await click("[data-testid=viewer-open-editor]");
  expect(onOpenInEditor).toHaveBeenLastCalledWith("/w/b.ts", undefined);
});
