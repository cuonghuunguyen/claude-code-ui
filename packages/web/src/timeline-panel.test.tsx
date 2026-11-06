// @vitest-environment jsdom
import type { GitRepo } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { TimelinePanel } from "./timeline-panel.tsx";

vi.mock("@pierre/diffs/react", () => ({ MultiFileDiff: () => <div data-testid="pierre-diff" /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;

const FILE = "/p/src/a.txt";
const main: GitRepo = { path: "/p", rel: "", kind: "main" };
const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  mounted.splice(0).forEach((m) => act(() => m.unmount()));
  document.body.innerHTML = "";
  localStorage.clear();
});

function setup(over: { dirty?: boolean; open?: boolean } = {}) {
  localStorage.setItem("claude-ui.timeline.open", over.open === false ? "0" : "1");
  const calls: { type: string; [k: string]: unknown }[] = [];
  const request = vi.fn(async (msg: { type: string; [k: string]: unknown }) => {
    calls.push(msg);
    switch (msg.type) {
      case "history.list":
        return { entries: [{ id: "e2", time: Date.now() - 1000, reason: "agent", size: 3 }, { id: "e1", time: Date.now() - 600_000, reason: "save", size: 3 }] };
      case "git.log":
        return { log: { commits: [{ hash: "c".repeat(40), parents: [], author: "a", email: "a@example.com", time: Math.floor(Date.now() / 1000) - 3600, subject: "first commit", refs: [] }], more: false } };
      case "history.read":
        return { content: `entry ${msg.id}` };
      case "fs.read":
        return { content: "now", mtime: 1 };
      default:
        return {};
    }
  });
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  mounted.push(root);
  act(() => root.render(<TimelinePanel client={{ request } as unknown as ReturnType<typeof connect>} cwd="/p" path={FILE} repos={{ list: [main], projectKey: "/p" }} stamp="1" dirty={!!over.dirty} mtime={7} />));
  return { calls, request, q: (s: string) => document.querySelector(s) as HTMLElement, all: (s: string) => [...document.querySelectorAll(s)] as HTMLElement[] };
}
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

it("shows the entries and the commit of the file newest first, git asked with the path relative to the top", async () => {
  const { all, calls } = setup();
  await flush();
  expect(all('[data-testid="timeline-row"]').map((r) => r.dataset.source)).toEqual(["history", "history", "git"]);
  expect(all('[data-testid="timeline-title"]').map((r) => r.textContent)).toEqual(["Agent edit", "File saved", "first commit"]);
  expect(calls.find((c) => c.type === "git.log")).toMatchObject({ cwd: "/p", exact: true, path: "src/a.txt" });
});

it("starts collapsed and asks nothing until opened", async () => {
  const { q, calls } = setup({ open: false });
  await flush();
  expect(calls).toEqual([]);
  expect(q('[data-testid="toggle-timeline"]').getAttribute("aria-expanded")).toBe("false");
});

it("a row click opens the comparison with the current file", async () => {
  const { q, all, calls } = setup();
  await flush();
  await act(async () => all('[data-testid="timeline-row"] button')[0]!.click());
  await flush();
  expect(calls.filter((c) => c.type === "history.read" || c.type === "fs.read")).toMatchObject([{ type: "history.read", id: "e2" }, { type: "fs.read", path: FILE }]);
  expect(q('[data-testid="viewer-dialog"]').dataset.kind).toBe("compare");
});

it("Restore is refused with unsaved edits and sends the tab's mtime otherwise", async () => {
  const dirty = setup({ dirty: true });
  await flush();
  await act(async () => dirty.all('[data-testid="timeline-row-menu"]')[0]!.click());
  await act(async () => dirty.q('[data-testid="timeline-restore"]').click());
  expect(dirty.q('[data-testid="timeline-notice"]').textContent).toMatch(/Save or discard/);
  expect(dirty.calls.some((c) => c.type === "history.restore")).toBe(false);
});

it("Restore sends the history id with the tab mtime", async () => {
  const { all, q, calls } = setup();
  await flush();
  await act(async () => all('[data-testid="timeline-row-menu"]')[1]!.click());
  await act(async () => q('[data-testid="timeline-restore"]').click());
  expect(calls.find((c) => c.type === "history.restore")).toMatchObject({ path: FILE, id: "e1", baseMtime: 7 });
});

it("the filter hides git rows and is kept in the browser", async () => {
  const { all, q } = setup();
  await flush();
  await act(async () => q('[data-testid="timeline-filter"]').click());
  await act(async () => q('[data-testid="timeline-filter-git"]').click());
  expect(all('[data-testid="timeline-row"]').map((r) => r.dataset.source)).toEqual(["history", "history"]);
  expect(JSON.parse(localStorage.getItem("claude-ui.timeline.filter")!)).toEqual({ history: true, git: false });
});
