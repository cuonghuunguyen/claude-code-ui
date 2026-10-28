// @vitest-environment jsdom
import type { BranchRow, JiraTicket } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Request } from "./client.ts";
import { CreateWorktreeDialog } from "./create-worktree-dialog.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

const R = "/home/u/repo";
const BRANCHES: BranchRow[] = [
  { name: "main", local: true, remote: "refs/remotes/origin/main", worktree: R },
  { name: "feat/remote", local: false, remote: "refs/remotes/origin/feat/remote" },
  { name: "busy", local: true, worktree: `${R}/.claude/worktrees/busy` },
  { name: "feature/PRJ-2-old-try", local: false, remote: "refs/remotes/origin/feature/PRJ-2-old-try" },
];
const TICKETS: JiraTicket[] = [
  { key: "PRJ-1", type: "Bug", summary: "Login fails on Safari", status: "In Progress" },
  { key: "PRJ-2", type: "Story", summary: "Dark mode", status: "To Do" },
];

let root: Root | undefined;
let el: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  el?.remove();
  localStorage.clear();
  vi.useRealTimers();
});

function mount(o: { jira?: boolean; jql?: string; noTickets?: boolean; fetchError?: string; createError?: string } = {}) {
  const calls: Request[] = [];
  const request = vi.fn(async (m: Request) => {
    calls.push(m);
    if (m.type === "worktree.branches") return { branches: BRANCHES, defaultBase: "origin/main", ...(m.fetch && (o.fetchError ? { fetchError: o.fetchError } : { fetched: true })) };
    if (m.type === "settings.get") return { settings: { jira: o.jira ? { url: "https://acme.atlassian.net", email: "a@b.c", template: "{type}/{key}-{summary}", jql: o.jql ?? "" } : { url: "", email: "", template: "{type}/{key}-{summary}" } }, jiraToken: !!o.jira };
    if (m.type === "worktree.pr") {
      if (m.url.includes("/other/")) throw new Error("Pull request #9 is in acme/other on github.com, not in this repository");
      return m.url.includes("/pull/2") ? { number: 2, branches: ["feature/PRJ-2-old-try"] } : { number: 7, branches: ["feat/remote"] };
    }
    if (m.type === "jira.search") return { tickets: o.noTickets ? [] : m.text ? TICKETS.filter((t) => t.key === m.text || t.summary.toLowerCase().includes(m.text!.toLowerCase())) : TICKETS };
    if (m.type === "worktree.create") {
      if (o.createError) throw new Error(o.createError);
      const branch = "branch" in m && m.branch ? m.branch : (m.checkout ?? "").replace(/^refs\/(heads|remotes\/origin)\//, "");
      return { path: `${R}/.claude/worktrees/${branch.replaceAll("/", "-")}`, branch };
    }
    throw new Error(`unexpected ${m.type}`);
  });
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const onJiraSettings = vi.fn();
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  act(() => root!.render(<CreateWorktreeDialog project={R} request={request as never} onClose={onClose} onCreated={onCreated} onJiraSettings={onJiraSettings} />));
  return { calls, onCreated, onClose, onJiraSettings };
}
const q = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const type = async (id: string, value: string) => {
  const input = q<HTMLInputElement | HTMLSelectElement>(id)!;
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};
const click = (node: Element | null) => act(async () => (node as HTMLElement).click());

it("Name: the normalized branch and its folder show live; Create sends the branch; empty disables Create", async () => {
  const { calls, onCreated } = mount();
  await flush();
  expect(q("create-worktree-tab-name")!.getAttribute("aria-selected")).toBe("true");
  expect(q<HTMLButtonElement>("create-worktree-confirm")!.disabled).toBe(true);
  await type("create-worktree-name", "Fix Login Ü");
  expect(q("create-worktree-branch")!.textContent).toBe("fix-login-u");
  expect(q("create-worktree-folder")!.textContent).toBe(".claude/worktrees/fix-login-u");
  await type("create-worktree-name", "feat/x");
  expect(q("create-worktree-folder")!.textContent).toBe(".claude/worktrees/feat-x");
  await type("create-worktree-name", "???");
  expect(q<HTMLButtonElement>("create-worktree-confirm")!.disabled).toBe(true);
  await type("create-worktree-name", "feat/x");
  await click(q("create-worktree-confirm"));
  expect(calls.find((c) => c.type === "worktree.create")).toEqual({ type: "worktree.create", cwd: R, branch: "feat/x" });
  expect(onCreated).toHaveBeenCalledWith(R, { path: `${R}/.claude/worktrees/feat-x`, branch: "feat/x" });
});

it("Base picker lists local and remote branches with the default first; the choice goes with Create", async () => {
  const { calls } = mount();
  await flush();
  expect(q("create-worktree-base")!.textContent).toContain("Default (origin/main)");
  await click(q("create-worktree-base"));
  const opts = [...document.querySelectorAll("[role=option]")].map((o) => o.textContent);
  expect(opts).toEqual(["Default (origin/main)", "main", "busy", "origin/main", "origin/feat/remote", "origin/feature/PRJ-2-old-try"]);
  await click(q("create-worktree-base-refs/remotes/origin/feat/remote"));
  expect(q("create-worktree-base")!.textContent).toContain("origin/feat/remote");
  await type("create-worktree-name", "x");
  await click(q("create-worktree-confirm"));
  expect(calls.find((c) => c.type === "worktree.create")).toMatchObject({ branch: "x", base: "refs/remotes/origin/feat/remote" });
});

it("a daemon error shows in the modal, which stays open", async () => {
  const { onCreated } = mount({ createError: "Branch x already exists" });
  await flush();
  await type("create-worktree-name", "x");
  await click(q("create-worktree-confirm"));
  expect(q("banner-error")!.textContent).toBe("Branch x already exists");
  expect(onCreated).not.toHaveBeenCalled();
  expect(q("create-worktree")).not.toBeNull();
});

it("Branch: rows with Local / Remote, a branch in another worktree is disabled, the filter narrows, a remote one checks out", async () => {
  const { calls, onCreated } = mount();
  await flush();
  await click(q("create-worktree-tab-branch"));
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="create-worktree-branch-row"]')];
  expect(rows().map((r) => r.textContent)).toEqual(["mainin worktree repo", "feat/remoteRemote", "busyin worktree busy", "feature/PRJ-2-old-tryRemote"]);
  expect(rows()[0]!.getAttribute("aria-disabled")).toBe("true");
  await click(rows()[0]!);
  expect(q<HTMLButtonElement>("create-worktree-confirm")!.disabled).toBe(true);
  await type("create-worktree-filter", "REMOTE");
  expect(rows().map((r) => r.dataset.name)).toEqual(["feat/remote"]);
  await click(rows()[0]!);
  expect(q("create-worktree-folder")!.textContent).toBe(".claude/worktrees/feat-remote");
  await click(q("create-worktree-confirm"));
  expect(calls.find((c) => c.type === "worktree.create")).toEqual({ type: "worktree.create", cwd: R, checkout: "refs/remotes/origin/feat/remote" });
  expect(onCreated).toHaveBeenCalled();
  // The tab is remembered in this browser.
  expect(localStorage.getItem("claude-ui.worktreeSource")).toBe("branch");
});

it("Branch: offline shows the local list with a hint", async () => {
  mount({ fetchError: "could not read from remote" });
  await flush();
  await click(q("create-worktree-tab-branch"));
  expect(q("create-worktree-offline")!.textContent).toContain("Could not fetch from origin");
  expect(q("create-worktree-fetching")).toBeNull();
});

it("Ticket without Jira: a link to Settings › Jira", async () => {
  const { onJiraSettings } = mount();
  await flush();
  await click(q("create-worktree-tab-ticket"));
  await click(q("create-worktree-jira-settings"));
  expect(onJiraSettings).toHaveBeenCalled();
});

it("Ticket: opens on my tickets when Jira is set up; picking one prefills the template name, editable; an existing branch with the key is offered", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { calls } = mount({ jira: true });
  await flush();
  await flush();
  expect(q("create-worktree-tab-ticket")!.getAttribute("aria-selected")).toBe("true");
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="create-worktree-ticket-row"]')];
  expect(rows().map((r) => r.dataset.key)).toEqual(["PRJ-1", "PRJ-2"]);
  expect(calls.find((c) => c.type === "jira.search")).toEqual({ type: "jira.search" });
  await click(rows()[0]!);
  expect(q<HTMLInputElement>("create-worktree-ticket-branch")!.value).toBe("bugfix/PRJ-1-login-fails-on-safari");
  await type("create-worktree-ticket-branch", "bugfix/PRJ-1 Safari Login");
  expect(q("create-worktree-branch")!.textContent).toBe("bugfix/PRJ-1-safari-login");
  expect(q("create-worktree-existing")).toBeNull();
  await click(q("create-worktree-confirm"));
  expect(calls.find((c) => c.type === "worktree.create")).toEqual({ type: "worktree.create", cwd: R, branch: "bugfix/PRJ-1-safari-login" });
});

it("Ticket: an empty list names the Ticket filter when one is set, else my open tickets", async () => {
  mount({ jira: true, noTickets: true, jql: "project = ABC" });
  await flush();
  await flush();
  expect(q("create-worktree-tickets")!.textContent).toBe("No tickets match the Ticket filter");
  act(() => root?.unmount());
  mount({ jira: true, noTickets: true });
  await flush();
  await flush();
  expect(q("create-worktree-tickets")!.textContent).toBe("No open tickets assigned to you");
});

it("Ticket: typed text searches after a pause; the existing branch of PRJ-2 checks out instead", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { calls } = mount({ jira: true });
  await flush();
  await flush();
  await type("create-worktree-ticket-search", "PRJ-2");
  await act(async () => void vi.advanceTimersByTime(400));
  await flush();
  expect(calls.filter((c) => c.type === "jira.search").at(-1)).toEqual({ type: "jira.search", text: "PRJ-2" });
  const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="create-worktree-ticket-row"]')];
  expect(rows.map((r) => r.dataset.key)).toEqual(["PRJ-2"]);
  await click(rows[0]!);
  expect(q("create-worktree-existing")!.textContent).toContain("feature/PRJ-2-old-try");
  await click(q("create-worktree-checkout-existing"));
  expect(calls.find((c) => c.type === "worktree.create")).toEqual({ type: "worktree.create", cwd: R, checkout: "refs/remotes/origin/feature/PRJ-2-old-try" });
});

const rowNames = () => [...document.querySelectorAll<HTMLElement>('[data-testid="create-worktree-branch-row"]')].map((r) => r.dataset.name);
const branchTab = async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const m = mount();
  await flush();
  await click(q("create-worktree-tab-branch"));
  return m;
};

it("Branch: a pasted pull request link lists and selects the origin branch at its head", async () => {
  const { calls } = await branchTab();
  await type("create-worktree-filter", "https://github.com/acme/app/pull/7/files");
  expect(q("create-worktree-pr")!.textContent).toContain("Looking up");
  await act(async () => void vi.advanceTimersByTime(400));
  await flush();
  expect(calls.find((c) => c.type === "worktree.pr")).toEqual({ type: "worktree.pr", cwd: R, url: "https://github.com/acme/app/pull/7/files" });
  expect(q("create-worktree-pr")!.textContent).toBe("Pull request #7: feat/remote");
  expect(rowNames()).toEqual(["feat/remote"]);
  expect(q("create-worktree-branch")!.textContent).toBe("feat/remote");
  await click(q("create-worktree-confirm"));
  expect(calls.find((c) => c.type === "worktree.create")).toEqual({ type: "worktree.create", cwd: R, checkout: "refs/remotes/origin/feat/remote" });
});

it("Branch: a pull request of another repository shows the error; a pasted ticket link or key lists the branches with its key", async () => {
  await branchTab();
  await type("create-worktree-filter", "https://github.com/acme/other/pull/9");
  await act(async () => void vi.advanceTimersByTime(400));
  await flush();
  expect(q("create-worktree-pr")!.getAttribute("role")).toBe("alert");
  expect(q("create-worktree-pr")!.textContent).toContain("not in this repository");
  expect(rowNames()).toEqual([]);
  await type("create-worktree-filter", "https://jira.example.com/browse/prj-2");
  expect(q("create-worktree-pr")).toBeNull();
  expect(rowNames()).toEqual(["feature/PRJ-2-old-try"]);
  expect(q("create-worktree-branch")!.textContent).toBe("feature/PRJ-2-old-try");
  await type("create-worktree-filter", "PRJ-20");
  expect(rowNames()).toEqual([]);
});

it("Ticket: a pasted pull request link finds the ticket its branch names, and offers that branch", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { calls } = mount({ jira: true });
  await flush();
  await flush();
  await type("create-worktree-ticket-search", "https://github.com/acme/app/pull/2");
  await act(async () => void vi.advanceTimersByTime(400));
  await flush();
  await flush();
  expect(calls.find((c) => c.type === "worktree.pr")).toMatchObject({ url: "https://github.com/acme/app/pull/2" });
  expect(calls.filter((c) => c.type === "jira.search").at(-1)).toEqual({ type: "jira.search", text: "PRJ-2" });
  const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="create-worktree-ticket-row"]')];
  expect(rows.map((r) => r.dataset.key)).toEqual(["PRJ-2"]);
  await click(rows[0]!);
  expect(q("create-worktree-existing")!.textContent).toContain("feature/PRJ-2-old-try");
});

it("Ticket: a pull request whose branch names no key says so", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mount({ jira: true });
  await flush();
  await flush();
  await type("create-worktree-ticket-search", "https://github.com/acme/app/pull/7");
  await act(async () => void vi.advanceTimersByTime(400));
  await flush();
  await flush();
  expect(document.body.textContent).toContain("The branch of pull request #7 (feat/remote) names no ticket key");
});

it("a plain branch list that arrives after the fetched one does not replace it", async () => {
  const gates: Record<string, (v: unknown) => void> = {};
  const request = vi.fn((m: Request) => {
    if (m.type === "worktree.branches") return new Promise((r) => (gates[m.fetch ? "fetched" : "plain"] = r));
    if (m.type === "settings.get") return Promise.resolve({ settings: { jira: { url: "", email: "", template: "" } }, jiraToken: false });
    return Promise.reject(new Error(`unexpected ${m.type}`));
  });
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  act(() => root!.render(<CreateWorktreeDialog project={R} request={request as never} onClose={vi.fn()} onCreated={vi.fn()} onJiraSettings={vi.fn()} />));
  await flush();
  await act(async () => gates.fetched!({ branches: [{ name: "fresh", local: false, remote: "refs/remotes/origin/fresh" }], defaultBase: "origin/main", fetched: true }));
  await act(async () => gates.plain!({ branches: [{ name: "stale", local: true }], defaultBase: "origin/main" }));
  await flush();
  expect(document.body.textContent).not.toContain("stale");
});
