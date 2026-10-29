// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";
import { appCommands, shortcutFor, type CommandContext } from "./app-commands.ts";
import { CLEANUP_RULES, RULE_LABEL, type CleanupMenu, type CleanupRule } from "./tab-cleanup.ts";
import { KEYS } from "./shortcuts.ts";
import { bind, resetAll } from "./keymap.ts";

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
  panels: true,
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
  resetLayout: vi.fn(),
  flipSide: vi.fn(),
  side: "right",
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
  resetKeyTips: vi.fn(),
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
    ["tips.reset", undefined],
    ["sidebar.toggle", "mod+b"],
    ["panel.toggle", "mod+shift+r"],
    ["filetree.toggle", "mod+\\"],
    ["pane.files", "mod+shift+e"],
    ["pane.changes", "mod+shift+g"],
    ["terminal.toggle", "ctrl+`"],
    ["signal.toggle", "mod+alt+s"],
    ["terminal.new", "ctrl+shift+`"],
    ["layout.reset", undefined],
    ["panel.flip", undefined],
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
  expect(appCommands(ctx({ session: { ...ctx().session!, draft: true }, panels: false })).find((i) => i.id === "filetree.toggle")).toBeUndefined();
});

it("AC5: panel and terminal commands follow c.panels (draft with panels lists them; viewer.changes still not on the draft)", () => {
  const ids = (c: CommandContext) => appCommands(c).map((i) => i.id);
  const draft = { ...ctx().session!, draft: true };
  const panelIds = ["panel.toggle", "filetree.toggle", "pane.files", "pane.changes", "terminal.toggle", "terminal.new", "panel.flip"];
  expect(ids(ctx({ session: draft, panels: true, viewChanges: vi.fn(), isGit: true }))).toEqual(expect.arrayContaining([...panelIds, "pane.graph"]));
  expect(ids(ctx({ session: draft, panels: true, viewChanges: vi.fn() }))).not.toContain("viewer.changes");
  for (const id of panelIds) expect(ids(ctx({ session: draft, panels: false })), id).not.toContain(id);
  expect(ids(ctx({ panels: true, viewChanges: vi.fn() }))).toContain("viewer.changes");
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
  const items = appCommands(ctx({ session: undefined, panels: false, canQuickOpen: false, tabs: ["new"], activeId: "new", sessions: [] }));
  expect(items.map((i) => i.id)).toEqual(["session.new", "tab.close", "tab.goto1", "tab.gotoLast", "shortcuts.open", "settings.open", "guide.start", "tips.reset", "sidebar.toggle", "signal.toggle", "layout.reset"]);
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

it("lists Background shells while a session shows", () => {
  expect(appCommands(ctx()).find((i) => i.id === "shells.open")).toBeUndefined();
  const openShells = vi.fn();
  const item = run(ctx({ openShells }), "shells.open");
  expect(item).toMatchObject({ title: "Background shells" });
  expect(openShells).toHaveBeenCalled();
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

it("'Clean up worktrees and workers…' is listed only with cleanUp", () => {
  const cleanUp = vi.fn();
  expect(appCommands(ctx({ cleanUp })).find((i) => i.id === "cleanup.open")).toMatchObject({ title: "Clean up worktrees and workers…", group: "Commands" });
  run(ctx({ cleanUp }), "cleanup.open");
  expect(cleanUp).toHaveBeenCalled();
  expect(appCommands(ctx()).some((i) => i.id === "cleanup.open")).toBe(false);
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

it("Toggle keep screen awake is listed only where App offers it, and runs it", () => {
  const toggleKeepAwake = vi.fn();
  expect(appCommands(ctx()).some((i) => i.id === "awake.toggle")).toBe(false);
  run(ctx({ toggleKeepAwake }), "awake.toggle");
  expect(toggleKeepAwake).toHaveBeenCalledOnce();
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

it("Go to notifications is listed only while a card shows, on Ctrl+Alt+N (GH-158)", () => {
  const focusNotifications = vi.fn();
  expect(appCommands(ctx()).some((i) => i.id === "notifications.focus")).toBe(false);
  const c = ctx({ focusNotifications });
  expect(appCommands(c).find((i) => i.id === "notifications.focus")?.title).toBe("Go to notifications");
  run(c, "notifications.focus");
  expect(focusNotifications).toHaveBeenCalledOnce();
  expect(shortcutFor(appCommands(c), ev("n", { ctrlKey: true, altKey: true }))?.id).toBe("notifications.focus");
  expect(shortcutFor(appCommands(ctx()), ev("n", { ctrlKey: true, altKey: true }))).toBeUndefined();
  // Never Escape: Esc stops the running turn.
  expect(KEYS["notifications.focus"]).not.toMatch(/escape/);
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

it("tab.closeGroup is listed only when the active tab is in a named group, with mod+alt+shift+w", () => {
  expect(appCommands(ctx()).some((i) => i.id === "tab.closeGroup")).toBe(false);
  const closeGroup = vi.fn();
  const items = appCommands(ctx({ closeGroup }));
  const i = items.find((x) => x.id === "tab.closeGroup")!;
  expect([i.title, i.keys]).toEqual(["Close tab group", "mod+alt+shift+w"]);
  run(ctx({ closeGroup }), "tab.closeGroup");
  expect(closeGroup).toHaveBeenCalled();
});

it("Reset shortcut tips runs resetKeyTips", () => {
  const c = ctx();
  const row = run(c, "tips.reset");
  expect(row.title).toBe("Reset shortcut tips");
  expect(row.keys).toBeUndefined();
  expect(c.resetKeyTips).toHaveBeenCalledOnce();
});

it("MCP servers, Slash commands and Manage plugins carry the user's binding", () => {
  try {
    bind("mcp.open", "mod+alt+m");
    const items = appCommands(ctx({ openMcp: vi.fn(), openSkills: vi.fn(), openPlugins: vi.fn() }));
    expect(items.find((i) => i.id === "mcp.open")?.keys).toBe("mod+alt+m");
    expect(items.find((i) => i.id === "skills.open")?.keys).toBeUndefined();
    const e = new KeyboardEvent("keydown", { key: "m", ctrlKey: true, altKey: true });
    expect(shortcutFor(items, e)?.id).toBe("mcp.open");
  } finally {
    resetAll();
  }
});

it("viewer commands show only with their callbacks and a session", () => {
  const viewChanges = vi.fn();
  const viewPlan = vi.fn();
  const c = ctx({ viewChanges, viewPlan });
  expect(appCommands(c).find((x) => x.id === "viewer.changes")).toMatchObject({ title: "View changes in popup", keys: undefined });
  expect(appCommands(c).find((x) => x.id === "viewer.plan")).toMatchObject({ title: "View plan", keys: undefined });
  run(c, "viewer.changes");
  run(c, "viewer.plan");
  expect(viewChanges).toHaveBeenCalledOnce();
  expect(viewPlan).toHaveBeenCalledOnce();
  const ids = (x: CommandContext) => appCommands(x).map((i) => i.id);
  expect(ids(ctx())).not.toContain("viewer.changes");
  expect(ids(ctx({ viewChanges, viewPlan, session: { ...ctx().session!, draft: true } }))).not.toContain("viewer.plan");
});

it("Reset layout is always listed; the side flip names the other side and needs a session", () => {
  const title = (c: CommandContext, id: string) => appCommands(c).find((x) => x.id === id)?.title;
  expect(title(ctx({ session: undefined, activeId: undefined, tabs: [] }), "layout.reset")).toBe("Reset layout");
  expect(title(ctx(), "panel.flip")).toBe("Move side panel to left");
  expect(title(ctx({ side: "left" }), "panel.flip")).toBe("Move side panel to right");
  expect(title(ctx({ session: undefined, panels: false, activeId: undefined, tabs: [] }), "panel.flip")).toBeUndefined();
});

it("GH-359 tab.closeOthers / closeRight / closeAll are listed only when given, have no default key, run their handler and take a user binding", () => {
  const ids = ["tab.closeOthers", "tab.closeRight", "tab.closeAll"];
  expect(appCommands(ctx()).some((i) => ids.includes(i.id))).toBe(false);
  const over = { closeOthers: vi.fn(), closeRight: vi.fn(), closeAll: vi.fn() };
  const items = appCommands(ctx(over));
  expect(ids.map((id) => items.find((i) => i.id === id)?.title)).toEqual(["Close other tabs", "Close tabs to the right", "Close all tabs"]);
  expect(ids.map((id) => items.find((i) => i.id === id)?.keys)).toEqual([undefined, undefined, undefined]);
  ids.forEach((id) => run(ctx(over), id));
  expect(Object.values(over).map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  bind("tab.closeOthers", "mod+alt+o");
  expect(shortcutFor(appCommands(ctx(over)), ev("o", { ctrlKey: true, altKey: true, code: "KeyO" }))?.id).toBe("tab.closeOthers");
  resetAll();
});

it("GH-359 tab.pin is listed only for a session tab, reads Pin or Unpin tab, has no default key and runs its handler", () => {
  expect(appCommands(ctx()).some((i) => i.id === "tab.pin")).toBe(false);
  const togglePin = vi.fn();
  const pin = appCommands(ctx({ togglePin })).find((i) => i.id === "tab.pin")!;
  expect([pin.title, pin.keys]).toEqual(["Pin tab", undefined]);
  expect(appCommands(ctx({ togglePin, pinned: true })).find((i) => i.id === "tab.pin")!.title).toBe("Unpin tab");
  run(ctx({ togglePin }), "tab.pin");
  expect(togglePin).toHaveBeenCalled();
});

const menu = (counts: Partial<Record<CleanupRule, number>>, kept = ""): CleanupMenu => ({ items: CLEANUP_RULES.map((rule) => ({ rule, label: RULE_LABEL[rule], count: counts[rule] ?? 0 })), kept: { count: kept ? 1 : 0, text: kept } });

it("GH-378 Clean up tabs… is a page of the rules with a count > 0, meta 'N tabs', each runs cleanUp(rule)", () => {
  const cleanUp = vi.fn();
  const entry = appCommands(ctx({ tabCleanup: menu({ idle: 3, workers: 1 }, "2 kept: running/draft"), cleanUpTabs: cleanUp })).find((i) => i.id === "tab.cleanup")!;
  if (!("page" in entry)) throw new Error("not a page");
  const page = entry;
  expect([page.title, page.keys]).toEqual(["Clean up tabs…", undefined]);
  expect(page.page.items.filter((i) => !i.disabled).map((i) => [i.title, i.meta, i.group])).toEqual([
    ["Close idle tabs", "3 tabs", "2 kept: running/draft"],
    ["Close worker tabs", "1 tab", "2 kept: running/draft"],
  ]);
  const last = page.page.items.find((i) => i.id === "cleanup:workers")!;
  if ("run" in last) last.run();
  expect(cleanUp).toHaveBeenCalledWith("workers");
  const direct = appCommands(ctx({ tabCleanup: menu({ idle: 3 }), cleanUpTabs: cleanUp })).find((i) => i.id === "tab.cleanup.idle")!;
  expect(direct.searchOnly).toBe(true);
  if ("run" in direct) direct.run();
  expect(cleanUp).toHaveBeenCalledWith("idle");
});

it("GH-378 Clean up tabs… lists every rule, those with count 0 disabled; absent without the callbacks", () => {
  const entry = appCommands(ctx({ tabCleanup: menu({ idle: 1 }), cleanUpTabs: vi.fn() })).find((i) => i.id === "tab.cleanup")!;
  if (!("page" in entry)) throw new Error("not a page");
  expect(entry.page.items.map((i) => [i.title, i.disabled])).toEqual(CLEANUP_RULES.map((r) => [RULE_LABEL[r], r !== "idle"]));
  const has = (x: CommandContext) => appCommands(x).some((i) => i.id.startsWith("tab.cleanup"));
  expect(has(ctx({ tabCleanup: menu({}), cleanUpTabs: vi.fn() }))).toBe(true);
  expect(has(ctx({ tabCleanup: menu({ idle: 1 }) }))).toBe(false);
  expect(has(ctx())).toBe(false);
});

it("GH-378 tab.cleanup and tab.cleanup.<rule> have no default key and take a user binding", () => {
  const over = { tabCleanup: menu({ idle: 2 }), cleanUpTabs: vi.fn() };
  const items = appCommands(ctx(over));
  expect(["tab.cleanup", "tab.cleanup.idle"].map((id) => items.find((i) => i.id === id)?.keys)).toEqual([undefined, undefined]);
  bind("tab.cleanup.idle", "mod+alt+i");
  expect(shortcutFor(appCommands(ctx(over)), ev("i", { ctrlKey: true, altKey: true, code: "KeyI" }))?.id).toBe("tab.cleanup.idle");
  resetAll();
});

it("GH-356 split commands are listed only when given, run their handler; Focus next split shows its default key and the others have none", () => {
  const ids = ["split.right", "split.down", "split.next", "split.prev", "split.join"];
  expect(appCommands(ctx()).some((i) => ids.includes(i.id))).toBe(false);
  const over = { splitRight: vi.fn(), splitDown: vi.fn(), splitNext: vi.fn(), splitPrev: vi.fn(), joinSplits: vi.fn() };
  const items = appCommands(ctx(over));
  expect(ids.map((id) => items.find((i) => i.id === id)?.title)).toEqual(["Split right", "Split down", "Focus next split", "Focus previous split", "Join splits"]);
  expect(ids.map((id) => items.find((i) => i.id === id)?.keys)).toEqual([undefined, undefined, "mod+alt+arrowup", undefined, undefined]);
  ids.forEach((id) => run(ctx(over), id));
  expect(Object.values(over).map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1, 1]);
});

it("GH-395 Show plan is listed only with showPlan; move commands list the two other homes", () => {
  const ids = (x: CommandContext) => appCommands(x).map((i) => i.id);
  expect(ids(ctx())).not.toContain("plan.show");
  expect(ids(ctx())).not.toContain("plan.move.main");
  const showPlan = vi.fn();
  const c = ctx({ showPlan, homes: { plan: "side" }, moveKind: vi.fn() });
  expect(appCommands(c).find((x) => x.id === "plan.show")).toMatchObject({ title: "Show plan", keys: undefined });
  run(c, "plan.show");
  expect(showPlan).toHaveBeenCalledOnce();
  expect(ids(c).filter((i) => i.startsWith("plan.move"))).toEqual(["plan.move.main", "plan.move.bottom"]);
  expect(appCommands(c).find((x) => x.id === "plan.move.main")).toMatchObject({ title: "Move plan to main area" });
  run(c, "plan.move.bottom");
  expect(c.moveKind).toHaveBeenCalledWith("plan", "bottom");
  expect(ids(ctx({ homes: { plan: "main" }, moveKind: vi.fn() })).filter((i) => i.startsWith("plan.move"))).toEqual(["plan.move.side", "plan.move.bottom"]);
});

it("GH-396 move rows per kind list the two other homes: files, graph (git only) and plan; none for changes", () => {
  const ids = (x: CommandContext) => appCommands(x).map((i) => i.id).filter((i) => i.includes(".move."));
  const homes = { plan: "side", files: "side", graph: "main" } as const;
  const c = ctx({ homes, moveKind: vi.fn(), isGit: true });
  expect(ids(c)).toEqual(["plan.move.main", "plan.move.bottom", "files.move.main", "files.move.bottom", "graph.move.side", "graph.move.bottom"]);
  expect(appCommands(c).find((x) => x.id === "files.move.main")).toMatchObject({ title: "Move files to main area" });
  expect(appCommands(c).find((x) => x.id === "graph.move.side")).toMatchObject({ title: "Move git graph to side panel" });
  run(c, "files.move.main");
  expect(c.moveKind).toHaveBeenCalledWith("files", "main");
  expect(ids(c).some((i) => i.startsWith("changes."))).toBe(false);
  expect(ids(ctx({ homes, moveKind: vi.fn() })).some((i) => i.startsWith("graph."))).toBe(false);
});

it("Ask aside is a command only while a session tab is shown, and puts /btw in its prompt", () => {
  const askAside = vi.fn();
  expect(appCommands(ctx()).some((i) => i.id === "aside.ask")).toBe(false);
  run(ctx({ askAside }), "aside.ask");
  expect(askAside).toHaveBeenCalledOnce();
  expect(appCommands(ctx({ askAside })).find((i) => i.id === "aside.ask")).toMatchObject({ title: "Ask aside", keys: undefined });
});

it("palette moves the terminal between its homes (GH-397)", () => {
  const ids = (x: CommandContext) => appCommands(x).map((i) => i.id).filter((i) => i.startsWith("terminal.move"));
  expect(ids(ctx({ homes: { terminal: "bottom" }, moveKind: vi.fn() }))).toEqual(["terminal.move.main", "terminal.move.side"]);
  expect(ids(ctx({ homes: { terminal: "main" }, moveKind: vi.fn() }))).toEqual(["terminal.move.side", "terminal.move.bottom"]);
});

it("Run in background is listed only while a foreground shell runs, with Ctrl+Shift+B", () => {
  expect(appCommands(ctx()).find((i) => i.id === "shell.background")).toBeUndefined();
  const run = vi.fn();
  const item = appCommands(ctx({ runInBackground: run })).find((i) => i.id === "shell.background");
  expect(item).toMatchObject({ title: "Run in background", keys: "mod+shift+b" });
  if (item && "run" in item) item.run();
  expect(run).toHaveBeenCalled();
});

it("GH-399 Open in tab is listed only while a Files editor shows a file inside the folder", () => {
  expect(appCommands(ctx()).map((i) => i.id)).not.toContain("file.openInTab");
  const openFileTab = vi.fn();
  const c = ctx({ openFileTab });
  expect(appCommands(c).find((x) => x.id === "file.openInTab")).toMatchObject({ title: "Open in tab", keys: undefined });
  run(c, "file.openInTab");
  expect(openFileTab).toHaveBeenCalledOnce();
});

it("GH-401 Move session to side / bottom panel are listed only with dockSession, have no default key and run it with the area", () => {
  const ids = ["session.dock.side", "session.dock.bottom"];
  expect(appCommands(ctx()).some((i) => ids.includes(i.id))).toBe(false);
  const dockSession = vi.fn();
  const items = appCommands(ctx({ dockSession }));
  expect(ids.map((id) => items.find((i) => i.id === id)?.title)).toEqual(["Move session to side panel", "Move session to bottom panel"]);
  expect(ids.map((id) => items.find((i) => i.id === id)?.keys)).toEqual([undefined, undefined]);
  ids.forEach((id) => run(ctx({ dockSession }), id));
  expect(dockSession.mock.calls).toEqual([["side"], ["bottom"]]);
});
