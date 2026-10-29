// @vitest-environment jsdom
import type { SessionListItem, Worktree, WorktreeStatusResult } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CleanupDialog } from "./cleanup-dialog.tsx";
import type { CleanupScope } from "./cleanup.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

const NOW = Date.now();
const item = (id: string, cwd: string, o: Partial<SessionListItem> = {}): SessionListItem => ({ id, cwd, title: id, lastActivity: NOW, archived: false, transcript: true, state: "idle", ...o }) as SessionListItem;
const st = (o: Partial<WorktreeStatusResult> = {}): WorktreeStatusResult => ({ checkedAt: 0, uncommitted: 0, untracked: 0, commits: 0, ahead: 0, ignored: 0, branch: "b", branchMerged: false, running: 0, safety: "safe", ...o });
const M = "/r";
const P = (n: string) => `/r/.claude/worktrees/${n}`;
const worktrees: Record<string, Worktree[]> = {
  [M]: [
    { path: M, branch: "main", main: true },
    { path: P("safe"), branch: "worktree-safe", main: false },
    { path: P("work"), branch: "worktree-work", main: false },
    { path: P("busy"), branch: "worktree-busy", main: false },
    { path: "/x/ext", branch: "feat", main: false },
  ],
};
const STATUS: Record<string, WorktreeStatusResult> = {
  [P("safe")]: st(),
  [P("work")]: st({ safety: "has_work", uncommitted: 2, ahead: 1 }),
  [P("busy")]: st({ safety: "blocked", blocked: "sessions_running", running: 1 }),
  "/x/ext": st({ branchMerged: true, ignored: 3 }),
};
const list = [
  item("co", M, { coordinator: true }),
  item("w-closed", M, { coordinatorId: "co", workerName: "closed-one", state: "closed", live: false }),
  item("w-idle", M, { coordinatorId: "co", workerName: "idle-one", state: "idle" }),
  item("w-wt", P("safe"), { coordinatorId: "co", workerName: "in-wt", state: "closed", live: false }),
];

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

// GH-494: the daemon keeps a cancelled scan id aborted. A new `request` function per render re-runs the scan effect: each run needs its own scan id.
it("a re-render of App while Clean up is open keeps the rows resolvable (scan id not dead)", async () => {
  const cancelled = new Set<string>();
  const sent: Record<string, unknown>[] = [];
  // Emulates server.ts after d9fe0d6: cancel marks the id aborted forever; a status with that id answers `cancelled`.
  const daemon = async (m: Record<string, unknown>) => {
    sent.push(m);
    if (m.type === "worktree.cancel") return void cancelled.add(m.scan as string), {};
    if (m.type === "worktree.cached") return { statuses: {} };
    if (m.type === "worktree.status") {
      if (cancelled.has(m.scan as string)) throw new Error("cancelled");
      return STATUS[m.path as string]!;
    }
    return {};
  };
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const render = () => root!.render(<CleanupDialog scope={{ kind: "all" }} list={list} worktrees={worktrees} state={(s) => s.state} request={((m: never) => daemon(m)) as never} onClose={() => {}} onDone={() => {}} onRemoving={() => {}} />);
  await act(async () => render());
  await act(async () => {});
  // Any App state change (a toast, sessions.changed, a list refresh) renders App again with a new request function.
  await act(async () => render());
  await act(async () => {});
  await act(async () => {});
  const scans = sent.filter((m) => m.type === "worktree.status").map((m) => m.scan);
  expect(new Set(scans).size).toBe(2);
  expect(document.querySelector(`[data-key="wt:${P("safe")}"]`)!.textContent).toContain("Safe");
  expect(document.querySelector(`[data-key="wt:${P("safe")}"]`)!.textContent).not.toContain("cancelled");
});

it("with a stable request (as App passes it), a re-render does not scan or fetch again", async () => {
  const sent: Record<string, unknown>[] = [];
  const request = (async (m: Record<string, unknown>) => (sent.push(m), m.type === "worktree.cached" ? { statuses: {} } : m.type === "worktree.status" ? STATUS[m.path as string]! : {})) as never;
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const render = () => root!.render(<CleanupDialog scope={{ kind: "all" }} list={list} worktrees={worktrees} state={(s) => s.state} request={request} onClose={() => {}} onDone={() => {}} onRemoving={() => {}} />);
  await act(async () => render());
  await act(async () => {});
  await act(async () => render());
  await act(async () => {});
  expect(sent.filter((m) => m.type === "git.fetch")).toHaveLength(1);
  expect(sent.filter((m) => m.type === "worktree.cancel")).toHaveLength(0);
});
