// @vitest-environment jsdom
// GH-564: Annotate (git blame gutter) in the Files-tab editor.
import { EditorView } from "@codemirror/view";
import type { GitRepo } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { createEditorStore } from "./editor-store.ts";
import { FilesPanel } from "./files-panel.tsx";

window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;

const A = "a".repeat(40);
const B = "b".repeat(40);
const main: GitRepo = { path: "/p", rel: "", kind: "main" };
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

async function setup(over: { repos?: { list: GitRepo[]; projectKey: string }; blame?: () => unknown; mtime?: number } = {}) {
  const calls: { type: string; [k: string]: unknown }[] = [];
  const request = vi.fn(async (m: { type: string; path?: string }) => {
    calls.push(m);
    if (m.type === "fs.list") return { entries: [{ name: "a.ts", path: "/p/a.ts", isDir: false }] };
    if (m.type === "fs.read") return { content: "one\ntwo\nthree\n", mtime: over.mtime ?? 1 };
    if (m.type === "git.blame") return over.blame ? over.blame() : { blame: { commits: { [A]: { author: "Ann", time: 1700000000, summary: "first" }, [B]: { author: "Bob", time: 1700100000, summary: "second" } }, lines: [A, null, B, B] } };
    return {};
  });
  const client = { request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>;
  const store = createEditorStore(() => client);
  await store.open("/p/a.ts", { cwd: "/p", preview: false });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const onOpenCommit = vi.fn();
  await act(async () => root!.render(<FilesPanel client={client} status="connected" cwd="/p" editors={store} repos={"repos" in over ? over.repos : { list: [main], projectKey: "/p" }} onOpenCommit={onOpenCommit} onSend={() => {}} showTree={false} onToggleTree={() => {}} />));
  const q = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const marks = () => [...el.querySelectorAll<HTMLElement>(".cm-blame-mark")];
  return { calls, q, el, store, onOpenCommit, marks, blames: () => calls.filter((c) => c.type === "git.blame") };
}

it("no toggle outside a repository", async () => {
  const { q } = await setup({ repos: undefined });
  expect(q("editor-annotate")).toBeNull();
});

it("toggle on sends one git.blame for the file's repository; the gutter shows hash, author and not committed; typing sends none", async () => {
  const { q, blames, marks, el } = await setup();
  expect(blames()).toEqual([]);
  expect(q("editor-annotate")!.getAttribute("aria-pressed")).toBe("false");
  await act(async () => q("editor-annotate")!.click());
  await flush();
  expect(q("editor-annotate")!.getAttribute("aria-pressed")).toBe("true");
  expect(blames()).toMatchObject([{ cwd: "/p", exact: true, path: "a.ts" }]);
  expect(marks().map((m) => m.textContent)).toEqual([expect.stringMatching(/^aaaaaaa .+ Ann$/), "not committed", expect.stringMatching(/^bbbbbbb .+ Bob$/)]);
  expect(marks().map((m) => m.getAttribute("aria-label"))).toEqual([expect.stringMatching(/^Commit aaaaaaa by Ann, /), "Not committed", expect.stringMatching(/^Commit bbbbbbb by Bob, /)]);
  expect(marks().every((m) => m.tabIndex === 0 && m.getAttribute("role") === "button")).toBe(true);
  // Typing: the markers follow the lines, no new request, a dirty tab shows no notice once annotated.
  const view = EditorView.findFromDOM(el.querySelector<HTMLElement>(".cm-editor")!)!;
  await act(async () => view.dispatch({ changes: { from: 0, insert: "new\n" } }));
  expect(blames()).toHaveLength(1);
  expect(marks()).toHaveLength(3);
});

it("a click and Enter / Space on a commit marker call onOpenCommit(repo, hash); not committed does nothing", async () => {
  const { q, marks, onOpenCommit } = await setup();
  await act(async () => q("editor-annotate")!.click());
  await flush();
  await act(async () => marks()[0]!.click());
  expect(onOpenCommit).toHaveBeenLastCalledWith(main, A);
  await act(async () => void marks()[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(onOpenCommit).toHaveBeenLastCalledWith(main, B);
  await act(async () => void marks()[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })));
  expect(onOpenCommit).toHaveBeenCalledTimes(3);
  await act(async () => (marks()[1]!.click(), marks()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))));
  expect(onOpenCommit).toHaveBeenCalledTimes(3);
  expect(marks()[1]!.getAttribute("aria-disabled")).toBe("true");
});

it("a dirty tab gets the save notice and no request", async () => {
  const { q, blames, el } = await setup();
  const view = EditorView.findFromDOM(el.querySelector<HTMLElement>(".cm-editor")!)!;
  await act(async () => view.dispatch({ changes: { from: 0, insert: "x" } }));
  await act(async () => q("editor-annotate")!.click());
  await flush();
  expect(blames()).toEqual([]);
  expect(q("annotate-notice")!.textContent).toBe("Save the file to annotate it.");
});

it("too_large shows the size in a notice, the editor stays", async () => {
  const { q, el } = await setup({ blame: () => Promise.reject(Object.assign(new Error("larger than 2097152 bytes"), { code: "too_large", size: 3 * 1024 * 1024 })) });
  await act(async () => q("editor-annotate")!.click());
  await flush();
  expect(q("annotate-notice")!.textContent).toBe("File too large to annotate (3 MB).");
  expect(el.querySelector(".cm-editor")).not.toBeNull();
  expect(el.querySelector(".cm-blame")).toBeNull();
});

it("an untracked file marks every line not committed", async () => {
  const { q, marks } = await setup({ blame: () => ({ blame: { commits: {}, lines: [], untracked: true } }) });
  await act(async () => q("editor-annotate")!.click());
  await flush();
  expect(marks().map((m) => m.textContent)).toEqual(["not committed"]);
});
