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

const edit = (id: string, file_path: string, old_string: string, new_string: string): Part => ({
  type: "tool_call",
  id,
  toolUseId: id,
  tool: "Edit",
  input: { file_path, old_string, new_string },
  status: "done",
});
const view = (parts: Part[]): SessionView =>
  parts.reduce((s, part, i) => applyEvent(s, { type: "event", sessionId: "s1", seq: i + 1, part }), emptySession());

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(null)));

function fakeClient(files: Record<string, string>) {
  const request = vi.fn(async (m: { type: string; path: string }) => {
    if (m.path in files) return { content: files[m.path], mtime: 1 };
    throw new Error("fs_error: ENOENT");
  });
  return { request } as unknown as ReturnType<typeof connect>;
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

it("re-reads the files when Claude changes one more time (live), and switches unified/split", async () => {
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

  const split = el.querySelector<HTMLButtonElement>("[data-testid=diff-split]")!;
  expect(split.getAttribute("aria-checked")).toBe("false");
  await act(async () => (split.click(), undefined));
  expect(split.getAttribute("aria-checked")).toBe("true");
});

it("shows an empty state without changes", async () => {
  await act(async () => root.render(<ChangesPanel client={fakeClient({})} view={view([])} cwd="/p" onOpen={() => {}} />));
  expect(el.querySelector("[data-testid=changes-empty]")!.textContent).toContain("No changes");
});
