// @vitest-environment jsdom
import type { Part } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PaneTabs } from "./App.tsx";
import { ChangesPanel } from "./changes-panel.tsx";
import type { connect } from "./client.ts";
import { applyEvent, emptySession, type SessionView } from "./store.ts";

// The diff library renders in a worker; the stub keeps the last options so a test can see them and finish the render.
const diff = vi.hoisted(() => ({ options: undefined as undefined | { disableFileHeader?: boolean; onPostRender?: (...a: unknown[]) => void } }));
vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: (p: { options: typeof diff.options }) => ((diff.options = p.options), <div data-testid="pierre-diff" />),
}));

// Counts whole-file diffs, so a test can see that streaming does not re-parse them.
const parsed = vi.hoisted(() => ({ n: 0 }));
vi.mock("./changes.ts", async (orig) => {
  const m = await orig<typeof import("./changes.ts")>();
  return { ...m, fileStats: (...a: Parameters<typeof m.fileStats>) => (parsed.n++, m.fileStats(...a)) };
});

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
    // What the daemon replies for a missing file inside a root (server.test.ts "fs.read of a deleted file…").
    throw Object.assign(new Error(`no such file: ${m.path}`), { code: "not_found" });
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
  expect(rows()).toEqual(["Ma.tssrc+1-1", "Mb.ts+1-1"]);
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
  expect(rows()).toEqual(["Ma.ts+1-1"]);

  disk["/p/a.ts"] = "a = 2\nc\n";
  const next = [...first, edit("e2", "/p/a.ts", "a = 2", "a = 2\nc")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(next)} cwd="/p" onOpen={() => {}} />));
  await flush();
  expect(rows()).toEqual(["Ma.ts+2-1"]);
});

it("re-reads a listed file changed outside the session (fs.changed)", async () => {
  const disk: Record<string, string> = { "/p/a.ts": "a = 2\n" };
  const client = fakeClient(disk);
  await act(async () => root.render(<ChangesPanel client={client} view={view([edit("e1", "/p/a.ts", "a = 1", "a = 2"), original("e1", "a = 1\n")])} cwd="/p" onOpen={() => {}} />));
  await flush();
  disk["/p/a.ts"] = "a = 2\nbash\n";
  client.changed("/p/other.ts");
  await flush();
  expect(rows()).toEqual(["Ma.ts+1-1"]);
  client.changed("/p/a.ts");
  await flush();
  expect(rows()).toEqual(["Ma.ts+2-1"]);
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
  await act(async () => root.render(<PaneTabs panes={["changes", "files"]} value="files" onChange={() => {}} changes={3} />));
  expect(el.querySelector("[data-testid=pane-changes]")!.textContent).toBe("changes3");
  expect(el.querySelector("[data-testid=pane-files]")!.textContent).toBe("files");
  await act(async () => root.render(<PaneTabs panes={["changes", "files"]} value="files" onChange={() => {}} changes={0} />));
  expect(el.querySelector("[data-testid=pane-changes]")!.textContent).toBe("changes");
});

it("each file has one header: path relative to cwd, +N -N, Open in editor; the library's own file header is off", async () => {
  const client = fakeClient({ "/p/src/a.ts": "a = 2\nb\n" });
  await act(async () => root.render(<ChangesPanel client={client} view={view([edit("e1", "/p/src/a.ts", "a = 1", "a = 2"), original("e1", "a = 1\nb\n")])} cwd="/p" onOpen={() => {}} />));
  await flush();
  const header = el.querySelector("[data-testid=file-diff-header]")!;
  expect(header.textContent).toBe("Msrc/a.ts+1-1 Open in editor");
  expect(diff.options!.disableFileHeader).toBe(true);
});

it("a file outside the session cwd has no Open in editor (the files pane shows only tabs inside cwd); the header keeps the absolute path", async () => {
  const client = fakeClient({ "/q/b.ts": "b = 2\n" });
  await act(async () => root.render(<ChangesPanel client={client} view={view([edit("e1", "/q/b.ts", "b = 1", "b = 2"), original("e1", "b = 1\n")])} cwd="/p" onOpen={() => {}} />));
  await flush();
  expect(el.querySelector("[data-testid=open-in-editor]")).toBeNull();
  expect(el.querySelector("[data-testid=file-diff-header]")!.textContent).toBe("M/q/b.ts+1-1");
});

it("shows Loading until the first diff is drawn", async () => {
  const client = fakeClient({ "/p/a.ts": "a = 2\n" });
  await act(async () => root.render(<ChangesPanel client={client} view={view([edit("e1", "/p/a.ts", "a = 1", "a = 2"), original("e1", "a = 1\n")])} cwd="/p" onOpen={() => {}} />));
  expect(el.querySelector("[data-testid=diff-loading]")).not.toBeNull(); // file not read yet
  await flush();
  expect(el.querySelector("[data-testid=diff-loading]")).not.toBeNull(); // read, highlighter still loading
  await act(async () => diff.options!.onPostRender!(document.createElement("div"), {}, "mount"));
  expect(el.querySelector("[data-testid=diff-loading]")).toBeNull();
});

it("badges each file A (created), D (deleted) or M, like OpenCode's file list", async () => {
  const write = (id: string, file_path: string): Part => ({ type: "tool_call", id, toolUseId: id, tool: "Write", input: { file_path, content: "n\n" }, status: "done" });
  const created: Part = { type: "tool_result", id: "w1:result", toolUseId: "w1", output: "ok", isError: false, original: null };
  const client = fakeClient({ "/p/new.ts": "n\n", "/p/a.ts": "a = 2\n" });
  const parts = [write("w1", "/p/new.ts"), created, edit("e1", "/p/a.ts", "a = 1", "a = 2"), edit("e2", "/p/gone.ts", "x", "y"), original("e2", "x\n")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(parts)} cwd="/p" onOpen={() => {}} />));
  await flush();
  expect(rows()).toEqual(["Anew.ts+1-0", "Ma.ts+1-1", "Dgone.ts+0-1"]);
  expect(el.querySelector("[data-testid=change-badge]")!.getAttribute("title")).toBe("Added");
  const badges = [...el.querySelectorAll("[data-testid=change-badge]")];
  // Colors as OpenCode's change badge: added success, deleted danger, modified info.
  expect(badges.map((b) => b.className.match(/text-(success|destructive|info|warning)/)?.[1])).toEqual(["success", "info", "destructive", "success"]);
});

it("without a known before, says so without blaming a restored session (a live rewind lands here too) and shows each edit", async () => {
  const client = fakeClient({ "/p/a.ts": "y y\n" });
  await act(async () => root.render(<ChangesPanel client={client} view={view([edit("e1", "/p/a.ts", "x", "y")])} cwd="/p" onOpen={() => {}} />));
  await flush();
  expect(el.querySelector("[data-testid=file-diff]")!.textContent).toContain("The file before this session is unknown: each edit is shown.");
  expect(diff.options!.disableFileHeader).toBe(true);
});

it("badges an existing empty file M (original \"\"), not A", async () => {
  const client = fakeClient({ "/p/e.ts": "x\n" });
  await act(async () => root.render(<ChangesPanel client={client} view={view([edit("e1", "/p/e.ts", "", "x\n"), original("e1", "")])} cwd="/p" onOpen={() => {}} />));
  await flush();
  expect(rows()).toEqual(["Me.ts+1-0"]);
});

it("says a file with zero net change has no changes instead of an empty diff", async () => {
  const client = fakeClient({ "/p/a.ts": "a\n" });
  const parts = [edit("e1", "/p/a.ts", "a", "b"), original("e1", "a\n"), edit("e2", "/p/a.ts", "b", "a")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(parts)} cwd="/p" onOpen={() => {}} />));
  await flush();
  const body = el.querySelector("[data-testid=file-diff]")!;
  expect(body.textContent).toContain("No changes against the file before this session.");
  expect(body.querySelector("[data-testid=pierre-diff]")).toBeNull();
  expect(body.querySelector("[data-testid=diff-loading]")).toBeNull();
});

it("does not re-parse the diffs while Claude streams text", async () => {
  const client = fakeClient({ "/p/a.ts": "a = 2\n", "/p/b.ts": "b = 2\n" });
  let v = view([edit("e1", "/p/a.ts", "a = 1", "a = 2"), edit("e2", "/p/b.ts", "b = 1", "b = 2")]);
  await act(async () => root.render(<ChangesPanel client={client} view={v} cwd="/p" onOpen={() => {}} />));
  await flush();
  const before = parsed.n;
  for (let i = 1; i <= 5; i++) {
    v = applyEvent(v, { type: "event", sessionId: "s1", seq: 100 + i, part: { type: "assistant_text", id: "t1", text: "x".repeat(i), streaming: true } });
    await act(async () => root.render(<ChangesPanel client={client} view={v} cwd="/p" onOpen={() => {}} />));
  }
  expect(parsed.n).toBe(before);
  expect(rows()).toEqual(["Ma.ts+1-1", "Mb.ts+1-1"]);
});

it("names each row by kind, relative path and stats for screen readers", async () => {
  const client = fakeClient({ "/p/src/a.ts": "a = 2\n" });
  await act(async () => root.render(<ChangesPanel client={client} view={view([edit("e1", "/p/src/a.ts", "a = 1", "a = 2")])} cwd="/p" onOpen={() => {}} />));
  await flush();
  expect(el.querySelector("[data-testid=changed-file]")!.getAttribute("aria-label")).toBe("Modified src/a.ts, +1 -1");
});
