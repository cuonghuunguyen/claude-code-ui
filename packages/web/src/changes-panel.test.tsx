// @vitest-environment jsdom
import type { Part } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ChangesPanel } from "./changes-panel.tsx";
import type { connect } from "./client.ts";
import { applyEvent, emptySession, type SessionView } from "./store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
// Viewport below md when true.
let narrow = false;
window.matchMedia = ((query: string) => ({
  matches: narrow && query.includes("max-width"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
})) as never;

const edit = (id: string, file_path: string, old_string: string, new_string: string): Part => ({
  type: "tool_call",
  id,
  toolUseId: id,
  tool: "Edit",
  input: { file_path, old_string, new_string },
  status: "done",
});
const original = (id: string, text: string): Part => ({ type: "tool_result", id: `${id}:result`, toolUseId: id, output: "ok", isError: false, original: text });
const view = (parts: Part[]): SessionView =>
  parts.reduce((s, part, i) => applyEvent(s, { type: "event", sessionId: "s1", seq: i + 1, part }), emptySession());

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => {
  act(() => root.render(null));
  narrow = false;
  localStorage.clear();
});

function fakeClient(files: Record<string, string>) {
  const request = vi.fn(async (m: { type: string; path: string }) => {
    if (m.path in files) return { content: files[m.path], mtime: 1 };
    throw new Error("fs_error: ENOENT");
  });
  const listeners = new Set<(m: { path: string }) => void>();
  const onFsChanged = (l: (m: { path: string }) => void) => (listeners.add(l), () => void listeners.delete(l));
  const changed = (path: string) => listeners.forEach((l) => l({ path }));
  return Object.assign({ request, onFsChanged } as unknown as ReturnType<typeof connect>, { changed });
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const rows = () => [...el.querySelectorAll("[data-testid=changed-file]")].map((b) => b.textContent);

it("lists changed files with whole-file +N -N and opens the selected one in the editor", async () => {
  const disk = { "/p/src/a.ts": "a = 2\nb\n", "/p/b.ts": "x = 9\n" };
  const client = fakeClient(disk);
  const onOpen = vi.fn();
  const parts = [edit("e1", "/p/src/a.ts", "a = 1", "a = 2"), edit("e2", "/p/b.ts", "x = 1", "x = 9")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(parts)} cwd="/p" onOpen={onOpen} />));
  await flush();
  expect(el.textContent).toContain("2 Changed files");
  expect(rows()).toEqual(["a.tssrc+1-1", "b.ts+1-1"]);
  expect(el.querySelector("[data-testid=changed-file]")!.getAttribute("aria-current")).toBe("true");

  await act(async () => (el.querySelectorAll<HTMLButtonElement>("[data-testid=changed-file]")[1]!.click(), undefined));
  expect(el.querySelector("[data-testid=file-diff]")!.textContent).toContain("b.ts");
  await act(async () => (el.querySelector<HTMLButtonElement>("[data-testid=open-in-editor]")!.click(), undefined));
  expect(onOpen).toHaveBeenCalledWith("/p/b.ts");
});

it("re-reads the files when Claude changes one more time (live)", async () => {
  const disk: Record<string, string> = { "/p/a.ts": "a = 2\n" };
  const client = fakeClient(disk);
  const first = [edit("e1", "/p/a.ts", "a = 1", "a = 2")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(first)} cwd="/p" onOpen={() => {}} />));
  await flush();
  expect(rows()).toEqual(["a.ts+1-1"]);

  disk["/p/a.ts"] = "a = 2\nc\n";
  const next = [...first, edit("e2", "/p/a.ts", "a = 2", "a = 2\nc")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(next)} cwd="/p" onOpen={() => {}} />));
  await flush();
  expect(rows()).toEqual(["a.ts+2-1"]);
});

it("re-reads a listed file changed outside the session (fs.changed)", async () => {
  const disk: Record<string, string> = { "/p/a.ts": "a = 2\n" };
  const client = fakeClient(disk);
  await act(async () => root.render(<ChangesPanel client={client} view={view([edit("e1", "/p/a.ts", "a = 1", "a = 2"), original("e1", "a = 1\n")])} cwd="/p" onOpen={() => {}} />));
  await flush();
  disk["/p/a.ts"] = "a = 2\nbash\n";
  client.changed("/p/other.ts");
  await flush();
  expect(rows()).toEqual(["a.ts+1-1"]);
  client.changed("/p/a.ts");
  await flush();
  expect(rows()).toEqual(["a.ts+2-1"]);
});

it("desktop defaults to split; the unified/split choice is kept per browser across remounts", async () => {
  const client = fakeClient({ "/p/a.ts": "a = 2\n" });
  const panel = () => <ChangesPanel client={client} view={view([edit("e1", "/p/a.ts", "a = 1", "a = 2")])} cwd="/p" onOpen={() => {}} />;
  const pressed = (s: string) => el.querySelector(`[data-testid=diff-${s}]`)!.getAttribute("aria-pressed");
  await act(async () => root.render(panel()));
  await flush();
  expect([pressed("unified"), pressed("split")]).toEqual(["false", "true"]);
  expect(el.querySelector("[data-testid=file-diff]")!.getAttribute("data-diff-style")).toBe("split");
  await act(async () => (el.querySelector<HTMLButtonElement>("[data-testid=diff-unified]")!.click(), undefined));
  await act(async () => root.render(null));
  await act(async () => root.render(panel()));
  await flush();
  expect([pressed("unified"), pressed("split")]).toEqual(["true", "false"]);
});

it("below md the diff is unified without a toggle, and the actions are at least 8px apart", async () => {
  narrow = true;
  localStorage.setItem("claude-ui.diffStyle", "split");
  await act(async () =>
    root.render(<ChangesPanel client={fakeClient({ "/p/a.ts": "a = 2\n" })} view={view([edit("e1", "/p/a.ts", "a = 1", "a = 2")])} cwd="/p" onOpen={() => {}} />),
  );
  await flush();
  expect(el.querySelector("[data-testid=diff-split]")).toBeNull();
  expect(el.querySelector("[data-testid=file-diff]")!.getAttribute("data-diff-style")).toBe("unified");
  expect(el.querySelector("[data-testid=changes-actions]")!.className).toContain("max-md:gap-2");
});

it("shows an empty state without changes", async () => {
  await act(async () => root.render(<ChangesPanel client={fakeClient({})} view={view([])} cwd="/p" onOpen={() => {}} />));
  expect(el.querySelector("[data-testid=changes-empty]")!.textContent).toContain("No changes");
});

it("the changes pane tab shows the changed file count, like OpenCode's Files Changed N", async () => {
  const { PaneTabs } = await import("./App.tsx");
  await act(async () => root.render(<PaneTabs panes={["changes", "files"]} value="files" onChange={() => {}} changes={3} />));
  expect(el.querySelector("[data-testid=pane-changes]")!.textContent).toBe("changes3");
  expect(el.querySelector("[data-testid=pane-files]")!.textContent).toBe("files");
  await act(async () => root.render(<PaneTabs panes={["changes", "files"]} value="files" onChange={() => {}} changes={0} />));
  expect(el.querySelector("[data-testid=pane-changes]")!.textContent).toBe("changes");
});
