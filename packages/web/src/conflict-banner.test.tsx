// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { GitOperation } from "@claude-ui/protocol";
import type { connect } from "./client.ts";
import { ConflictBanner } from "./conflict-banner.tsx";
import { forgetRemoteOps, remoteOpOf } from "./git-remote-ops.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  forgetRemoteOps();
  document.body.innerHTML = "";
});
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid=${id}]`)!;

function mount(operation: GitOperation, reply: unknown = { written: { output: "", refs: "s2" } }) {
  const sent: Record<string, unknown>[] = [];
  const client = { request: vi.fn((m: Record<string, unknown>) => (sent.push(m), Promise.resolve(reply))) } as unknown as ReturnType<typeof connect>;
  const onOpen = vi.fn();
  const onResolve = vi.fn();
  const el = document.createElement("div");
  document.body.append(el);
  act(() => createRoot(el).render(<ConflictBanner client={client} cwd="/p" operation={operation} onOpen={onOpen} onResolve={onResolve} />));
  return { sent, onOpen, onResolve };
}

it("names the operation, lists the conflicted files (10, then +n more) and opens one", () => {
  const files = Array.from({ length: 12 }, (_, i) => `d/f${i}.ts`);
  const m = mount({ kind: "rebase", conflicted: files });
  expect(byId("conflict-banner").getAttribute("role")).toBe("status");
  expect(byId("conflict-title").textContent).toBe("Rebase in progress");
  expect(document.querySelectorAll("[data-testid=conflict-files] button")).toHaveLength(10);
  expect(byId("conflict-files").textContent).toContain("+2 more");
  act(() => document.querySelector<HTMLButtonElement>("[data-testid=conflict-files] button")!.click());
  expect(m.onOpen).toHaveBeenCalledWith("/p/d/f0.ts");
});

it("Resolve with Claude hands over the prompt with the files and sends nothing", () => {
  const m = mount({ kind: "merge", conflicted: ["a.ts", "b.ts"] });
  act(() => byId("conflict-resolve").click());
  expect(m.sent).toEqual([]);
  const prompt = m.onResolve.mock.calls[0]![0] as string;
  expect(prompt).toContain("Resolve the merge conflicts in /p");
  expect(prompt).toContain("a.ts, b.ts");
  expect(prompt).toContain("Do not run git add, git commit or git merge --continue");
});

it("without conflicted files (every one resolved) there is no Resolve button", () => {
  mount({ kind: "rebase", conflicted: [] });
  expect(byId("conflict-resolve")).toBeNull();
  expect(byId("conflict-continue").textContent).toBe("Continue");
});

it("Continue sends git.continue for the kind and shows the result line; a stop on conflicts says so", async () => {
  const m = mount({ kind: "rebase", conflicted: ["a.ts"] }, { written: { output: "x", refs: "s2", operation: { kind: "rebase", conflicted: ["b.ts"] } } });
  act(() => byId("conflict-continue").click());
  await flush();
  expect(m.sent).toEqual([{ type: "git.continue", cwd: "/p", kind: "rebase" }]);
  expect(remoteOpOf("/p").result).toEqual({ ok: true, text: "Stopped on conflicts: rebase", output: "x" });
});

it("Abort asks first; Cancel sends nothing, Confirm sends git.abort", async () => {
  const m = mount({ kind: "cherry-pick", conflicted: ["a.ts"] });
  act(() => byId("conflict-abort").click());
  expect(byId("conflict-abort-dialog").textContent).toContain("Abort the cherry-pick?");
  act(() => byId("conflict-abort-cancel").click());
  await flush();
  expect(m.sent).toEqual([]);
  act(() => byId("conflict-abort").click());
  act(() => byId("conflict-abort-confirm").click());
  await flush();
  expect(m.sent).toEqual([{ type: "git.abort", cwd: "/p", kind: "cherry-pick" }]);
  expect(remoteOpOf("/p").result?.text).toBe("Aborted the cherry-pick");
});

it("kind conflict: title Unmerged files, button Mark resolved, prompt without a continue clause", async () => {
  const m = mount({ kind: "conflict", conflicted: ["a.ts"] }, { written: { output: "", refs: "s2" } });
  expect(byId("conflict-title").textContent).toBe("Unmerged files");
  expect(byId("conflict-continue").textContent).toBe("Mark resolved");
  act(() => byId("conflict-resolve").click());
  expect(m.onResolve.mock.calls[0]![0]).not.toContain("--continue");
  act(() => byId("conflict-continue").click());
  await flush();
  expect(m.sent).toEqual([{ type: "git.continue", cwd: "/p", kind: "conflict" }]);
  expect(remoteOpOf("/p").result?.text).toBe("Marked resolved");
});
