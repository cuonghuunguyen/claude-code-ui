// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { CommitBox } from "./commit-box.tsx";
import { commitPaths } from "./git-changes.ts";
import { forgetRemoteOps, remoteOpOf } from "./git-remote-ops.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  forgetRemoteOps();
  document.body.innerHTML = "";
});

const rows = [
  { path: "/p/a.txt", rel: "a.txt" },
  { path: "/p/n2.txt", rel: "n2.txt", oldPath: "n1.txt" },
  { path: "/p/lib", rel: "lib" },
];
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid=${id}]`)!;

function mount(opts: { checked?: string[]; base?: string; reply?: unknown; generate?: (m: Record<string, unknown>) => Promise<unknown> } = {}) {
  const sent: Record<string, unknown>[] = [];
  const client = {
    request: vi.fn((m: Record<string, unknown>) => {
      sent.push(m);
      if (m.type === "git.commitMessage" && opts.generate) return opts.generate(m);
      if (m.type === "git.commitMessageCancel") return Promise.resolve({});
      if (m.type === "git.commit") return Promise.resolve({ commit: { message: "old subject\n\nold body\n" } });
      return Promise.resolve(opts.reply ?? { committed: { hash: "abcdef1234567", output: "ok", refs: "s1" } });
    }),
  } as unknown as ReturnType<typeof connect>;
  const onChecked = vi.fn();
  const onCommitted = vi.fn();
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const render = (checked: string[]) => act(() => root.render(<CommitBox client={client} cwd="/p" rows={rows} checked={new Set(checked)} onChecked={onChecked} project="/proj" base={opts.base ?? "b".repeat(40)} onCommitted={onCommitted} />));
  render(opts.checked ?? []);
  return { sent, onChecked, onCommitted, render, unmount: () => act(() => root.unmount()) };
}
const type = async (text: string) => {
  const ta = byId("commit-message") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

it("commitPaths sends rel, a rename's both sides, skips nested and submodule-only rows, no duplicates", () => {
  const all = [...rows, { path: "/p/inner", rel: "inner", nested: {} }, { path: "/p/sub", rel: "sub", dirtyOnly: true }, { path: "/p/a2", rel: "a.txt" }];
  expect(commitPaths(all, new Set(all.map((r) => r.path)))).toEqual(["a.txt", "n2.txt", "n1.txt", "lib"]);
  expect(commitPaths(all, new Set())).toEqual([]);
});

it("Commit and Commit and Push stay disabled without a message or without a checked file", async () => {
  const m = mount({ checked: ["/p/a.txt"] });
  expect((byId("commit-button") as HTMLButtonElement).disabled).toBe(true);
  await type("msg");
  expect((byId("commit-button") as HTMLButtonElement).disabled).toBe(false);
  expect((byId("commit-and-push") as HTMLButtonElement).disabled).toBe(false);
  await m.render([]);
  expect((byId("commit-button") as HTMLButtonElement).disabled).toBe(true);
  await type("   ");
  await m.render(["/p/a.txt"]);
  expect((byId("commit-button") as HTMLButtonElement).disabled).toBe(true);
});

it("check-all selects every row and clears when all are checked; the count reads n of m", async () => {
  const m = mount({ checked: ["/p/a.txt"] });
  expect(byId("commit-count").textContent).toBe("1 of 3");
  await act(async () => byId("commit-check-all").click());
  expect([...m.onChecked.mock.calls[0]![0] as Set<string>]).toEqual(rows.map((r) => r.path));
  await m.render(rows.map((r) => r.path));
  await act(async () => byId("commit-check-all").click());
  expect((m.onChecked.mock.calls[1]![0] as Set<string>).size).toBe(0);
});

it("Commit sends the checked paths (a rename: both sides) and the message, then clears the box and reports", async () => {
  const m = mount({ checked: ["/p/a.txt", "/p/n2.txt"] });
  await type("fix it");
  await act(async () => byId("commit-button").click());
  await flush();
  expect(m.sent).toEqual([{ type: "git.commitFiles", cwd: "/p", paths: ["a.txt", "n2.txt", "n1.txt"], message: "fix it" }]);
  expect(remoteOpOf("/p").result).toEqual({ ok: true, text: "Committed abcdef1", output: "ok" });
  expect((byId("commit-message") as HTMLTextAreaElement).value).toBe("");
  expect((m.onChecked.mock.calls.at(-1)![0] as Set<string>).size).toBe(0);
  expect(m.onCommitted).toHaveBeenCalledTimes(1);
});

it("Amend loads HEAD's message, keeps what was typed and restores it on uncheck; amend is sent", async () => {
  const m = mount({ checked: ["/p/a.txt"] });
  await type("typed");
  await act(async () => byId("commit-amend").click());
  await flush();
  expect(m.sent[0]).toMatchObject({ type: "git.commit", hash: "b".repeat(40) });
  expect((byId("commit-message") as HTMLTextAreaElement).value).toBe("old subject\n\nold body");
  await act(async () => byId("commit-amend").click());
  expect((byId("commit-message") as HTMLTextAreaElement).value).toBe("typed");
  await act(async () => byId("commit-amend").click());
  await flush();
  await act(async () => byId("commit-button").click());
  await flush();
  expect(m.sent.at(-1)).toMatchObject({ type: "git.commitFiles", amend: true, message: "old subject\n\nold body" });
});

it("Amend with no checked file is allowed while the message is not empty; no Amend before the first commit", async () => {
  const m = mount({ checked: [] });
  await act(async () => byId("commit-amend").click());
  await flush();
  expect((byId("commit-button") as HTMLButtonElement).disabled).toBe(false);
  await act(async () => byId("commit-button").click());
  await flush();
  expect(m.sent.at(-1)).toMatchObject({ type: "git.commitFiles", paths: [], amend: true });
  document.body.innerHTML = "";
  const none = mount({ base: "" });
  expect((byId("commit-amend") as HTMLInputElement).disabled).toBe(true);
  void none;
});

it("Commit and Push sends push and opens the existing push dialog with the command; the result says when there is no remote", async () => {
  const info = { ref: "refs/heads/main", local: "a".repeat(40), remote: "origin", push: ["push", "origin", "refs/heads/main:refs/heads/main"] };
  mount({ checked: ["/p/a.txt"], reply: { committed: { hash: "abcdef1234567", output: "", refs: null, push: info } } });
  await type("go");
  await act(async () => byId("commit-and-push").click());
  await flush();
  expect(byId("git-push-dialog")).toBeTruthy();
  expect(byId("git-command").textContent).toContain("push origin refs/heads/main:refs/heads/main");
  forgetRemoteOps();
  document.body.innerHTML = "";
  mount({ checked: ["/p/a.txt"], reply: { committed: { hash: "abcdef1234567", output: "", refs: null, push: { ref: "refs/heads/main", local: "a".repeat(40), why: { push: "No remote" } } } } });
  await type("go");
  await act(async () => byId("commit-and-push").click());
  await flush();
  expect(byId("git-push-dialog")).toBeNull();
  expect(remoteOpOf("/p").result?.text).toBe("Committed abcdef1. No remote");
});

it("Ctrl+Enter in the message commits", async () => {
  const m = mount({ checked: ["/p/a.txt"] });
  await type("k");
  await act(async () => void byId("commit-message").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
  await flush();
  expect(m.sent.at(-1)).toMatchObject({ type: "git.commitFiles" });
});

const defer = () => {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const generate = () => byId("commit-generate") as HTMLButtonElement;

it("Generate sends the checked paths and the project, fills the message from the reply; disabled with nothing checked", async () => {
  const m = mount({ checked: ["/p/a.txt", "/p/n2.txt"], generate: async () => ({ message: "feat: add a\n\nbody" }) });
  expect(generate().getAttribute("aria-label")).toBe("Generate commit message");
  await act(async () => generate().click());
  await flush();
  expect(m.sent.find((x) => x.type === "git.commitMessage")).toEqual({ type: "git.commitMessage", cwd: "/p", paths: ["a.txt", "n2.txt", "n1.txt"], project: "/proj" });
  expect((byId("commit-message") as HTMLTextAreaElement).value).toBe("feat: add a\n\nbody");
  expect((byId("commit-message") as HTMLTextAreaElement).readOnly).toBe(false);
  await m.render([]);
  expect(generate().disabled).toBe(true);
});

it("while generating the box is read-only and busy and the button is Stop; Stop sends a cancel, keeps the typed text and ignores the late reply", async () => {
  const d = defer();
  const m = mount({ checked: ["/p/a.txt"], generate: () => d.promise });
  await type("draft text");
  await act(async () => generate().click());
  const ta = byId("commit-message") as HTMLTextAreaElement;
  expect(ta.readOnly).toBe(true);
  expect(ta.getAttribute("aria-busy")).toBe("true");
  expect(generate().getAttribute("aria-label")).toBe("Stop generating");
  expect((byId("commit-button") as HTMLButtonElement).disabled).toBe(true);
  await act(async () => generate().click());
  expect(m.sent.some((x) => x.type === "git.commitMessageCancel")).toBe(true);
  expect(ta.readOnly).toBe(false);
  expect(generate().getAttribute("aria-label")).toBe("Generate commit message");
  await act(async () => d.resolve({ message: "late" }));
  await flush();
  expect(ta.value).toBe("draft text");
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("a failed generation shows an alert and keeps the typed text; a cancelled reply shows none", async () => {
  const queue = [defer(), defer()];
  mount({ checked: ["/p/a.txt"], generate: () => queue.shift()!.promise });
  const [first, second] = [...queue];
  await type("keep me");
  await act(async () => generate().click());
  await act(async () => first!.reject(Object.assign(new Error("Not logged in"), { code: "generate_failed" })));
  await flush();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Not logged in");
  expect((byId("commit-message") as HTMLTextAreaElement).value).toBe("keep me");
  await act(async () => generate().click());
  expect(document.querySelector('[role="alert"]')).toBeNull();
  await act(async () => second!.reject(Object.assign(new Error("cancelled"), { code: "cancelled" })));
  await flush();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(generate().getAttribute("aria-label")).toBe("Generate commit message");
});

it("unmounting during a generation sends a cancel", async () => {
  const d = defer();
  const m = mount({ checked: ["/p/a.txt"], generate: () => d.promise });
  await act(async () => generate().click());
  expect(m.sent.filter((x) => x.type === "git.commitMessageCancel")).toHaveLength(0);
  await m.unmount();
  expect(m.sent.filter((x) => x.type === "git.commitMessageCancel")).toHaveLength(1);
});
