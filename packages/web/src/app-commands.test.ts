// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";
import { appCommands, shortcutFor, type CommandContext } from "./app-commands.ts";

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
  focusPrompt: vi.fn(),
  setModel: vi.fn(),
  setEffort: vi.fn(),
  setMode: vi.fn(),
  rewind: vi.fn(),
  stop: vi.fn(),
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
    ["sidebar.toggle", "mod+b"],
    ["panel.toggle", "mod+shift+r"],
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
  expect(items.map((i) => i.id)).toEqual(["session.new", "tab.close", "sidebar.toggle"]);
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
