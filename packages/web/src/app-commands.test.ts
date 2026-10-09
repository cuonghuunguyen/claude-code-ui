// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";
import { appCommands, shortcutFor, type CommandContext } from "./app-commands.ts";
import { KEYS } from "./shortcuts.ts";

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  tabs: ["a", "b", "new"],
  activeId: "a",
  sessions: [{ id: "a", cwd: "/w/api", title: "Fix login", lastActivity: 0 } as SessionListItem],
  session: { model: "opus", effort: "default", mode: "default", modes: ["default", "acceptEdits", "plan"], running: false, prompts: [{ id: "u1", text: "first\nmore" }, { id: "u2", text: "second" }] },
  models: [
    { value: "opus", displayName: "Opus", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    { value: "sonnet", displayName: "Sonnet", description: "" },
  ],
  canQuickOpen: true,
  newSession: vi.fn(),
  selectTab: vi.fn(),
  closeTab: vi.fn(),
  quickOpen: vi.fn(),
  toggleSidebar: vi.fn(),
  toggleSidePanel: vi.fn(),
  toggleFileTree: vi.fn(),
  toggleTerminal: vi.fn(),
  toggleSignalOnly: vi.fn(),
  showPane: vi.fn(),
  newTerminal: vi.fn(),
  reopenTab: vi.fn(),
  canReopen: false,
  openShortcuts: vi.fn(),
  focusPrompt: vi.fn(),
  setModel: vi.fn(),
  setEffort: vi.fn(),
  setMode: vi.fn(),
  rewind: vi.fn(),
  stop: vi.fn(),
  openSettings: vi.fn(),
  startGuide: vi.fn(),
  ...over,
});

const ev = (key: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key, ...init });
const run = (c: CommandContext, id: string) => {
  const i = appCommands(c).find((x) => x.id === id)!;
  "run" in i ? i.run() : null;
  return i;
};

it("lists the issue's commands with shortcuts, then the sessions", () => {
  const items = appCommands(ctx());
  expect(items.map((i) => [i.id, i.keys])).toEqual([
    ["session.new", "mod+shift+s"],
    ["file.open", "mod+p"],
    ["tab.next", "mod+alt+arrowright"],
    ["tab.prev", "mod+alt+arrowleft"],
    ["tab.close", "mod+alt+w"],
    ["tab.goto1", "alt+1"],
    ["tab.goto2", "alt+2"],
    ["tab.goto3", "alt+3"],
    ["tab.gotoLast", "alt+9"],
    ["shortcuts.open", "mod+/"],
    ["settings.open", "mod+,"],
    ["guide.start", undefined],
    ["sidebar.toggle", "mod+b"],
    ["panel.toggle", "mod+shift+r"],
    ["filetree.toggle", "mod+\\"],
    ["pane.files", "mod+shift+e"],
    ["pane.changes", "mod+shift+g"],
    ["terminal.toggle", "ctrl+`"],
    ["signal.toggle", "mod+alt+s"],
    ["terminal.new", "ctrl+shift+`"],
    ["prompt.focus", "ctrl+l"],
    ["model.choose", "mod+'"],
    ["effort.choose", undefined],
    ["mode.choose", "shift+tab"],
    ["rewind", undefined],
    ["session:a", undefined],
  ]);
});

it("next / previous tab wrap around the tab order", () => {
  const c = ctx({ activeId: "new" });
  run(c, "tab.next");
  expect(c.selectTab).toHaveBeenLastCalledWith("a");
  run(c, "tab.prev");
  expect(c.selectTab).toHaveBeenLastCalledWith("b");
});

it("Toggle file tree runs toggleFileTree and also finds it by Ctrl+\\; not on the new-session draft", () => {
  const c = ctx();
  run(c, "filetree.toggle");
  expect(c.toggleFileTree).toHaveBeenCalledOnce();
  expect(shortcutFor(appCommands(c), ev("\\", { ctrlKey: true }))?.id).toBe("filetree.toggle");
  expect(appCommands(ctx({ session: { ...ctx().session!, draft: true } })).find((i) => i.id === "filetree.toggle")).toBeUndefined();
});

it("a tab switch from a shortcut or the palette puts focus in the new tab's prompt", () => {
  for (const id of ["tab.next", "tab.prev", "session:a"]) {
    const c = ctx();
    run(c, id);
    expect(c.focusPrompt, id).toHaveBeenCalledWith(vi.mocked(c.selectTab).mock.calls[0]![0]);
  }
});

it("model, effort and mode pages mark the current value and set the chosen one", () => {
  const c = ctx();
  const items = appCommands(c);
  const page = (id: string) => {
    const i = items.find((x) => x.id === id)!;
    return "page" in i ? i.page.items : [];
  };
  expect(page("model.choose").map((i) => [i.title, !!i.checked])).toEqual([["Opus", true], ["Sonnet", false]]);
  expect(page("effort.choose").map((i) => i.title)).toEqual(["Default", "Low", "High"]);
  const plan = page("mode.choose").find((i) => i.title === "Plan mode")!;
  "run" in plan && plan.run();
  expect(c.setMode).toHaveBeenCalledWith("plan");
});

it("the mode page lists Auto mode and Don't ask (deny unapproved) when the session offers them", () => {
  const c = ctx();
  c.session!.modes = ["default", "acceptEdits", "plan", "auto", "dontAsk"];
  const mode = appCommands(c).find((x) => x.id === "mode.choose")!;
  const titles = "page" in mode ? mode.page.items.map((i) => i.title) : [];
  expect(titles).toEqual(["Ask before edits", "Edit automatically", "Plan mode", "Auto mode", "Don't ask (deny unapproved)"]);
  const dontAsk = "page" in mode && mode.page.items.find((i) => i.title.startsWith("Don't ask"))!;
  dontAsk && "run" in dontAsk && dontAsk.run();
  expect(c.setMode).toHaveBeenCalledWith("dontAsk");
});

it("rewind lists prompts newest first; hidden while a turn runs, when Stop shows instead", () => {
  const items = appCommands(ctx());
  const rw = items.find((i) => i.id === "rewind")!;
  expect("page" in rw && rw.page.items.map((i) => i.title)).toEqual(["second", "first"]);
  const running = appCommands(ctx({ session: { ...ctx().session!, running: true } }));
  expect(running.some((i) => i.id === "rewind")).toBe(false);
  expect(running.find((i) => i.id === "session.stop")?.keys).toBe("escape");
});

it("without a shown session only the app-level commands remain", () => {
  const items = appCommands(ctx({ session: undefined, canQuickOpen: false, tabs: ["new"], activeId: "new", sessions: [] }));
  expect(items.map((i) => i.id)).toEqual(["session.new", "tab.close", "tab.goto1", "tab.gotoLast", "shortcuts.open", "settings.open", "guide.start", "sidebar.toggle", "signal.toggle"]);
});

it("a shortcut finds its command; Esc, Shift+Tab and plain keys run nothing from here", () => {
  const items = appCommands(ctx({ session: { ...ctx().session!, running: true } }));
  expect(shortcutFor(items, ev("S", { ctrlKey: true, shiftKey: true }))?.id).toBe("session.new");
  expect(shortcutFor(items, ev("ArrowRight", { ctrlKey: true, altKey: true }))?.id).toBe("tab.next");
  expect(shortcutFor(items, ev("'", { ctrlKey: true }))?.id).toBe("model.choose");
  expect(shortcutFor(items, ev("Escape"))).toBeUndefined();
  expect(shortcutFor(items, ev("Tab", { shiftKey: true }))).toBeUndefined();
  expect(shortcutFor(items, ev("s"))).toBeUndefined();
});

it("sessions newest first: the 5 most recent show at an empty query, the rest only for a search; rows carry avatar, open marker and time", () => {
  const now = Date.now();
  const sessions = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, cwd: "/w/api", title: `T${i}`, lastActivity: now - (7 - i) * 60_000 }) as SessionListItem);
  const rows = appCommands(ctx({ sessions, tabs: ["s6"], activeId: "s6" })).filter((i) => i.group === "Sessions");
  expect(rows.map((r) => [r.id, !!r.searchOnly, !!r.open])).toEqual([
    ["session:s6", false, true],
    ["session:s5", false, false],
    ["session:s4", false, false],
    ["session:s3", false, false],
    ["session:s2", false, false],
    ["session:s1", true, false],
    ["session:s0", true, false],
  ]);
  expect(rows[0]).toMatchObject({ cwd: "/w/api", description: "api", meta: "1m ago" });
});

it("lists MCP servers in the Customize group while a project is shown", () => {
  expect(appCommands(ctx()).find((i) => i.id === "mcp.open")).toBeUndefined();
  const openMcp = vi.fn();
  const item = run(ctx({ openMcp }), "mcp.open");
  expect(item).toMatchObject({ group: "Customize", title: "MCP servers", description: "Configure Model Context Protocol servers" });
  expect(openMcp).toHaveBeenCalled();
});

it("lists Slash commands in the Customize group while a project is shown", () => {
  expect(appCommands(ctx()).find((i) => i.id === "skills.open")).toBeUndefined();
  const openSkills = vi.fn();
  const item = run(ctx({ openSkills }), "skills.open");
  expect(item).toMatchObject({ group: "Customize", title: "Slash commands", description: "Browse slash commands" });
  expect(openSkills).toHaveBeenCalled();
});

it("lists Manage plugins in the Customize group while a project is shown", () => {
  expect(appCommands(ctx()).find((i) => i.id === "plugins.open")).toBeUndefined();
  const openPlugins = vi.fn();
  const item = run(ctx({ openPlugins }), "plugins.open");
  expect(item).toMatchObject({ group: "Customize", title: "Manage plugins", description: "Install, enable, or disable plugins" });
  expect(openPlugins).toHaveBeenCalled();
});

it("Open settings is a palette command and Ctrl+, runs it, with or without a session", () => {
  for (const c of [ctx(), ctx({ session: undefined, tabs: [], activeId: undefined })]) {
    const items = appCommands(c);
    expect(items.find((i) => i.id === "settings.open")).toMatchObject({ title: "Open settings", keys: "mod+," });
    const hit = shortcutFor(items, ev(",", { ctrlKey: true }));
    expect(hit?.id).toBe("settings.open");
    (hit as { run: () => void }).run();
    expect(c.openSettings).toHaveBeenCalledOnce();
  }
});

it("New worktree… shows only with a git project, right after New session, and runs the callback", () => {
  const newWorktree = vi.fn();
  const items = appCommands(ctx({ newWorktree }));
  const ids = items.map((i) => i.id);
  expect(ids.indexOf("worktree.new")).toBe(ids.indexOf("session.new") + 1);
  expect(items.find((i) => i.id === "worktree.new")).toMatchObject({ title: "New worktree…", group: "Commands" });
  run(ctx({ newWorktree }), "worktree.new");
  expect(newWorktree).toHaveBeenCalled();
  expect(appCommands(ctx()).some((i) => i.id === "worktree.new")).toBe(false);
});

it("Toggle signal only runs from the palette and Mod+Alt+S, with or without a session", () => {
  const toggleSignalOnly = vi.fn();
  const c = ctx({ toggleSignalOnly });
  run(c, "signal.toggle");
  expect(toggleSignalOnly).toHaveBeenCalledOnce();
  expect(shortcutFor(appCommands(c), ev("s", { ctrlKey: true, altKey: true }))?.id).toBe("signal.toggle");
  expect(appCommands(ctx({ toggleSignalOnly, session: { ...ctx().session!, draft: true } })).some((i) => i.id === "signal.toggle")).toBe(true);
  expect(appCommands(ctx({ toggleSignalOnly, session: undefined })).some((i) => i.id === "signal.toggle")).toBe(true);
});

it("Open Focus is always listed when App offers it; Next waiting request only while something waits, on Ctrl+Alt+Down", () => {
  const openFocus = vi.fn();
  const nextWaiting = vi.fn();
  expect(appCommands(ctx({ openFocus })).map((i) => [i.id, i.keys]).filter(([id]) => String(id).startsWith("focus."))).toEqual([["focus.open", undefined]]);
  const c = ctx({ openFocus, nextWaiting });
  expect(appCommands(c).map((i) => i.id).filter((id) => id.startsWith("focus."))).toEqual(["focus.open", "focus.next"]);
  run(c, "focus.next");
  expect(nextWaiting).toHaveBeenCalledOnce();
  expect(shortcutFor(appCommands(c), ev("ArrowDown", { ctrlKey: true, altKey: true }))?.id).toBe("focus.next");
  expect(shortcutFor(appCommands(ctx({ openFocus })), ev("ArrowDown", { ctrlKey: true, altKey: true }))).toBeUndefined();
  // Never Escape: Esc stops the running turn.
  expect(KEYS["focus.next"]).not.toMatch(/escape/);
});

it("lists Show guide without a shortcut and runs startGuide", () => {
  const c = ctx();
  const row = run(c, "guide.start");
  expect(row.title).toBe("Show guide");
  expect(row.keys).toBeUndefined();
  expect(c.startGuide).toHaveBeenCalledOnce();
});

it("new commands: Go to tab N, last tab and reopen run their action; Go to tab rows only show for a typed search", () => {
  const items = appCommands(ctx({ canReopen: true, isGit: true }));
  expect(items.filter((i) => i.id.startsWith("tab.goto")).every((i) => i.searchOnly)).toBe(true);
  expect(items.find((i) => i.id === "tab.reopen")?.keys).toBe("alt+shift+t");
  expect(items.find((i) => i.id === "pane.graph")?.keys).toBe("mod+shift+h");
  const c = ctx({ canReopen: true });
  run(c, "tab.goto2");
  expect(c.selectTab).toHaveBeenCalledWith("b");
  run(c, "tab.gotoLast");
  expect(c.selectTab).toHaveBeenLastCalledWith("new");
  run(c, "tab.reopen");
  expect(c.reopenTab).toHaveBeenCalled();
  run(c, "pane.changes");
  expect(c.showPane).toHaveBeenCalledWith("changes");
  expect(appCommands(ctx()).some((i) => i.id === "tab.reopen" || i.id === "pane.graph")).toBe(false);
  expect(appCommands(ctx({ tabs: ["a"] })).some((i) => i.id === "tab.goto2")).toBe(false);
});

it("shortcutFor finds the new keys by id", () => {
  const items = appCommands(ctx({ canReopen: true }));
  expect(shortcutFor(items, ev("+", { altKey: true, code: "Digit2" }))?.id).toBe("tab.goto2");
  expect(shortcutFor(items, ev("T", { altKey: true, shiftKey: true, code: "KeyT" }))?.id).toBe("tab.reopen");
  expect(shortcutFor(items, ev("E", { ctrlKey: true, shiftKey: true }))?.id).toBe("pane.files");
  expect(shortcutFor(items, ev("/", { ctrlKey: true }))?.id).toBe("shortcuts.open");
});

it("a remapped key matches and the old key no longer does; a removed binding matches nothing", async () => {
  const { bind, resetAll } = await import("./keymap.ts");
  bind("sidebar.toggle", "mod+alt+b");
  const items = appCommands(ctx());
  expect(items.find((i) => i.id === "sidebar.toggle")?.keys).toBe("mod+alt+b");
  expect(shortcutFor(items, ev("b", { ctrlKey: true, altKey: true }))?.id).toBe("sidebar.toggle");
  expect(shortcutFor(items, ev("b", { ctrlKey: true }))).toBeUndefined();
  bind("sidebar.toggle", null);
  expect(appCommands(ctx()).find((i) => i.id === "sidebar.toggle")?.keys).toBeUndefined();
  resetAll();
});
