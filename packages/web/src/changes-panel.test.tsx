// @vitest-environment jsdom
import type { GitDiff, GitStatus, Part } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PaneTabs } from "./App.tsx";
import { ChangesPanel } from "./changes-panel.tsx";
import type { connect } from "./client.ts";
import { saveDiffMode, sessionDiffChoice } from "./diff-mode.ts";
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
  // Live like a real MediaQueryList: the hook keeps one.
  get matches() {
    return narrow && query.includes("48rem");
  },
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
  sessionDiffChoice.clear();
});

/** `git`: git.status (default: not a repository), git.diff (a reply or an error), git.fileAt by "hash:path". */
type FakeGit = { status?: GitStatus | null; diff?: GitDiff | Error; at?: Record<string, string> };
function fakeClient(files: Record<string, string>, git: FakeGit = {}) {
  const request = vi.fn(async (m: { type: string; path: string; hash?: string }) => {
    if (m.type === "git.status") return { status: git.status ?? null };
    if (m.type === "git.log") return { log: { commits: [], more: false, branches: ["refs/heads/main", "refs/heads/dev"] } };
    if (m.type === "git.diff") {
      if (git.diff instanceof Error) throw git.diff;
      return { diff: git.diff ?? null };
    }
    if (m.type === "git.fileAt") {
      const k = `${m.hash}:${m.path}`;
      if (git.at && k in git.at) return { content: git.at[k] };
      throw Object.assign(new Error(`No such file at that commit: ${m.path}`), { code: "not_found" });
    }
    if (m.path in files) return { content: files[m.path], mtime: 1 };
    // What the daemon replies for a missing file inside a root (server.test.ts "fs.read of a deleted file…").
    throw Object.assign(new Error(`no such file: ${m.path}`), { code: "not_found" });
  });
  const listeners = new Set<(m: { path: string }) => void>();
  const onFsChanged = (l: (m: { path: string }) => void) => (listeners.add(l), () => void listeners.delete(l));
  const changed = (path: string) => listeners.forEach((l) => l({ path }));
  return Object.assign({ request, onFsChanged } as unknown as ReturnType<typeof connect>, { changed, calls: request });
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
// Each row by its accessible name: kind, path relative to cwd, stats.
const rows = () => [...el.querySelectorAll("[data-testid=changed-file]")].map((b) => b.getAttribute("aria-label"));

it("lists changed files with whole-file +N -N and opens the selected one in the editor", async () => {
  const disk = { "/p/src/a.ts": "a = 2\nb\n", "/p/b.ts": "x = 9\n" };
  const client = fakeClient(disk);
  const onOpen = vi.fn();
  const parts = [edit("e1", "/p/src/a.ts", "a = 1", "a = 2"), edit("e2", "/p/b.ts", "x = 1", "x = 9")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(parts)} cwd="/p" onOpen={onOpen} />));
  await flush();
  expect(el.textContent).toContain("2 Changed files");
  expect(rows()).toEqual(["Modified src/a.ts, +1 -1", "Modified b.ts, +1 -1"]);
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
  expect(rows()).toEqual(["Modified a.ts, +1 -1"]);

  disk["/p/a.ts"] = "a = 2\nc\n";
  const next = [...first, edit("e2", "/p/a.ts", "a = 2", "a = 2\nc")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(next)} cwd="/p" onOpen={() => {}} />));
  await flush();
  expect(rows()).toEqual(["Modified a.ts, +2 -1"]);
});

it("re-reads a listed file changed outside the session (fs.changed)", async () => {
  const disk: Record<string, string> = { "/p/a.ts": "a = 2\n" };
  const client = fakeClient(disk);
  await act(async () => root.render(<ChangesPanel client={client} view={view([edit("e1", "/p/a.ts", "a = 1", "a = 2"), original("e1", "a = 1\n")])} cwd="/p" onOpen={() => {}} />));
  await flush();
  disk["/p/a.ts"] = "a = 2\nbash\n";
  client.changed("/p/other.ts");
  await flush();
  expect(rows()).toEqual(["Modified a.ts, +1 -1"]);
  client.changed("/p/a.ts");
  await flush();
  expect(rows()).toEqual(["Modified a.ts, +2 -1"]);
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

it("below md: an accordion of the files (icon, folder/name, kind, stats), each diff unified under its row; Expand all / Collapse all; no filter, no ←/→", async () => {
  narrow = true;
  localStorage.setItem("claude-ui.diffStyle", "split");
  const write = (id: string, file_path: string): Part => ({ type: "tool_call", id, toolUseId: id, tool: "Write", input: { file_path, content: "n\n" }, status: "done" });
  const created: Part = { type: "tool_result", id: "w1:result", toolUseId: "w1", output: "ok", isError: false, original: null };
  const client = fakeClient({ "/p/src/u.js": "n\n", "/p/README.md": "a = 2\n" });
  const parts = [write("w1", "/p/src/u.js"), created, edit("e1", "/p/README.md", "a = 1", "a = 2")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(parts)} cwd="/p" onOpen={() => {}} />));
  await flush();
  const buttons = () => [...el.querySelectorAll<HTMLButtonElement>("[data-testid=changed-file]")];
  expect(buttons().map((b) => b.textContent)).toEqual(["README.md+1-1", "src/u.jsAdded+1-0"]);
  expect(buttons().map((b) => b.querySelector("svg[data-icon]")?.getAttribute("data-icon"))).toEqual(["Readme", "Javascript"]);
  expect(el.querySelector("[data-testid=file-diff]")).toBeNull();
  expect(el.querySelector("[data-testid=changes-filter]")).toBeNull();
  expect(el.querySelector("button[aria-label='Next file']")).toBeNull();
  expect(el.querySelector("[data-testid=diff-split]")).toBeNull();
  const key = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  await act(async () => void document.body.dispatchEvent(key));
  expect(key.defaultPrevented).toBe(false);

  await act(async () => buttons()[1]!.click());
  expect(buttons().map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
  expect(el.querySelectorAll("[data-testid=file-diff]")).toHaveLength(1);
  expect(el.querySelector("[data-testid=file-diff]")!.getAttribute("data-diff-style")).toBe("unified");
  const all = () => el.querySelector<HTMLButtonElement>("[data-testid=expand-all]")!;
  expect(all().textContent!.trim()).toBe("Expand all");
  await act(async () => all().click());
  expect(el.querySelectorAll("[data-testid=file-diff]")).toHaveLength(2);
  expect(all().textContent!.trim()).toBe("Collapse all");
  await act(async () => all().click());
  expect(el.querySelectorAll("[data-testid=file-diff]")).toHaveLength(0);
  expect(el.querySelector("[data-testid=changes-actions]")!.className).toContain("max-md:gap-2");
});

it("wide: a folder tree like OpenCode's review sidebar (folders first, file-type icons; A/D, M only in the diff header); a folder collapses", async () => {
  const client = fakeClient({ "/p/src/a.ts": "a = 2\n", "/p/src/lib/b.ts": "b = 2\n", "/p/README.md": "r = 2\n" });
  const parts = [edit("e1", "/p/README.md", "r = 1", "r = 2"), edit("e2", "/p/src/lib/b.ts", "b = 1", "b = 2"), edit("e3", "/p/src/a.ts", "a = 1", "a = 2")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(parts)} cwd="/p" onOpen={() => {}} />));
  await flush();
  const tree = () => [...el.querySelectorAll("ul[aria-label='Changed files'] button")].map((b) => `${b.getAttribute("style")}|${b.textContent}`);
  expect(tree()).toEqual(["padding-left: 8px;|src", "padding-left: 24px;|lib", "padding-left: 40px;|b.ts", "padding-left: 24px;|a.ts", "padding-left: 8px;|README.md"]);
  expect([...el.querySelectorAll("[data-testid=changed-file] svg[data-icon]")].map((i) => i.getAttribute("data-icon"))).toEqual(["Typescript", "Typescript", "Readme"]);
  // The first file in the tree is selected; ← / → follow the tree order.
  expect(el.querySelector("[data-testid=file-diff-header]")!.textContent).toContain("src/lib/b.ts");
  await act(async () => el.querySelector<HTMLButtonElement>("[data-testid=changed-folder]")!.click());
  expect(tree()).toEqual(["padding-left: 8px;|src", "padding-left: 8px;|README.md"]);
  expect(el.querySelector("[data-testid=changed-folder]")!.getAttribute("aria-expanded")).toBe("false");
});

it("leaves ← / → alone while the file list is not on screen (side panel closed, new-session tab: display none)", async () => {
  const client = fakeClient({ "/p/a.ts": "a = 2\n", "/p/b.ts": "b = 2\n" });
  const parts = [edit("e1", "/p/a.ts", "a = 1", "a = 2"), edit("e2", "/p/b.ts", "b = 1", "b = 2")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(parts)} cwd="/p" onOpen={() => {}} />));
  await flush();
  // jsdom has no layout: stub what a browser answers for an element under display: none.
  const visible = vi.fn(() => false);
  Object.defineProperty(HTMLElement.prototype, "checkVisibility", { value: visible, configurable: true });
  const key = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  await act(async () => void document.body.dispatchEvent(key));
  expect(key.defaultPrevented).toBe(false);
  expect(el.querySelector("[data-testid=file-diff-header]")!.textContent).toContain("a.ts");
  visible.mockReturnValue(true);
  await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
  expect(el.querySelector("[data-testid=file-diff-header]")!.textContent).toContain("b.ts");
  delete (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility;
});

it("the header total is left out when no file has stats (one deleted file with an unknown before)", async () => {
  await act(async () => root.render(<ChangesPanel client={fakeClient({})} view={view([edit("e1", "/p/gone.ts", "x", "y")])} cwd="/p" onOpen={() => {}} />));
  await flush();
  expect(el.querySelector("[data-testid=changes-panel] > div")!.textContent).toMatch(/1 Changed file1\/1/);
  expect(el.querySelectorAll("[data-testid=change-stats]")).toHaveLength(0);
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
  expect(rows()).toEqual(["Modified a.ts, +1 -1", "Deleted gone.ts, +0 -1", "Added new.ts, +1 -0"]);
  // The tree marks A and D; the M of the selected file is in its diff header.
  expect([...el.querySelectorAll("[data-testid=changed-file] [data-testid=change-badge]")].map((b) => b.getAttribute("title"))).toEqual(["Deleted", "Added"]);
  const badges = [...el.querySelectorAll("[data-testid=change-badge]")];
  // Colors as OpenCode's change badge: added success, deleted danger, modified info.
  expect(badges.map((b) => b.className.match(/text-(success|destructive|info|warning)/)?.[1])).toEqual(["destructive", "success", "info"]);
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
  expect(rows()).toEqual(["Modified e.ts, +1 -0"]);
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

it("parses each file's diff once while the file reads come back one by one (a tab switch remounts the panel)", async () => {
  const n = 12;
  const files = Object.fromEntries(Array.from({ length: n }, (_, i) => [`/p/f${i}.ts`, `v = ${i}\n`]));
  const client = fakeClient(files);
  // Each reply in its own task, like separate WebSocket messages.
  const read = client.request as unknown as ReturnType<typeof vi.fn>;
  const reply = read.getMockImplementation() as (m: never) => unknown;
  let i = 0;
  read.mockImplementation((m: never) => new Promise((r) => setTimeout(() => r(reply(m)), 10 * ++i)));
  const v = view(Array.from({ length: n }, (_, i) => edit(`e${i}`, `/p/f${i}.ts`, "v = x", `v = ${i}`)));
  const before = parsed.n;
  await act(async () => root.render(<ChangesPanel client={client} view={v} cwd="/p" onOpen={() => {}} hidden />));
  const wait = async () => {
    for (let t = 0; t <= n; t++) await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
  };
  await wait();
  expect(parsed.n - before).toBe(n);
  // Shown again after another session's panel: nothing changed, nothing parsed.
  act(() => root.render(null));
  i = 0;
  await act(async () => root.render(<ChangesPanel client={client} view={v} cwd="/p" onOpen={() => {}} hidden />));
  await wait();
  expect(parsed.n - before).toBe(n);
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
  expect(rows()).toEqual(["Modified a.ts, +1 -1", "Modified b.ts, +1 -1"]);
});

it("names each row by kind, relative path and stats for screen readers", async () => {
  const client = fakeClient({ "/p/src/a.ts": "a = 2\n" });
  await act(async () => root.render(<ChangesPanel client={client} view={view([edit("e1", "/p/src/a.ts", "a = 1", "a = 2")])} cwd="/p" onOpen={() => {}} />));
  await flush();
  expect(el.querySelector("[data-testid=changed-file]")!.getAttribute("aria-label")).toBe("Modified src/a.ts, +1 -1");
});

const write = (id: string, file_path: string): Part => ({ type: "tool_call", id, toolUseId: id, tool: "Write", input: { file_path, content: "n\n" }, status: "done" });
const writeResult = (id: string, extra: object): Part => ({ type: "tool_result", id: `${id}:result`, toolUseId: id, output: "File created successfully at: x", isError: false, ...extra });

it("hides a file the session created and deleted again (live original null, or a restored created Write)", async () => {
  const client = fakeClient({ "/p/a.ts": "a = 2\n" });
  const parts = [write("w1", "/p/tmp1.ts"), writeResult("w1", { original: null }), write("w2", "/p/tmp2.ts"), writeResult("w2", {}), edit("e1", "/p/a.ts", "a = 1", "a = 2")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(parts)} cwd="/p" onOpen={() => {}} />));
  await flush();
  expect(rows()).toEqual(["Modified a.ts, +1 -1"]);
  expect(el.textContent).toContain("1 Changed file");
});

it("a deleted file without a known before (restored transcript) shows the D badge without per-call stats", async () => {
  const client = fakeClient({});
  await act(async () => root.render(<ChangesPanel client={client} view={view([edit("e1", "/p/gone.ts", "x", "y")])} cwd="/p" onOpen={() => {}} />));
  await flush();
  expect(rows()).toEqual(["Deleted gone.ts"]);
  expect(el.querySelector("[data-testid=changed-file]")!.getAttribute("aria-label")).toBe("Deleted gone.ts");
  expect(el.querySelector("[data-testid=file-diff]")!.textContent).toContain("each edit is shown");
});

it("filters the file list by path, like OpenCode's Filter files", async () => {
  const client = fakeClient({ "/p/src/a.ts": "a = 2\n", "/p/b.ts": "x = 9\n" });
  const parts = [edit("e1", "/p/src/a.ts", "a = 1", "a = 2"), edit("e2", "/p/b.ts", "x = 1", "x = 9")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(parts)} cwd="/p" onOpen={() => {}} />));
  await flush();
  const input = el.querySelector<HTMLInputElement>("input[aria-label='Filter files']")!;
  const type = (v: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await type("SRC");
  expect(rows()).toEqual(["Modified src/a.ts, +1 -1"]);
  await type("zzz");
  expect(rows()).toEqual([]);
  expect(el.textContent).toContain("No files match");
});

it("previous/next buttons and the arrow keys cycle the selected file, not while typing", async () => {
  const client = fakeClient({ "/p/a.ts": "a = 2\n", "/p/b.ts": "x = 9\n", "/p/c.ts": "c = 9\n" });
  const parts = [edit("e1", "/p/a.ts", "a = 1", "a = 2"), edit("e2", "/p/b.ts", "x = 1", "x = 9"), edit("e3", "/p/c.ts", "c = 1", "c = 9")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(parts)} cwd="/p" onOpen={() => {}} />));
  await flush();
  const current = () => el.querySelector("[data-testid=file-diff-header]")!.textContent;
  const click = (label: string) => act(async () => el.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`)!.click());
  expect(current()).toContain("a.ts");
  await click("Next file");
  expect(current()).toContain("b.ts");
  await click("Previous file");
  await click("Previous file");
  expect(current()).toContain("c.ts");
  expect(el.textContent).toContain("3/3");
  await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(current()).toContain("a.ts");
  const input = el.querySelector<HTMLInputElement>("input[aria-label='Filter files']")!;
  await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(current()).toContain("a.ts");
});

it("once shown, hiding keeps the list mounted (display: none), so showing it again renders nothing new; arrow keys stay alone while hidden", async () => {
  const client = fakeClient({ "/p/a.ts": "a = 2\n" });
  const v = view([edit("e1", "/p/a.ts", "a = 1", "a = 2")]);
  const show = (hidden: boolean) => act(async () => root.render(<ChangesPanel client={client} view={v} cwd="/p" onOpen={() => {}} hidden={hidden} />));
  await show(false);
  await flush();
  const panel = el.querySelector("[data-testid=changes-panel]")!;
  await show(true);
  expect(el.querySelector("[data-testid=changes-panel]")).toBe(panel);
  expect(panel.hasAttribute("hidden")).toBe(true);
  const key = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  await act(async () => void document.body.dispatchEvent(key));
  expect(key.defaultPrevented).toBe(false);
  await show(false);
  expect(el.querySelector("[data-testid=changes-panel]")).toBe(panel);
  expect(panel.hasAttribute("hidden")).toBe(false);
});

it("reports the listed file count to the pane tab (a created and deleted file is not counted); hidden it renders nothing and leaves the arrow keys alone", async () => {
  const client = fakeClient({ "/p/a.ts": "a = 2\n", "/p/b.ts": "b = 2\n" });
  const onCount = vi.fn();
  const parts = [write("w1", "/p/tmp.ts"), writeResult("w1", { original: null }), edit("e1", "/p/a.ts", "a = 1", "a = 2"), edit("e2", "/p/b.ts", "b = 1", "b = 2")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(parts)} cwd="/p" onOpen={() => {}} hidden onCount={onCount} />));
  await flush();
  expect(onCount).toHaveBeenLastCalledWith(2);
  expect(el.querySelector("[data-testid=changes-panel]")).toBeNull();
  const key = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  await act(async () => void document.body.dispatchEvent(key));
  expect(key.defaultPrevented).toBe(false);
});

it("a changed file that is binary, too large or not UTF-8 shows its state, not a raw error", async () => {
  const states: Record<string, [string, number]> = { "/p/a.png": ["binary", 2048], "/p/big.log": ["too_large", 5 * 1024 ** 2], "/p/u16.txt": ["not_utf8", 10] };
  const client = fakeClient({});
  (client.request as unknown as ReturnType<typeof vi.fn>).mockImplementation((async (m: { path: string }) => {
    const [code, size] = states[m.path]!;
    throw Object.assign(new Error(`${code} file: ${m.path}`), { code, size });
  }) as never);
  const parts = Object.keys(states).map((p, i) => edit(`e${i}`, p, "a", "b"));
  await act(async () => root.render(<ChangesPanel client={client} view={view(parts)} cwd="/p" onOpen={() => {}} />));
  await flush();
  for (const [path, text] of [["/p/a.png", "Binary file, not shown (2 KB)"], ["/p/big.log", "File too large to show (5 MB)"], ["/p/u16.txt", "File is not UTF-8 text, not shown (10 B)"]]) {
    await act(async () => (el.querySelector<HTMLButtonElement>(`[data-testid=changed-file][aria-label*="${path.slice(3)}"]`)!.click(), undefined));
    expect(el.querySelector("[data-testid=file-diff]")!.textContent).toContain(text);
  }
  expect(el.textContent).not.toMatch(/too_large|not_utf8|binary file:/);
});

it("a file that was binary, too large or not UTF-8 before the session shows its state on the before side, not garbled text", async () => {
  const garbled = "PK\u0003\u0004\0\0��\u0014\0";
  const files: Record<string, string> = { "/p/a.zip": "now text\n", "/p/photo.jpg": "now text\n", "/p/u16.txt": "now text\n", "/p/big.log": "now text\n" };
  const before: Record<string, string> = { "/p/a.zip": garbled, "/p/photo.jpg": "����\0\u0010JFIF\0", "/p/u16.txt": "��a\0b\0", "/p/big.log": "x".repeat(2 * 1024 ** 2 + 1) };
  const parts = Object.keys(files).flatMap((p, i) => [edit(`e${i}`, p, "a", "b"), original(`e${i}`, before[p]!)]);
  await act(async () => root.render(<ChangesPanel client={fakeClient(files)} view={view(parts)} cwd="/p" onOpen={() => {}} />));
  await flush();
  for (const [path, text] of [["/p/a.zip", "Binary file, not shown"], ["/p/photo.jpg", "Binary file, not shown"], ["/p/u16.txt", "File is not UTF-8 text, not shown"], ["/p/big.log", "File too large to show"]]) {
    await act(async () => (el.querySelector<HTMLButtonElement>(`[data-testid=changed-file][aria-label*="${path.slice(3)}"]`)!.click(), undefined));
    expect(el.querySelector("[data-testid=file-diff]")!.textContent).toContain(text);
    expect(el.querySelector("[data-testid=pierre-diff]")).toBeNull();
  }
});

it("a deleted file whose before side failed (binary) shows kind D, not M", async () => {
  const client = fakeClient({});
  // File was binary before, now deleted (read throws not_found)
  const parts = [edit("e1", "/p/binary.bin", "a", "b"), original("e1", "\0\u0001\u0002")];
  await act(async () => root.render(<ChangesPanel client={client} view={view(parts)} cwd="/p" onOpen={() => {}} />));
  await flush();
  expect(rows()).toEqual(["Deleted binary.bin"]);
});

it("no line stats on a row whose before or after side failed", async () => {
  const garbled = "PK\u0003\u0004\0\0";
  const files: Record<string, string> = { "/p/old.zip": "now text\n", "/p/new.bin": "text\n" };
  const before: Record<string, string> = { "/p/old.zip": garbled };
  const parts = [
    edit("e1", "/p/old.zip", "a", "b"), original("e1", before["/p/old.zip"]!),
    edit("e2", "/p/new.bin", "a", "b"), original("e2", "text\n"),
  ];
  const client = fakeClient(files);
  (client.request as unknown as ReturnType<typeof vi.fn>).mockImplementation((async (m: { path: string }) => {
    if (m.path === "/p/new.bin") throw Object.assign(new Error("binary file"), { code: "binary" });
    return { content: files[m.path], mtime: 1 };
  }) as never);
  await act(async () => root.render(<ChangesPanel client={client} view={view(parts)} cwd="/p" onOpen={() => {}} />));
  await flush();
  // old.zip: before failed (binary), no stats
  // new.bin: after failed (binary), no stats
  const labels = rows();
  expect(labels).toContain("Modified old.zip");
  expect(labels).toContain("Modified new.bin");
  expect(labels.every((l) => !l!.includes("+") && !l!.includes("-"))).toBe(true);
  expect(el.querySelectorAll("[data-testid=change-stats]")).toHaveLength(0);
});

it("no line stats when both before and after sides failed", async () => {
  const garbled = "PK\u0003\u0004\0\0";
  // File was binary before, and the current disk version is also binary
  const client = fakeClient({});
  (client.request as unknown as ReturnType<typeof vi.fn>).mockImplementation((async (m: { path: string }) => {
    if (m.path === "/p/binary.exe") throw Object.assign(new Error("binary file"), { code: "binary" });
    throw Object.assign(new Error(`no such file: ${m.path}`), { code: "not_found" });
  }) as never);
  const parts = [edit("e1", "/p/binary.exe", "a", "b"), original("e1", garbled)];
  await act(async () => root.render(<ChangesPanel client={client} view={view(parts)} cwd="/p" onOpen={() => {}} />));
  await flush();
  const labels = rows();
  expect(labels).toContain("Modified binary.exe");
  expect(labels.every((l) => !l!.includes("+") && !l!.includes("-"))).toBe(true);
  expect(el.querySelectorAll("[data-testid=change-stats]")).toHaveLength(0);
});

// ---- Diff modes (GH-148) ----
const BASE = "b".repeat(40);
const D = (files: GitDiff["files"], extra: Partial<GitDiff> = {}): GitDiff => ({ prefix: "", base: BASE, files, ...extra });
const REPO: GitStatus = { branch: "main", added: 0, removed: 0 };
const gitCalls = (c: { calls: ReturnType<typeof vi.fn> }, type: string) => c.calls.mock.calls.map((a) => a[0] as Record<string, unknown>).filter((m) => m.type === type);
const mode = () => el.querySelector("[data-testid=diff-mode]")!;
const openSelect = async (id: string) => act(async () => (el.querySelector<HTMLElement>(`[data-testid=${id}]`)!.click(), undefined));
const optionById = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const panel = (client: ReturnType<typeof fakeClient>, p: Partial<React.ComponentProps<typeof ChangesPanel>> = {}) => <ChangesPanel client={client} view={view([])} cwd="/p" onOpen={() => {}} {...p} />;

it("defaults to Session changes; the mode select lists Uncommitted and Against branch", async () => {
  await act(async () => root.render(panel(fakeClient({}, { status: REPO }))));
  await flush();
  expect(mode().textContent).toContain("Session changes");
  await openSelect("diff-mode");
  expect([...document.querySelectorAll("[role=option]")].map((o) => o.textContent)).toEqual(["Session changes", "Uncommitted", "Against branch"]);
  expect(optionById("diff-mode-uncommitted").hasAttribute("data-disabled")).toBe(false);
});

it("outside a git repository the git modes are disabled with the reason", async () => {
  await act(async () => root.render(panel(fakeClient({}))));
  await flush();
  await openSelect("diff-mode");
  for (const m of ["uncommitted", "branch"]) {
    expect(optionById(`diff-mode-${m}`).hasAttribute("data-disabled")).toBe(true);
    expect(optionById(`diff-mode-${m}`).textContent).toContain("Needs a git repository");
  }
  expect(optionById("diff-mode-session").textContent).toBe("Session changes");
});

it("a git default in a non-git cwd shows session changes and says why", async () => {
  saveDiffMode("uncommitted");
  const client = fakeClient({ "/p/a.ts": "a = 2\n" });
  await act(async () => root.render(panel(client, { view: view([edit("e1", "/p/a.ts", "a = 1", "a = 2")]) })));
  await flush();
  expect(el.querySelector("[data-testid=changes-not-git]")!.textContent).toBe("Not a git repository: showing session changes.");
  expect(rows()).toEqual(["Modified a.ts, +1 -1"]);
});

it("Uncommitted lists git.diff files with kinds and +N -N; the diff is HEAD (git.fileAt) against the disk (fs.read)", async () => {
  saveDiffMode("uncommitted");
  const git = { status: REPO, diff: D([{ status: "M", path: "src/a.ts", added: 1, removed: 1 }, { status: "A", path: "new.ts", added: 2, removed: 0 }, { status: "D", path: "old.ts", added: 0, removed: 3 }]), at: { [`${BASE}:src/a.ts`]: "a = 1\n", [`${BASE}:old.ts`]: "o\n" } };
  const client = fakeClient({ "/p/src/a.ts": "a = 2\n", "/p/new.ts": "x\ny\n" }, git);
  await act(async () => root.render(panel(client)));
  await flush();
  expect(mode().textContent).toContain("Uncommitted");
  expect(rows()).toEqual(["Modified src/a.ts, +1 -1", "Added new.ts, +2 -0", "Deleted old.ts, +0 -3"]);
  expect(gitCalls(client, "git.diff")).toEqual([{ type: "git.diff", cwd: "/p", base: "head" }]);
  expect(gitCalls(client, "git.fileAt")).toEqual([{ type: "git.fileAt", cwd: "/p", hash: BASE, path: "src/a.ts" }]);
  expect(client.calls.mock.calls.map((a) => (a[0] as { path?: string }).path)).toContain("/p/src/a.ts");
  expect(diff.options).toBeDefined();
  expect(el.querySelector("[data-testid=pierre-diff]")).not.toBeNull();
});

it("an added file reads no before side, a deleted one no after side, a rename reads the old path and shows old to new", async () => {
  saveDiffMode("uncommitted");
  const git = { status: REPO, diff: D([{ status: "A", path: "a.ts" }, { status: "D", path: "b.ts" }, { status: "R", path: "n.ts", oldPath: "o.ts", added: 0, removed: 0 }]), at: { [`${BASE}:b.ts`]: "b\n", [`${BASE}:o.ts`]: "same\n" } };
  const client = fakeClient({ "/p/a.ts": "a\n", "/p/n.ts": "same\n" }, git);
  await act(async () => root.render(panel(client)));
  await flush();
  const click = async (i: number) => act(async () => (el.querySelectorAll<HTMLButtonElement>("[data-testid=changed-file]")[i]!.click(), undefined));
  await click(1);
  await flush();
  await click(2);
  await flush();
  const at = gitCalls(client, "git.fileAt").map((m) => m.path);
  expect(at).toEqual(["b.ts", "o.ts"]);
  const reads = client.calls.mock.calls.map((a) => a[0] as { type: string; path?: string }).filter((m) => m.type === "fs.read").map((m) => m.path);
  expect(reads).not.toContain("/p/b.ts");
  expect(reads).toContain("/p/a.ts");
  expect(el.querySelector("[data-testid=file-diff-header]")!.textContent).toContain("o.ts → n.ts");
  expect(el.textContent).toContain("Renamed without changes");
});

it("Against branch asks git.diff with base branch, shows the ref, and a picked branch re-requests with it", async () => {
  saveDiffMode("branch");
  const git = { status: REPO, diff: D([{ status: "M", path: "a.ts", added: 1, removed: 0 }], { ref: "refs/heads/main", branches: ["refs/heads/main", "refs/heads/dev", "refs/remotes/origin/main"] }), at: { [`${BASE}:a.ts`]: "a\n" } };
  const client = fakeClient({ "/p/a.ts": "a\nb\n" }, git);
  await act(async () => root.render(panel(client)));
  await flush();
  expect(gitCalls(client, "git.diff")[0]).toEqual({ type: "git.diff", cwd: "/p", base: "branch" });
  expect(el.querySelector("[data-testid=diff-branch]")!.textContent).toContain("main");
  await openSelect("diff-branch");
  expect([...document.querySelectorAll("[role=option]")].map((o) => o.textContent)).toEqual(["main", "dev", "origin/main"]);
  await act(async () => (optionById("diff-branch-refs/heads/dev").click(), undefined));
  await flush();
  expect(gitCalls(client, "git.diff").at(-1)).toEqual({ type: "git.diff", cwd: "/p", base: "branch", ref: "refs/heads/dev" });
});

it("a git.diff error is shown (role=alert) with the header kept, and Reload retries", async () => {
  saveDiffMode("uncommitted");
  const client = fakeClient({}, { status: REPO, diff: Object.assign(new Error("fatal: bad object"), { code: "git_failed" }) });
  await act(async () => root.render(panel(client)));
  await flush();
  expect(el.querySelector("[role=alert]")!.textContent).toBe("fatal: bad object");
  expect(mode()).not.toBeNull();
  await act(async () => (el.querySelector<HTMLButtonElement>("button[aria-label='Reload from disk']")!.click(), undefined));
  await flush();
  expect(gitCalls(client, "git.diff")).toHaveLength(2);
});

it("git empty states keep the header", async () => {
  saveDiffMode("uncommitted");
  await act(async () => root.render(panel(fakeClient({}, { status: REPO, diff: D([]) }))));
  await flush();
  expect(el.querySelector("[data-testid=changes-empty]")!.textContent).toBe("No uncommitted changes.");
  expect(mode().textContent).toContain("Uncommitted");
  await act(async () => root.render(null));
  saveDiffMode("branch");
  await act(async () => root.render(panel(fakeClient({}, { status: REPO, diff: D([], { ref: "refs/heads/main", branches: ["refs/heads/main"] }) }))));
  await flush();
  expect(el.querySelector("[data-testid=changes-empty]")!.textContent).toBe("No changes against main.");
});

it("the per-session choice survives a remount for the same session only, and the Settings default moves the others live", async () => {
  const client = fakeClient({}, { status: REPO, diff: D([]) });
  const p = (id: string) => <ChangesPanel key={id} client={client} view={view([])} cwd="/p" onOpen={() => {}} sessionId={id} />;
  await act(async () => root.render(p("s1")));
  await flush();
  await openSelect("diff-mode");
  await act(async () => (optionById("diff-mode-uncommitted").click(), undefined));
  await flush();
  expect(mode().textContent).toContain("Uncommitted");
  await act(async () => root.render(null));
  await act(async () => root.render(p("s1")));
  await flush();
  expect(mode().textContent).toContain("Uncommitted");
  await act(async () => root.render(p("s2")));
  await flush();
  expect(mode().textContent).toContain("Session changes");
  await act(async () => saveDiffMode("branch"));
  await flush();
  expect(mode().textContent).toContain("Against branch");
  await act(async () => root.render(p("s1")));
  await flush();
  expect(mode().textContent).toContain("Uncommitted");
});

it("session scope: Project hides files outside cwd, All shows them; the choice is kept per browser", async () => {
  const client = fakeClient({ "/p/a.ts": "a = 2\n", "/elsewhere/b.ts": "b = 2\n" });
  const v = view([edit("e1", "/p/a.ts", "a = 1", "a = 2"), edit("e2", "/elsewhere/b.ts", "b = 1", "b = 2")]);
  await act(async () => root.render(panel(client, { view: v })));
  await flush();
  expect(rows()).toHaveLength(2);
  await act(async () => (el.querySelector<HTMLButtonElement>("[data-testid=diff-scope-project]")!.click(), undefined));
  expect(rows()).toEqual(["Modified a.ts, +1 -1"]);
  expect(el.querySelector("[data-testid=scope-hidden]")!.textContent).toBe("1 outside the project hidden");
  await act(async () => root.render(null));
  await act(async () => root.render(panel(client, { view: v })));
  await flush();
  expect(el.querySelector("[data-testid=diff-scope-project]")!.getAttribute("aria-pressed")).toBe("true");
  await act(async () => (el.querySelector<HTMLButtonElement>("[data-testid=diff-scope-all]")!.click(), undefined));
  expect(rows()).toHaveLength(2);
});

it("re-requests git.diff when the session state changes and on fs.changed of a loaded file; reports the count", async () => {
  saveDiffMode("uncommitted");
  const client = fakeClient({ "/p/a.ts": "a\n" }, { status: REPO, diff: D([{ status: "M", path: "a.ts", added: 1, removed: 0 }]), at: { [`${BASE}:a.ts`]: "" } });
  const onCount = vi.fn();
  await act(async () => root.render(panel(client, { onCount })));
  await flush();
  expect(gitCalls(client, "git.diff")).toHaveLength(1);
  expect(onCount).toHaveBeenLastCalledWith(1);
  await act(async () => root.render(panel(client, { onCount, view: { ...view([]), state: "running" } })));
  await flush();
  expect(gitCalls(client, "git.diff")).toHaveLength(2);
  client.changed("/p/other.ts");
  await flush();
  expect(gitCalls(client, "git.diff")).toHaveLength(2);
  client.changed("/p/a.ts");
  await flush();
  expect(gitCalls(client, "git.diff")).toHaveLength(3);
});

it("below md: the mode select and Reload share the first 44px row, the count and scope sit in a second row", async () => {
  narrow = true;
  const client = fakeClient({ "/p/a.ts": "a = 2\n" });
  await act(async () => root.render(panel(client, { view: view([edit("e1", "/p/a.ts", "a = 1", "a = 2")]) })));
  await flush();
  expect(mode().className).toContain("h-11");
  const first = mode().parentElement!;
  expect(first.querySelector("button[aria-label='Reload from disk']")!.className).toContain("size-11");
  expect(first.textContent).not.toContain("Changed file");
  expect(el.querySelector("[data-testid=diff-scope-project]")!.className).toContain("max-md:h-11");
  expect(el.textContent).toContain("1 Changed file");
});
