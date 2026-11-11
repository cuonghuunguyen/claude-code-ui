// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import type { OpReply } from "./git-remote-ops.ts";
import { StashSection } from "./git-stash.tsx";

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(null)));
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const h = (n: number) => String(n).repeat(40);
const STASHES = [
  { index: 0, hash: h(1), message: "On main: second", time: 1_700_000_000 },
  { index: 1, hash: h(2), message: "On main: first", time: 1_700_000_000 },
];
const q = (id: string, from: ParentNode = document) => from.querySelector<HTMLElement>(`[data-testid=${id}]`)!;
const click = (e: HTMLElement) => act(async () => e.click());

async function mount(open = true) {
  const request = vi.fn(async () => ({ stashes: STASHES }));
  const onRun = vi.fn();
  const client = { request } as unknown as ReturnType<typeof connect>;
  await act(async () => root.render(<StashSection client={client} cwd="/p" version={0} busy={false} onRun={onRun} open={open} />));
  await flush();
  return { request, onRun };
}

it("loads and lists the entries only while open", async () => {
  const closed = await mount(false);
  expect(closed.request).not.toHaveBeenCalled();
  expect(q("stash-section")).toBeNull();
  const c = await mount();
  expect(c.request).toHaveBeenCalledWith({ type: "git.stashList", cwd: "/p" });
  expect(document.querySelectorAll("[data-testid=stash-row]")).toHaveLength(2);
  expect(q("stash-section").textContent).toContain("Stashes (2)");
});

it("Apply sends the entry's index and hash, and the result line says Applied or conflicts; Pop sends git.stashPop; Drop sends nothing until the confirm, and Cancel sends nothing", async () => {
  const c = await mount();
  await click(q("stash-apply", document.querySelectorAll("[data-testid=stash-row]")[1] as HTMLElement));
  const [msg, done, running] = c.onRun.mock.calls[0];
  expect(msg).toEqual({ type: "git.stashApply", cwd: "/p", index: 1, hash: h(2) });
  expect(running).toBe("Applying stash@{1}…");
  expect(done({ written: { output: "", refs: null } } as OpReply)).toBe("Applied stash@{1}");
  expect(done({ written: { output: "", refs: null, operation: { kind: "conflict", conflicted: ["a.txt"] } } } as OpReply)).toBe("Applying stash@{1} stopped on conflicts: see the Changes tab");
  await click(q("stash-pop"));
  expect(c.onRun.mock.calls[1][0]).toEqual({ type: "git.stashPop", cwd: "/p", index: 0, hash: h(1) });
  await click(q("stash-drop"));
  expect(q("git-stash-drop-dialog").textContent).toContain("Drop stash@{0}?");
  await click(q("git-stash-drop-cancel"));
  expect(c.onRun, "after Cancel").toHaveBeenCalledTimes(2);
  await click(q("stash-drop"));
  await click(q("git-stash-drop-confirm"));
  expect(c.onRun.mock.calls[2][0]).toEqual({ type: "git.stashDrop", cwd: "/p", index: 0, hash: h(1) });
});

it("the push dialog sends the message and includeUntracked only when set", async () => {
  const c = await mount();
  await click(q("stash-push"));
  await click(q("git-stash-push-confirm"));
  expect(c.onRun.mock.calls[0][0]).toEqual({ type: "git.stashPush", cwd: "/p" });
  await click(q("stash-push"));
  const input = q("stash-message") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, " wip ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(q("stash-untracked"));
  await click(q("git-stash-push-confirm"));
  expect(c.onRun.mock.calls[1][0]).toEqual({ type: "git.stashPush", cwd: "/p", message: "wip", includeUntracked: true });
});
