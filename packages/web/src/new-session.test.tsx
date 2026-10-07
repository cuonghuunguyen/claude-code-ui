// @vitest-environment jsdom
import { act, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelInfo } from "@claude-ui/protocol";
import { NewSession, NewSessionTab, startSession, type StartOptions } from "./App.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};

const models: ModelInfo[] = [{ value: "default", displayName: "Default (recommended)", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high"] }];
let unmount = () => {};
// App owns the draft's model, mode and effort; the harness holds them like App does.
type Props = Omit<ComponentProps<typeof NewSession>, "draft" | "onDraft" | "modes">;
function Draft(p: Props) {
  const [draft, setDraft] = useState<StartOptions>({ model: "default", mode: "default", effort: "default" });
  return <NewSession {...p} draft={draft} onDraft={setDraft} modes={["default", "acceptEdits", "plan"]} />;
}
afterEach(() => unmount());

async function render(over: Partial<Props> = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const props: Props = {
    projects: ["/p/a", "/p/b"],
    cwd: "/p/a",
    onCwd: () => {},
    models,
    onOpenProject: () => {},
    onUpload: async () => "/tmp/u/x.txt",
    onSearch: () => async () => [],
    onCommands: async () => [],
    onStart: async () => {},
    ...over,
  };
  await act(async () => root.render(<Draft {...props} />));
  unmount = () => (root.unmount(), el.remove());
  return { el, box: el.querySelector("textarea")!, rerender: (p: Partial<Props>) => act(async () => root.render(<Draft {...props} {...p} />)) };
}

async function type(box: HTMLTextAreaElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const key = (box: HTMLElement, init: KeyboardEventInit) => act(async () => void box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })));

it("the new-session tab has the session prompt toolbar; the first prompt starts the session with the chosen mode", async () => {
  const onStart = vi.fn(async () => {});
  const { el, box } = await render({ onStart });
  for (const id of ["prompt-toolbar", "attach", "mode-select", "session-model", "effort-select"]) expect(el.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
  await key(box, { key: "Tab", shiftKey: true });
  expect(el.querySelector('[data-testid="mode-select"]')?.textContent).toContain("Edit automatically");
  await type(box, "hello");
  await key(box, { key: "Enter" });
  expect(onStart).toHaveBeenCalledWith("/p/a", { model: "default", mode: "acceptEdits", effort: "default" }, { text: "hello", images: [] });
});

it("a failed start keeps the draft; the error goes away when the project changes", async () => {
  const { el, box, rerender } = await render({ onStart: () => Promise.reject(new Error("outside the allowlisted roots")) });
  await type(box, "hello");
  await key(box, { key: "Enter" });
  expect(box.value).toBe("hello");
  expect(el.querySelector('[data-testid="prompt-error"]')?.textContent).toContain("outside the allowlisted roots");
  await rerender({ cwd: "/p/b" });
  expect(el.querySelector('[data-testid="prompt-error"]')).toBeNull();
  expect(box.value).toBe("hello");
});

it("a first prompt that fails after session.create rejects (the draft stays); the retry reuses that session", async () => {
  const info = { id: "s1", cwd: "/p/a", model: "default", permissionMode: "default", effort: "default" };
  const sent: string[] = [];
  let failPrompt = true;
  const request = vi.fn(async (msg: { type: string; model?: string }) => {
    sent.push(msg.type);
    if (msg.type === "session.prompt" && failPrompt) throw new Error("disconnected");
    return { session: { ...info, model: msg.model ?? info.model } };
  });
  const created: { current?: never } = {};
  const opts = { model: "default", mode: "default", effort: "default" } as const;
  await expect(startSession(request as never, created, "/p/a", opts, { text: "hello", images: [] })).rejects.toThrow("disconnected");
  expect(sent).toEqual(["session.create", "session.prompt"]);
  failPrompt = false;
  sent.length = 0;
  const s = await startSession(request as never, created, "/p/a", { ...opts, model: "opus" }, { text: "hello", images: [] });
  // No second session: the model goes to the one already created.
  expect(sent).toEqual(["session.setModel", "session.prompt"]);
  expect(s).toMatchObject({ id: "s1", model: "opus" });
  expect(created.current).toBeUndefined();
});

it('"!" in the first prompt box is bash mode: Enter starts the session with the command and the chosen mode; no project, no bash mode', async () => {
  const onStart = vi.fn(async () => {});
  const { el, box, rerender } = await render({ onStart });
  await key(box, { key: "Tab", shiftKey: true });
  await key(box, { key: "!" });
  expect(el.querySelector('[data-testid="bash-mode"]')).not.toBeNull();
  await type(box, "  ls -la ");
  await key(box, { key: "Enter" });
  expect(onStart).toHaveBeenCalledWith("/p/a", { model: "default", mode: "acceptEdits", effort: "default" }, { command: "ls -la" });
  expect(el.querySelector('[data-testid="bash-mode"]')).toBeNull();
  await rerender({ cwd: undefined });
  await key(box, { key: "!" });
  expect(el.querySelector('[data-testid="bash-mode"]')).toBeNull();
});

it("a failed first command keeps it in bash mode with the error", async () => {
  const { el, box } = await render({ onStart: () => Promise.reject(new Error("outside the allowlisted roots")) });
  await key(box, { key: "!" });
  await type(box, "ls");
  await key(box, { key: "Enter" });
  expect(box.value).toBe("ls");
  expect(el.querySelector('[data-testid="bash-mode"]')).not.toBeNull();
  expect(el.querySelector('[data-testid="prompt-error"]')?.textContent).toContain("Command not run: outside the allowlisted roots");
});

it("startSession with a command: create, then mode and effort, then session.bash (no prompt); a failed run keeps the session for the retry", async () => {
  const info = { id: "s1", cwd: "/p/a", model: "default", permissionMode: "default", effort: "default" };
  const sent: Record<string, unknown>[] = [];
  let fail = true;
  const request = vi.fn(async (msg: Record<string, unknown>) => {
    sent.push(msg);
    if (msg.type === "session.bash" && fail) throw new Error("session is busy");
    if (msg.mode) info.permissionMode = msg.mode as string;
    if (msg.effort) info.effort = msg.effort as string;
    return { session: { ...info } };
  });
  const created: { current?: never } = {};
  const opts = { model: "default", mode: "plan", effort: "high" } as const;
  await expect(startSession(request as never, created, "/p/a", opts, { command: "ls" })).rejects.toThrow("busy");
  expect(sent.map((m) => m.type)).toEqual(["session.create", "session.setPermissionMode", "session.setEffort", "session.bash"]);
  expect(sent.at(-1)).toEqual({ type: "session.bash", sessionId: "s1", command: "ls" });
  expect(created.current).toMatchObject({ id: "s1" });
  fail = false;
  sent.length = 0;
  await startSession(request as never, created, "/p/a", opts, { command: "ls" });
  expect(sent.map((m) => m.type)).toEqual(["session.bash"]);
  expect(created.current).toBeUndefined();
});

it("switching to another tab and back keeps the new-session draft and the chosen mode (each tab keeps its draft prompt)", async () => {
  const props = { projects: ["/p/a"], cwd: "/p/a", onCwd: () => {}, models, onOpenProject: () => {}, onUpload: async () => "", onSearch: () => async () => [], onCommands: async () => [], onStart: async () => {} };
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  unmount = () => (root.unmount(), el.remove());
  function Tab({ active }: { active: boolean }) {
    const [draft, setDraft] = useState<StartOptions>({ model: "default", mode: "default", effort: "default" });
    return <NewSessionTab active={active} {...props} draft={draft} onDraft={setDraft} modes={["default", "acceptEdits"]} />;
  }
  const show = (active: boolean) => act(async () => root.render(<Tab active={active} />));
  await show(true);
  const input = el.querySelector("textarea")!;
  await type(input, "draft text");
  await key(input, { key: "Tab", shiftKey: true });
  await show(false);
  await show(true);
  expect(el.querySelector("textarea")!.value).toBe("draft text");
  expect(el.querySelector('[data-testid="mode-select"]')?.textContent).toContain("Edit automatically");
});

it("the @-mention picker of the first prompt searches again once the daemon reconnects", async () => {
  let online = false;
  const onSearch = () => async () => (online ? ["docs/spec.md"] : Promise.reject(new Error("the daemon is reconnecting")));
  const { el, box, rerender } = await render({ connected: false, onSearch });
  await type(box, "@sp");
  expect(el.querySelector('[data-testid="mention-picker"]')).toBeNull();
  online = true;
  await rerender({ connected: true });
  expect(el.querySelector('[data-testid="mention-picker"]')?.textContent).toContain("spec.md");
});

it("/mcp alone opens the MCP servers dialog instead of starting a session; the picker lists it", async () => {
  const onStart = vi.fn(async () => {});
  const onDialog = vi.fn();
  const { el, box } = await render({ onStart, onDialog });
  await type(box, "/mc");
  expect(el.textContent).toContain("Configure Model Context Protocol servers");
  await key(box, { key: "Enter" });
  expect(onDialog).toHaveBeenCalledWith("mcp");
  expect(onStart).not.toHaveBeenCalled();
  expect(box.value).toBe("");
  await type(box, "/mcp please");
  await key(box, { key: "Enter" });
  expect(onStart).toHaveBeenCalledTimes(1);
});

it("/skills and /help alone open the Slash commands dialog instead of starting a session; the picker lists /skills", async () => {
  const onStart = vi.fn(async () => {});
  const onDialog = vi.fn();
  const { el, box } = await render({ onStart, onDialog });
  await type(box, "/ski");
  expect(el.textContent).toContain("List available skills");
  await key(box, { key: "Enter" });
  expect(onDialog).toHaveBeenLastCalledWith("skills");
  await type(box, "/help");
  await key(box, { key: "Enter" });
  expect(onDialog).toHaveBeenLastCalledWith("skills");
  expect(onStart).not.toHaveBeenCalled();
  expect(box.value).toBe("");
});

it("the project chip is an app-styled popup: picking a project sets the draft cwd, Open project… opens the dialog, no native select", async () => {
  const onCwd = vi.fn();
  const onOpenProject = vi.fn();
  const { el } = await render({ onCwd, onOpenProject });
  expect(el.querySelector("select")).toBeNull();
  const chip = () => el.querySelector<HTMLElement>('[data-testid="project-chip"]')!;
  expect(chip().getAttribute("aria-label")).toBe("Project");
  const names = async () => {
    await act(async () => chip().click());
    return [...document.querySelectorAll<HTMLElement>("[role=option]")];
  };
  let options = await names();
  expect(options.map((o) => o.textContent)).toEqual(["Aa/p/a", "Bb/p/b", "Open project…"]);
  await act(async () => options[1]!.click());
  expect(onCwd).toHaveBeenCalledWith("/p/b");
  expect(onOpenProject).not.toHaveBeenCalled();
  options = await names();
  await act(async () => options[2]!.click());
  expect(onOpenProject).toHaveBeenCalledTimes(1);
  expect(onCwd).toHaveBeenCalledTimes(1);
});

it("the project chip opens with ArrowDown and Escape returns focus to it", async () => {
  const { el } = await render();
  const chip = el.querySelector<HTMLElement>('[data-testid="project-chip"]')!;
  await act(async () => chip.focus());
  await key(chip, { key: "ArrowDown" });
  expect(document.querySelectorAll("[role=option]").length).toBe(3);
  await key(document.activeElement as HTMLElement, { key: "Escape" });
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  expect(chip.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(chip);
});

it("/ on the new-session tab lists the project's commands once they arrive, only the dialog commands before; a project change asks again", async () => {
  const lists: Record<string, ((c: { name: string; description: string; argumentHint: string }[]) => void)> = {};
  const onCommands = vi.fn((cwd: string) => new Promise<{ name: string; description: string; argumentHint: string }[]>((r) => (lists[cwd] = r)));
  const { el, box, rerender } = await render({ onCommands, onDialog: () => {} });
  expect(onCommands).toHaveBeenCalledWith("/p/a");
  const rows = () => [...el.querySelectorAll('[role="listbox"] [role=option]')].map((o) => o.textContent ?? "");
  await type(box, "/");
  expect(rows().some((r) => r.includes("/mcp"))).toBe(true);
  expect(rows().some((r) => r.includes("/review"))).toBe(false);
  await act(async () => lists["/p/a"]!([{ name: "review", description: "", argumentHint: "" }]));
  expect(rows().some((r) => r.includes("/review"))).toBe(true);
  await rerender({ cwd: "/p/b" });
  expect(onCommands).toHaveBeenLastCalledWith("/p/b");
  expect(rows().some((r) => r.includes("/review"))).toBe(false);
});

it("the new-session tab asks for the commands again when the project's config changed", async () => {
  const onCommands = vi.fn(async () => []);
  const { rerender } = await render({ onCommands, commandsRev: undefined });
  expect(onCommands).toHaveBeenCalledTimes(1);
  await rerender({ onCommands, commandsRev: 1 });
  expect(onCommands).toHaveBeenCalledTimes(2);
});

const worktrees = {
  "/p/a": [
    { path: "/p/a", branch: "main", main: true },
    { path: "/p/a-wt", branch: "feature-x", main: false },
    { path: "/far/a-out", branch: "far", main: false, outsideRoots: true },
  ],
};
const options = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];

it("Run session in lists the chosen project's worktrees inside the roots; a pick sets the draft cwd, the chip shows its branch and the first prompt starts there", async () => {
  const onCwd = vi.fn();
  const onStart = vi.fn(async () => {});
  const { el, box, rerender } = await render({ projects: ["/p/a"], worktrees, onCwd, onStart });
  const chip = () => el.querySelector<HTMLElement>('[data-testid="worktree-chip"]')!;
  expect(chip().getAttribute("aria-label")).toBe("Local, Run session in");
  expect(chip().textContent).toContain("Local");
  await act(async () => chip().click());
  expect(options().map((o) => o.textContent)).toEqual(["Local repository", "feature-x"]);
  expect(options()[1]!.title).toBe("/p/a-wt");
  expect(document.querySelector('[data-slot="select-label"]')?.textContent).toBe("Run session in");
  await act(async () => options()[1]!.click());
  expect(onCwd).toHaveBeenCalledWith("/p/a-wt");
  await rerender({ cwd: "/p/a-wt" });
  expect(chip().textContent).toContain("feature-x");
  expect(el.querySelector('[data-testid="new-project"]')?.textContent).toBe("a");
  expect(box.placeholder).toBe("Ask Claude in a · feature-x…");
  await act(async () => el.querySelector<HTMLElement>('[data-testid="project-chip"]')!.click());
  // The worktree popup may still be unmounting: the project popup's items are what counts.
  const texts = options().map((o) => o.textContent);
  expect(texts).toContain("Aa/p/a");
  expect(texts).not.toContain("a-wt");
  await type(box, "hi");
  await key(box, { key: "Enter" });
  expect(onStart).toHaveBeenCalledWith("/p/a-wt", { model: "default", mode: "default", effort: "default" }, { text: "hi", images: [] });
});

it("a project without linked worktrees inside the roots has no Run session in chip; the project chip is unchanged", async () => {
  const wts = { "/p/b": [{ path: "/p/b", branch: "main", main: true }], "/p/a": [worktrees["/p/a"][0]!, worktrees["/p/a"][2]!] };
  const { el, rerender } = await render({ worktrees: wts });
  expect(el.querySelector('[data-testid="worktree-chip"]')).toBeNull();
  await rerender({ cwd: "/p/b" });
  expect(el.querySelector('[data-testid="worktree-chip"]')).toBeNull();
  await act(async () => el.querySelector<HTMLElement>('[data-testid="project-chip"]')!.click());
  expect(options().map((o) => o.textContent)).toEqual(["Aa/p/a", "Bb/p/b", "Open project…"]);
});

it("has no Coordinator toggle; startSession creates a plain session", async () => {
  const { el } = await render();
  expect(el.querySelector('[data-testid="coordinator-toggle"]')).toBeNull();
  const info = { id: "s1", cwd: "/p/a", model: "default", permissionMode: "default", effort: "default" };
  const request = vi.fn(async (_m: { type: string }) => ({ session: info }));
  await startSession(request as never, {}, "/p/a", { model: "default", mode: "default", effort: "default" }, { text: "hi", images: [] });
  const create = request.mock.calls.map((c) => c[0] as unknown as Record<string, unknown>).find((m) => m.type === "session.create");
  expect(create).toEqual({ type: "session.create", cwd: "/p/a", model: "default" });
});

it("Run session in offers New worktree, also for a repository with only its main checkout; picking it calls onNewWorktree with the project", async () => {
  const onNewWorktree = vi.fn();
  const onCwd = vi.fn();
  const { el } = await render({ projects: ["/p/a"], worktrees: { "/p/a": [{ path: "/p/a", branch: "main", main: true }] }, onNewWorktree, onCwd });
  const chip = el.querySelector<HTMLElement>('[data-testid="worktree-chip"]')!;
  expect(chip.textContent).toContain("Local");
  await act(async () => chip.click());
  expect(options().map((o) => o.textContent)).toEqual(["Local repository", "New worktree"]);
  await act(async () => document.querySelector<HTMLElement>('[data-testid="new-worktree-item"]')!.click());
  expect(onNewWorktree).toHaveBeenCalledWith("/p/a");
  expect(onCwd).not.toHaveBeenCalled();
});

it("while the worktree is being created the first prompt is held: 'Creating worktree…' shows, text stays, Enter sends nothing", async () => {
  const onStart = vi.fn(async () => {});
  const wts = { "/p/a": [{ path: "/p/a", branch: "main", main: true }, { path: "/p/a-wt", branch: "worktree-x", main: false }] };
  const { el, box, rerender } = await render({ projects: ["/p/a"], worktrees: wts, onNewWorktree: () => {}, worktreeJob: {}, onStart });
  expect(el.querySelector('[data-testid="external-turn"]')?.textContent).toBe("Creating worktree…");
  await type(box, "hi");
  await key(box, { key: "Enter" });
  expect(onStart).not.toHaveBeenCalled();
  expect(box.value).toBe("hi");
  await rerender({ worktreeJob: undefined, cwd: "/p/a-wt" });
  expect(el.querySelector('[data-testid="external-turn"]')).toBeNull();
  await key(box, { key: "Enter" });
  expect(onStart).toHaveBeenCalledWith("/p/a-wt", { model: "default", mode: "default", effort: "default" }, { text: "hi", images: [] });
});

it("a failed creation shows the git error and keeps the draft on the project", async () => {
  const onStart = vi.fn(async () => {});
  const { el, box } = await render({ projects: ["/p/a"], worktrees, onNewWorktree: () => {}, worktreeJob: { error: "fatal: x" }, onStart });
  expect(el.querySelector('[data-testid="worktree-error"]')?.textContent).toBe("Worktree not created: fatal: x");
  expect(el.querySelector('[data-testid="external-turn"]')).toBeNull();
  await type(box, "hi");
  await key(box, { key: "Enter" });
  expect(onStart).toHaveBeenCalledWith("/p/a", expect.anything(), { text: "hi", images: [] });
});
