// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DockerState, Settings, SideInfo } from "@claude-ui/protocol";
import type { Request } from "./client.ts";
import { SettingsDialog } from "./settings-dialog.tsx";
import { loadSignalOnly, saveSignalOnly } from "./signal.ts";
import { loadKeepAwake, saveKeepAwake } from "./keep-awake.ts";
import { bind, resetAll } from "./keymap.ts";
import type { TabGrouping } from "./tab-grouping.ts";
import { loadSidebarView, saveSidebarView } from "./sessions.ts";
import { WEB_VERSION } from "./version.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

async function render({ sides, docker, failGet = false, tokenReset = false, group, daemon = { host: "box" } as { host: string; version?: string; desktopForcedOff?: true } | null, push = { on: false, supported: true, busy: false, error: undefined as string | undefined } }: { sides?: SideInfo[]; docker?: DockerState; failGet?: boolean; tokenReset?: boolean; group?: string; daemon?: { host: string; version?: string; desktopForcedOff?: true } | null; push?: { on: boolean; supported: boolean; busy: boolean; error: string | undefined } } = {}) {
  const toggle = vi.fn();
  localStorage.removeItem("claude-ui.settingsGroup");
  if (group) localStorage.setItem("claude-ui.settingsGroup", group);
  const onTabGrouping = vi.fn();
  const onRestartGuide = vi.fn();
  const onTabCompact = vi.fn();
  const onTabAutoClose = vi.fn();
  const onShortcuts = vi.fn();
  let settings: Settings = { orchestration: { enabled: false, workerCap: 4, workerCapTotal: 0, maxDepth: 2, maxChildren: 4, coordinatorPermissions: true, workerMode: "coordinator", workerNotifications: true }, usageLimit: { autoContinue: false }, focus: { nextForYou: false }, notifications: { desktop: true }, performance: { monitor: true }, jira: { url: "", email: "", template: "{type}/{key}-{summary}", jql: "" }, git: { autoRepositoryDetection: true, repositoryScanMaxDepth: 1, repositoryScanIgnoredFolders: ["node_modules"], scanRepositories: [], ignoredRepositories: [], detectSubmodules: true, detectSubmodulesLimit: 10, ignoreSubmodules: false, openRepositoryInParentFolders: "always" } };
  let refuse: string | undefined;
  const calls: Request[] = [];
  let jiraToken = false;
  let jiraTokenReset = tokenReset;
  const request = vi.fn(async (msg: Request) => {
    calls.push(msg);
    if (failGet && msg.type === "settings.get") throw new Error("daemon unreachable");
    if (msg.type === "settings.set") {
      if (refuse) throw new Error(refuse);
      const v = (msg.patch.orchestration ?? {}) as Record<string, unknown>;
      if (typeof v.workerCap === "number" && (v.workerCap < 1 || v.workerCap > 20 || !Number.isInteger(v.workerCap))) throw new Error("Maximum workers per tree must be a whole number from 1 to 20");
      settings = { orchestration: { ...settings.orchestration, ...v }, usageLimit: { ...settings.usageLimit, ...((msg.patch.usageLimit ?? {}) as object) }, focus: { ...settings.focus, ...((msg.patch.focus ?? {}) as object) }, notifications: { ...settings.notifications, ...((msg.patch.notifications ?? {}) as object) }, performance: { ...settings.performance, ...((msg.patch.performance ?? {}) as object) }, jira: { ...settings.jira, ...((msg.patch.jira ?? {}) as object) }, git: { ...settings.git, ...((msg.patch.git ?? {}) as object) } };
    }
    if (msg.type === "perf.report") return { daemon: { pid: 1, since: 0, monitor: settings.performance.monitor, eld: { resolutionMs: 50 }, elu: 0, handlers: {}, spans: {}, children: {}, memory: [], worst: [], cost: { ownMs: 0, wallMs: 0 } } };
    if (msg.type === "jira.token") (jiraToken = msg.token !== null), (jiraTokenReset = false);
    if (msg.type === "jira.test") return { user: "Ann Example" };
    return { settings, ...(daemon && { daemon }), jiraToken, ...(jiraTokenReset && { jiraTokenReset: true }) };
  });
  const el = document.createElement("div");
  const prompt = document.createElement("textarea");
  prompt.setAttribute("aria-label", "Prompt");
  Object.defineProperty(prompt, "offsetParent", { get: () => document.body });
  document.body.append(el, prompt);
  let bump = () => {};
  function Host() {
    const [open, set] = useState(true);
    const [changed, setChanged] = useState(0);
    bump = () => setChanged((n) => n + 1);
    const [grouping, setGrouping] = useState<TabGrouping>("project");
    const [compact, setCompact] = useState(false);
    const [auto, setAuto] = useState<"off" | "1h" | "1d">("off");
    return (
      <SettingsDialog
        open={open}
        changed={changed}
        sides={sides}
        docker={docker}
        onShortcuts={onShortcuts}
        push={{ ...push, toggle }}
        request={request as never}
        onClose={() => set(false)}
        tabCompact={compact}
        onTabCompact={(on) => {
          onTabCompact(on);
          setCompact(on);
        }}
        tabAutoClose={auto}
        onTabAutoClose={(v) => {
          onTabAutoClose(v);
          setAuto(v);
        }}
        tabGrouping={grouping}
        onRestartGuide={onRestartGuide}
        onTabGrouping={(g) => {
          onTabGrouping(g);
          setGrouping(g);
        }}
      />
    );
  }
  root = createRoot(el);
  await act(async () => root!.render(<Host />));
  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const pick = async (group: string) => void (await act(async () => q(`settings-group-${group}`)!.click()));
  return { bump: () => act(async () => bump()), refuse: (m: string) => void (refuse = m), calls, toggle, q, pick, prompt, onTabGrouping, onTabCompact, onTabAutoClose, onShortcuts, onRestartGuide };
}

it("shows the Orchestration section with labelled controls, loaded from the daemon", async () => {
  const { q, pick } = await render();
  await pick("orchestration");
  expect(q("settings-dialog")?.textContent).toContain("Orchestration");
  expect(q("settings-orchestration-enabled")?.getAttribute("aria-checked")).toBe("false");
  expect(q("settings-orchestration-coordinatorPermissions")?.getAttribute("aria-checked")).toBe("true");
  expect((q("settings-orchestration-workerCap") as HTMLInputElement).value).toBe("4");
  expect(document.querySelector('label[for="settings-orchestration-workerCap"]')?.textContent).toBe("Maximum workers per tree");
  // Short accessible name; the hint is the description.
  const desc = (id: string) => document.getElementById(q(id)!.getAttribute("aria-describedby")!)?.textContent;
  expect(q("settings-orchestration-enabled")?.getAttribute("aria-label")).toBe("Enable orchestration");
  expect(desc("settings-orchestration-enabled")).toContain("start and supervise worker sessions");
  expect(desc("settings-orchestration-workerCap")).toContain("root coordinator's tree");
  expect(desc("settings-orchestration-coordinatorPermissions")).toContain("read-only git commands (status, log, diff, show). Other commands and everything else wait for you");
  expect(q("settings-orchestration-workerNotifications")?.getAttribute("aria-label")).toBe("Notifications from workers");
  expect(q("settings-orchestration-workerNotifications")?.getAttribute("aria-checked")).toBe("true");
  expect(desc("settings-orchestration-workerNotifications")).toContain("a request the coordinator escalates to you still notifies");
  expect(desc("settings-orchestration-coordinatorPermissions")).toContain("Edits can change code that commands you approve later will run.");
});

it("Notifications from workers is on by default and its switch sends a patch of that field (GH-387)", async () => {
  const { q, calls, pick } = await render();
  await pick("orchestration");
  await act(async () => q("settings-orchestration-workerNotifications")!.click());
  expect(calls.at(-1)).toEqual({ type: "settings.set", patch: { orchestration: { workerNotifications: false } } });
  expect(q("settings-orchestration-workerNotifications")?.getAttribute("aria-checked")).toBe("false");
});

it("a switch sends a patch of its field only", async () => {
  const { q, calls, pick } = await render();
  await pick("orchestration");
  await act(async () => q("settings-orchestration-enabled")!.click());
  expect(calls.at(-1)).toEqual({ type: "settings.set", patch: { orchestration: { enabled: true } } });
  expect(q("settings-orchestration-enabled")?.getAttribute("aria-checked")).toBe("true");
});

it("Orchestration shows Maximum tree depth and Maximum workers per coordinator and saves them", async () => {
  const { q, calls, pick } = await render();
  await pick("orchestration");
  expect((q("settings-orchestration-maxDepth") as HTMLInputElement).value).toBe("2");
  expect((q("settings-orchestration-maxChildren") as HTMLInputElement).value).toBe("4");
  expect(document.querySelector('label[for="settings-orchestration-maxDepth"]')?.textContent).toBe("Maximum tree depth");
  expect(document.querySelector('label[for="settings-orchestration-maxChildren"]')?.textContent).toBe("Maximum workers per coordinator");
  const input = q("settings-orchestration-maxDepth") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "3");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(calls.at(-1)).toEqual({ type: "settings.set", patch: { orchestration: { maxDepth: 3 } } });
});

it("two number fields edited before the refetch of the first save both keep their edit (GH-498)", async () => {
  const { q, calls, pick, bump } = await render();
  await pick("orchestration");
  const type = async (id: string, v: string) => {
    const input = q(id) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  };
  const first = await type("settings-orchestration-maxDepth", "3");
  const second = await type("settings-orchestration-maxChildren", "5");
  await act(async () => first.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await bump(); // settings_changed of the first save arrives: the dialog refetches
  expect((q("settings-orchestration-maxChildren") as HTMLInputElement).value).toBe("5");
  await act(async () => second.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(calls.filter((c) => c.type === "settings.set").map((c) => (c as { patch: unknown }).patch)).toEqual([{ orchestration: { maxDepth: 3 } }, { orchestration: { maxChildren: 5 } }]);
});

it("Enter in a field commits it without a keypress that can activate the Back button the focus falls to on a phone (GH-500)", async () => {
  const { q, pick } = await render();
  await pick("jira");
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(async () => void q("settings-jira-url")!.dispatchEvent(enter));
  expect(enter.defaultPrevented).toBe(true);
  await pick("orchestration");
  const enter2 = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(async () => void q("settings-orchestration-maxDepth")!.dispatchEvent(enter2));
  expect(enter2.defaultPrevented).toBe(true);
  expect(q("settings-panel")!.className).not.toContain("max-md:hidden");
});

it("Maximum workers in total shows 0 = no limit and saves a patch of its field", async () => {
  const { q, calls, pick } = await render();
  await pick("orchestration");
  expect((q("settings-orchestration-workerCapTotal") as HTMLInputElement).value).toBe("0");
  expect(document.querySelector('label[for="settings-orchestration-workerCapTotal"]')?.textContent).toBe("Maximum workers in total");
  expect(document.getElementById(q("settings-orchestration-workerCapTotal")!.getAttribute("aria-describedby")!)?.textContent).toContain("0 = no limit");
  const input = q("settings-orchestration-workerCapTotal") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "6");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(calls.at(-1)).toEqual({ type: "settings.set", patch: { orchestration: { workerCapTotal: 6 } } });
});

it("an out-of-range cap shows the daemon's error in a Banner", async () => {
  const { q, pick } = await render();
  await pick("orchestration");
  const input = q("settings-orchestration-workerCap") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "25");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(q("banner-error")?.textContent).toContain("Maximum workers per tree must be a whole number");
});

it("Compact tabs is a switch that applies at once, and is disabled with a hint while grouping is None", async () => {
  const { q, calls, onTabCompact, pick } = await render();
  await pick("layout");
  const sw = q("settings-tabs-compact")!;
  expect(sw.getAttribute("role")).toBe("switch");
  expect(sw.getAttribute("aria-checked")).toBe("false");
  expect(document.getElementById("settings-tabs-compact-hint")?.textContent).toContain("Show each group as one chip");
  await act(async () => sw.click());
  expect(onTabCompact).toHaveBeenCalledWith(true);
  expect(q("settings-tabs-compact")!.getAttribute("aria-checked")).toBe("true");
  await act(async () => q("settings-tabs-grouping")!.click());
  await act(async () => document.querySelectorAll<HTMLElement>("[role=option]")[2]!.click());
  expect(q("settings-tabs-compact")!.getAttribute("aria-disabled")).toBe("true");
  expect(document.getElementById("settings-tabs-compact-hint")?.textContent).toBe("Needs a tab grouping");
  onTabCompact.mockClear();
  await act(async () => q("settings-tabs-compact")!.click());
  expect(onTabCompact).not.toHaveBeenCalled();
  expect(calls.some((c) => c.type === "settings.set")).toBe(false);
});

it("Tab grouping shows By project by default and picking By worktree applies at once without a daemon request", async () => {
  const { q, calls, onTabGrouping, pick } = await render();
  await pick("layout");
  expect(q("settings-tabs-grouping")?.textContent).toContain("By project");
  await act(async () => q("settings-tabs-grouping")!.click());
  expect([...document.querySelectorAll("[role=option]")].map((o) => o.textContent)).toEqual(["By project", "By worktree", "None"]);
  await act(async () => document.querySelectorAll<HTMLElement>("[role=option]")[1]!.click());
  expect(onTabGrouping).toHaveBeenCalledWith("worktree");
  expect(q("settings-tabs-grouping")?.textContent).toContain("By worktree");
  expect(calls.some((c) => c.type === "settings.set")).toBe(false);
});

it("Worker mode shows the daemon's value and picking Auto sends a patch of that field only", async () => {
  const { q, calls, pick } = await render();
  await pick("orchestration");
  expect(q("settings-orchestration-workerMode")?.textContent).toContain("Coordinator's mode");
  expect(document.getElementById(q("settings-orchestration-workerMode")!.getAttribute("aria-describedby")!)?.textContent).toContain("still asks you on the worker_start card");
  await act(async () => q("settings-orchestration-workerMode")!.click());
  expect([...document.querySelectorAll("[role=option]")].map((o) => o.textContent)).toEqual(["Coordinator's mode", "Default", "Accept edits", "Plan", "Auto"]);
  await act(async () => document.querySelectorAll<HTMLElement>("[role=option]")[4]!.click());
  expect(calls.at(-1)).toEqual({ type: "settings.set", patch: { orchestration: { workerMode: "auto" } } });
  expect(q("settings-orchestration-workerMode")?.textContent).toContain("Auto");
});

it("the Tabs section shows while daemon settings load or fail", async () => {
  const { q, pick } = await render({ failGet: true });
  expect(q("banner-error")?.textContent).toContain("daemon unreachable");
  await pick("layout");
  expect(q("settings-tabs")).not.toBeNull();
});

it("Esc closes the dialog and the focus returns to the prompt box", async () => {
  const { q, prompt } = await render();
  await act(async () => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => void new Promise((r) => setTimeout(r, 50)));
  expect(q("settings-dialog")).toBeNull();
  expect(document.activeElement).toBe(prompt);
});

it("shows Focus: the Next for you switch is off by default and sends its patch only (GH-305)", async () => {
  const { q, calls, pick } = await render();
  await pick("focus");
  expect(q("settings-focus")?.textContent).toContain("Next for you");
  expect(q("settings-focus")?.textContent).toContain("nearly free, not free");
  expect(q("settings-focus-nextForYou")?.getAttribute("aria-checked")).toBe("false");
  await act(async () => q("settings-focus-nextForYou")!.click());
  expect(calls.at(-1)).toEqual({ type: "settings.set", patch: { focus: { nextForYou: true } } });
  expect(q("settings-focus-nextForYou")?.getAttribute("aria-checked")).toBe("true");
});

it("shows Usage limits: the continue switch is off by default and sends its patch only", async () => {
  const { q, calls, pick } = await render();
  await pick("usageLimit");
  expect(q("settings-usageLimit")?.textContent).toContain("Continue automatically after a usage limit resets");
  expect(q("settings-usageLimit")?.textContent).toContain("A daemon restart drops scheduled continues");
  expect(q("settings-usageLimit-autoContinue")?.getAttribute("aria-checked")).toBe("false");
  await act(async () => q("settings-usageLimit-autoContinue")!.click());
  expect(calls.at(-1)).toEqual({ type: "settings.set", patch: { usageLimit: { autoContinue: true } } });
  expect(q("settings-usageLimit-autoContinue")?.getAttribute("aria-checked")).toBe("true");
});

it("Default diff view is a per-browser choice: picking Uncommitted saves it and sends no settings.set", async () => {
  localStorage.removeItem("claude-ui.diffMode");
  const { q, calls, pick } = await render();
  await pick("layout");
  expect(q("settings-diff-mode")?.textContent).toContain("Session changes");
  await act(async () => q("settings-diff-mode")!.click());
  await act(async () => document.querySelector<HTMLElement>("[data-testid=settings-diff-mode-uncommitted]")!.click());
  expect(localStorage.getItem("claude-ui.diffMode")).toBe("uncommitted");
  expect(q("settings-diff-mode")?.textContent).toContain("Uncommitted");
  expect(calls.some((c) => c.type === "settings.set")).toBe(false);
  localStorage.removeItem("claude-ui.diffMode");
});

it("Terminal position hint names the narrow Terminal tab of the Main area", async () => {
  const { q, pick } = await render();
  await pick("layout");
  expect(q("settings-terminal")!.querySelector("#settings-terminal-position-hint")!.textContent).toContain("with Main area, as the session's Terminal tab");
});

it("Terminal position: Bottom by default, Side panel saved per browser", async () => {
  localStorage.removeItem("claude-ui.layout");
  const { q, pick } = await render();
  await pick("layout");
  expect(q("settings-terminal-position")?.textContent).toContain("Bottom");
  await act(async () => q("settings-terminal-position")!.click());
  await act(async () => document.querySelector<HTMLElement>("[data-testid=settings-terminal-position-side]")!.click());
  expect(JSON.parse(localStorage.getItem("claude-ui.layout")!).areas.side).toContain("terminal");
  expect(q("settings-terminal-position")?.textContent).toContain("Side panel");
  localStorage.removeItem("claude-ui.layout");
});

it("Terminal position offers Main area (GH-397)", async () => {
  localStorage.removeItem("claude-ui.layout");
  const { q, pick } = await render();
  await pick("layout");
  await act(async () => q("settings-terminal-position")!.click());
  await act(async () => document.querySelector<HTMLElement>("[data-testid=settings-terminal-position-main]")!.click());
  expect(JSON.parse(localStorage.getItem("claude-ui.layout")!).areas.main).toContain("terminal");
  expect(q("settings-terminal-position")?.textContent).toContain("Main area");
  localStorage.removeItem("claude-ui.layout");
});

it("Sidebar section: Show only active sessions is the sidebar's own per-browser setting, off by default (GH-159)", async () => {
  localStorage.clear();
  const { q, pick } = await render();
  await pick("layout");
  const sw = q("settings-sidebar-active-only")!;
  expect(q("settings-sidebar")!.textContent).toContain("Lists sessions that are running or need input. Search still finds every session, and the one you have open stays listed.");
  expect(sw.getAttribute("aria-checked")).toBe("false");
  await act(async () => sw.click());
  expect(sw.getAttribute("aria-checked")).toBe("true");
  expect(JSON.parse(localStorage.getItem("claude-ui.sidebarView")!).onlyActive).toBe(true);
  await act(async () => sw.click());
  expect(JSON.parse(localStorage.getItem("claude-ui.sidebarView")!).onlyActive).toBe(false);
});

it("Sidebar section: Group by is Worktree or Project, stored in the sidebarView object, applied at once and synced from the menu (GH-222, GH-333)", async () => {
  localStorage.clear();
  const { q, pick } = await render();
  await pick("layout");
  expect(document.getElementById("settings-sidebar-layout-label")!.textContent).toBe("Group by");
  expect(q("settings-sidebar-layout")!.textContent).toContain("Worktree");
  await act(async () => q("settings-sidebar-layout")!.click());
  await act(async () => document.querySelector<HTMLElement>("[data-testid=settings-sidebar-layout-classic]")!.click());
  expect(JSON.parse(localStorage.getItem("claude-ui.sidebarView")!).layout).toBe("classic");
  expect(q("settings-sidebar-layout")!.textContent).toContain("Project");
  await act(async () => saveSidebarView({ ...loadSidebarView(), layout: "default" }));
  expect(q("settings-sidebar-layout")!.textContent).toContain("Worktree");
  await act(async () => saveSidebarView({ ...loadSidebarView(), layout: "classic" }));
  expect(q("settings-sidebar-layout")!.textContent).toContain("Project");
  localStorage.clear();
});

it("shows a Guide section whose Restart guide button calls onRestartGuide", async () => {
  const { q, onRestartGuide, pick } = await render();
  await pick("about");
  expect(q("settings-guide")!.textContent).toContain("Guided tour");
  expect(document.getElementById("settings-guide-tour-hint")!.textContent).toMatch(/Kept in this browser\.$/);
  const button = q("settings-guide-restart") as HTMLButtonElement;
  expect(button.textContent).toBe("Restart guide");
  expect(button.getAttribute("aria-describedby")).toBe("settings-guide-tour-hint");
  await act(async () => button.click());
  expect(onRestartGuide).toHaveBeenCalledTimes(1);
});

it("lists the groups under category headings: App, Sessions, Integrations, System", async () => {
  const { q } = await render();
  const ids = [...document.querySelectorAll('[role=tab]')].map((t) => t.textContent);
  expect(ids).toEqual(["Appearance", "General", "Layout", "Notifications", "Keyboard", "Orchestration", "Focus", "Usage limits", "Git", "Jira", "Performance", "Help & about"]);
  expect(q("settings-groups")?.getAttribute("role")).toBe("tablist");
  const heads = [...q("settings-groups")!.querySelectorAll('[data-testid^="settings-category-"]')];
  expect(heads.map((h) => h.textContent)).toEqual(["App", "Sessions", "Integrations", "System"]);
  expect(heads.every((h) => h.getAttribute("aria-hidden") === "true")).toBe(true);
  // Each heading sits right before the first group of its category.
  expect(q("settings-category-sessions")!.nextElementSibling).toBe(q("settings-group-orchestration"));
});

it("General holds Timeline, Sending and Screen; Layout holds Sidebar, Tabs, Changes and Terminal; Help & about holds Guide and About", async () => {
  const { q, pick } = await render();
  const order = () => [...q("settings-panel")!.querySelectorAll(":scope > section")].map((s) => s.getAttribute("data-testid"));
  await pick("general");
  expect(order()).toEqual(["settings-timeline", "settings-sending", "settings-screen"]);
  await pick("layout");
  expect(order()).toEqual(["settings-sidebar", "settings-tabs", "settings-changes", "settings-terminal"]);
  await pick("about");
  expect(order()).toEqual(["settings-guide", "settings-about"]);
});

it("a remembered group id from before the merge opens the group that holds its section now", async () => {
  for (const [old, now] of [["timeline", "General"], ["sending", "General"], ["screen", "General"], ["sidebar", "Layout"], ["tabs", "Layout"], ["changes", "Layout"], ["terminal", "Layout"], ["guide", "Help & about"]]) {
    await render({ group: old });
    expect(document.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe(now);
    act(() => root?.unmount());
    document.body.innerHTML = "";
  }
});

it("lists Performance after Usage limits and before About: a switch sends its patch, and the results load from perf.report", async () => {
  const { q, pick, calls } = await render();
  await pick("performance");
  const sw = q("settings-performance-monitor")!;
  expect(sw.getAttribute("aria-checked")).toBe("true");
  expect(calls.some((c) => c.type === "perf.report")).toBe(true);
  expect(q("perf-section")).toBeTruthy();
  await act(async () => sw.click());
  expect(calls.find((c) => c.type === "settings.set")).toMatchObject({ patch: { performance: { monitor: false } } });
});

it("Jira (GH-447): URL, email for Cloud only, template; the token is write-only with Token set, Replace and Clear; Test connection names the user", async () => {
  const { q, pick, calls } = await render();
  await pick("jira");
  const set = async (id: string, v: string) => {
    const input = (q(id) as HTMLInputElement);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  };
  expect(q("settings-jira-email")).toBeNull();
  expect((q("settings-jira-test") as HTMLButtonElement).disabled).toBe(true);
  await set("settings-jira-url", "https://acme.atlassian.net");
  expect(calls.filter((c) => c.type === "settings.set").at(-1)).toEqual({ type: "settings.set", patch: { jira: { url: "https://acme.atlassian.net" } } });
  expect(q("settings-jira-email")).not.toBeNull();
  expect(q("settings-jira-url-error")).toBeNull();
  // GH-451: a stored non-local http address stays shown, with the reason at the field.
  await set("settings-jira-url", "http://jira.example.com");
  expect(q("settings-jira-url-error")!.textContent).toContain("https");
  await set("settings-jira-url", "https://acme.atlassian.net");
  expect(q("settings-jira-url-error")).toBeNull();
  await set("settings-jira-email", "ann@example.com");
  expect(calls.filter((c) => c.type === "settings.set").at(-1)).toMatchObject({ patch: { jira: { email: "ann@example.com" } } });
  expect((q("settings-jira-jql") as HTMLInputElement).placeholder).toBe("assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC");
  await set("settings-jira-jql", " project = ABC ");
  expect(calls.filter((c) => c.type === "settings.set").at(-1)).toEqual({ type: "settings.set", patch: { jira: { jql: "project = ABC" } } });
  const token = (q("settings-jira-token") as HTMLInputElement);
  expect(token.type).toBe("password");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(token, "tok-123");
    token.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => q("settings-jira-token-save")!.click());
  expect(calls.find((c) => c.type === "jira.token")).toEqual({ type: "jira.token", token: "tok-123" });
  expect(q("settings-jira-token-set")!.textContent).toBe("Token set");
  expect(q("settings-jira")!.textContent).not.toContain("tok-123");
  await act(async () => q("settings-jira-token-replace")!.click());
  expect(q("settings-jira-token")).not.toBeNull();
  await act(async () => q("settings-jira-token-cancel")!.click());
  await act(async () => q("settings-jira-test")!.click());
  expect(q("settings-jira-test-result")!.textContent).toBe("Connected as Ann Example");
  await act(async () => q("settings-jira-token-clear")!.click());
  expect(calls.filter((c) => c.type === "jira.token").at(-1)).toEqual({ type: "jira.token", token: null });
  expect(q("settings-jira-token-set")).toBeNull();
});

it("Jira: a token cleared by the security update says so under the token field until a token is saved (GH-487)", async () => {
  const { q, pick } = await render({ tokenReset: true });
  await pick("jira");
  expect(q("settings-jira-token-reset")!.textContent).toBe("Your saved token was cleared by a security update. Enter it again.");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(q("settings-jira-token"), "tok-123");
    q("settings-jira-token")!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => q("settings-jira-token-save")!.click());
  expect(q("settings-jira-token-reset")).toBeNull();
});

it("Jira: no notice when no token was cleared (GH-487)", async () => {
  const { q, pick } = await render();
  await pick("jira");
  expect(q("settings-jira-token-reset")).toBeNull();
});

it("the Keyboard section's Customize button opens the shortcuts dialog", async () => {
  const { q, onShortcuts, pick } = await render();
  await pick("keyboard");
  expect(q("settings-keyboard")?.textContent).toContain("Keyboard");
  await act(async () => q("settings-shortcuts")!.click());
  expect(onShortcuts).toHaveBeenCalledOnce();
});

it("Keyboard has a Show shortcut tips switch, on by default, kept in this browser", async () => {
  localStorage.removeItem("claude-ui.key-tips");
  const { q, pick } = await render();
  await pick("keyboard");
  expect(q("settings-key-tips")!.getAttribute("aria-checked")).toBe("true");
  await act(async () => q("settings-key-tips")!.click());
  expect(q("settings-key-tips")!.getAttribute("aria-checked")).toBe("false");
  expect(JSON.parse(localStorage.getItem("claude-ui.key-tips")!).off).toBe(true);
  localStorage.removeItem("claude-ui.key-tips");
});

it("shows one group at a time: the first by default, picking another swaps the panel and the choice is remembered per browser", async () => {
  const { q, pick } = await render();
  expect(document.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe("Appearance");
  expect(q("settings-appearance")).not.toBeNull();
  expect(q("settings-tabs")).toBeNull();
  expect(q("settings-panel")?.getAttribute("aria-labelledby")).toBe("settings-tab-appearance");
  await pick("layout");
  expect(q("settings-tabs")).not.toBeNull();
  expect(q("settings-appearance")).toBeNull();
  expect(localStorage.getItem("claude-ui.settingsGroup")).toBe("layout");
  act(() => root?.unmount());
  document.body.innerHTML = "";
  const again = await render({ group: "layout" });
  expect(again.q("settings-tabs")).not.toBeNull();
  expect(document.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe("Layout");
});

it("an unknown remembered group falls back to the first", async () => {
  const { q } = await render({ group: "nope" });
  expect(q("settings-appearance")).not.toBeNull();
});

it("arrow keys move through the groups (roving tabindex), Home and End jump, and the panel follows", async () => {
  const { q } = await render();
  const key = (k: string) => act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
  await act(async () => q("settings-group-appearance")!.focus());
  await key("ArrowDown");
  expect(document.activeElement).toBe(q("settings-group-general"));
  await key("ArrowDown");
  await key("ArrowDown");
  expect(document.activeElement).toBe(q("settings-group-notifications"));
  expect(q("settings-group-notifications")!.getAttribute("aria-selected")).toBe("true");
  expect(q("settings-group-appearance")!.getAttribute("tabindex")).toBe("-1");
  expect(q("settings-group-notifications")!.getAttribute("tabindex")).toBe("0");
  expect(q("settings-notifications")).not.toBeNull();
  await key("ArrowDown");
  await key("ArrowDown");
  // The category heading between Keyboard and Orchestration is skipped.
  expect(document.activeElement).toBe(q("settings-group-orchestration"));
  await key("End");
  expect(document.activeElement).toBe(q("settings-group-about"));
  await key("ArrowDown");
  expect(document.activeElement).toBe(q("settings-group-appearance"));
  await key("ArrowUp");
  expect(document.activeElement).toBe(q("settings-group-about"));
  await key("Home");
  expect(document.activeElement).toBe(q("settings-group-appearance"));
});

it("tapping a group moves the focus to the Back button of the drilled-in panel", async () => {
  const { q, pick } = await render();
  await pick("layout");
  await act(async () => void new Promise((r) => setTimeout(r, 50)));
  expect(document.activeElement).toBe(q("settings-back"));
});

it("the Back button shows on the drill-in panel and returns the focus to the group in the list", async () => {
  const { q, pick } = await render();
  await pick("layout");
  expect(q("settings-back")?.textContent).toBe("Settings");
  expect(q("settings-groups")!.className).toContain("max-md:hidden");
  expect(q("settings-panel")!.className).not.toContain("max-md:hidden");
  await act(async () => q("settings-back")!.click());
  await act(async () => void new Promise((r) => setTimeout(r, 50)));
  expect(q("settings-groups")!.className).not.toContain("max-md:hidden");
  expect(q("settings-panel")!.className).toContain("max-md:hidden");
  expect(document.activeElement).toBe(q("settings-group-layout"));
});

it("Signal only is a per-browser switch in the Timeline group, off by default, that saves at once and sends no settings.set (GH-205)", async () => {
  localStorage.clear();
  const { q, calls } = await render({ group: "timeline" });
  const sw = q("settings-signal-only")!;
  expect(sw.getAttribute("role")).toBe("switch");
  expect(sw.getAttribute("aria-checked")).toBe("false");
  expect(q("settings-timeline")!.textContent).toContain("Kept in this browser.");
  expect(document.getElementById(sw.getAttribute("aria-describedby")!)?.textContent).toContain("in every session");
  await act(async () => sw.click());
  expect(sw.getAttribute("aria-checked")).toBe("true");
  expect(loadSignalOnly()).toBe(true);
  expect(localStorage.getItem("claude-ui.signalOnly")).toBe("1");
  expect(calls.some((c) => c.type === "settings.set")).toBe(false);
  // The palette command and the shortcut write the same setting: the switch follows.
  await act(async () => saveSignalOnly(false));
  expect(q("settings-signal-only")!.getAttribute("aria-checked")).toBe("false");
});

it("the Signal only key hint is the live binding of signal.toggle and follows a rebinding", async () => {
  localStorage.clear();
  resetAll();
  const { q } = await render({ group: "timeline" });
  expect(q("settings-signal-keys")?.textContent).toMatch(/Alt\+S$/);
  await act(async () => bind("signal.toggle", "mod+alt+j"));
  expect(q("settings-signal-keys")?.textContent).toMatch(/Alt\+J$/);
  await act(async () => bind("signal.toggle", null));
  expect(q("settings-signal-keys")).toBeNull();
  await act(async () => resetAll());
});

it("Tab from the group list reaches the first visible control of the panel, not the hidden phone Back button (GH-214)", async () => {
  const { q } = await render({ group: "timeline" });
  // jsdom has no Tailwind: hide the Back button the way `md:hidden` does from md up.
  q("settings-back")!.style.display = "none";
  await act(async () => q("settings-group-general")!.focus());
  await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(q("settings-signal-only"));
});

it("Settings > Notifications is a group with In-app, Push and Desktop rows, in that order (GH-158)", async () => {
  const { q, pick } = await render();
  await pick("notifications");
  expect(q("settings-notifications")?.querySelector("h3")?.textContent).toBe("Notifications");
  const rows = [...q("settings-notifications")!.querySelectorAll('[role="switch"]')].map((b) => b.getAttribute("data-testid"));
  expect(rows).toEqual(["settings-in-app", "settings-push", "settings-notifications-desktop"]);
});

it("the Push switch shows the browser's subscription and calls the toggle", async () => {
  const { q, pick, toggle } = await render({ push: { on: true, supported: true, busy: false, error: undefined } });
  await pick("notifications");
  expect(q("settings-push")?.getAttribute("aria-checked")).toBe("true");
  await act(async () => q("settings-push")!.click());
  expect(toggle).toHaveBeenCalledTimes(1);
});

it("Push unsupported: aria-disabled with the reason, a click does nothing; an error is an alert under the row", async () => {
  const { q, pick, toggle } = await render({ push: { on: false, supported: false, busy: false, error: "blocked for this site" } });
  await pick("notifications");
  expect(q("settings-push")?.getAttribute("aria-disabled")).toBe("true");
  expect(document.getElementById(q("settings-push")!.getAttribute("aria-describedby")!)?.textContent).toContain("Web Push needs HTTPS or localhost");
  await act(async () => q("settings-push")!.click());
  expect(toggle).not.toHaveBeenCalled();
  expect(q("settings-notifications")!.querySelector('[role="alert"]')?.textContent).toContain("blocked for this site");
});

it("the Desktop row names the daemon's host and writes notifications.desktop; without a host it says the daemon's computer", async () => {
  const { q, pick, calls } = await render();
  await pick("notifications");
  expect(q("settings-notifications")?.textContent).toContain("Desktop notifications on box");
  await act(async () => q("settings-notifications-desktop")!.click());
  expect(calls.find((c) => c.type === "settings.set")).toMatchObject({ patch: { notifications: { desktop: false } } });
  expect(q("settings-notifications-desktop")?.getAttribute("aria-checked")).toBe("false");
});

it("no daemon host: the daemon's computer; --no-os-notify: the switch is aria-disabled with the flag hint and does not save", async () => {
  const a = await render({ daemon: null });
  await a.pick("notifications");
  expect(a.q("settings-notifications")?.textContent).toContain("Desktop notifications on the daemon's computer");
  act(() => root?.unmount());
  document.body.innerHTML = "";
  const { q, pick, calls } = await render({ daemon: { host: "box", desktopForcedOff: true } });
  await pick("notifications");
  expect(q("settings-notifications-desktop")?.getAttribute("aria-disabled")).toBe("true");
  expect(q("settings-notifications")?.textContent).toContain("--no-os-notify");
  await act(async () => q("settings-notifications-desktop")!.click());
  expect(calls.some((c) => c.type === "settings.set")).toBe(false);
});

it("the In-app switch is on by default, writes the per-browser choice and tells the page", async () => {
  localStorage.removeItem("claude-ui.inAppNotifications");
  const heard: boolean[] = [];
  const on = (e: Event) => heard.push((e as CustomEvent<boolean>).detail);
  window.addEventListener("claude-ui:in-app", on);
  const { q, pick } = await render();
  await pick("notifications");
  expect(q("settings-in-app")?.getAttribute("aria-checked")).toBe("true");
  expect(document.getElementById(q("settings-in-app")!.getAttribute("aria-describedby")!)?.textContent).toContain("Kept in this browser");
  await act(async () => q("settings-in-app")!.click());
  expect(localStorage.getItem("claude-ui.inAppNotifications")).toBe("off");
  expect(q("settings-in-app")?.getAttribute("aria-checked")).toBe("false");
  expect(heard).toEqual([false]);
  await act(async () => q("settings-in-app")!.click());
  expect(heard).toEqual([false, true]);
  window.removeEventListener("claude-ui:in-app", on);
});

it("Help & about, the last group, shows the web version and the daemon's as selectable text, with no extra request", async () => {
  const { q, pick, calls } = await render({ daemon: { host: "box", version: "1.2.3" } });
  const before = calls.length;
  await pick("about");
  const about = q("settings-about")!;
  expect(about.textContent).toContain("Web app");
  expect(q("settings-about-web")!.textContent).toBe(WEB_VERSION);
  expect(q("settings-about-daemon")!.textContent).toBe("1.2.3");
  expect(getComputedStyle(q("settings-about-web")!).userSelect).not.toBe("none");
  expect(calls.length).toBe(before);
});

it("About omits the daemon version when an older daemon does not send it", async () => {
  const { q, pick } = await render();
  await pick("about");
  expect(q("settings-about-web")).not.toBeNull();
  expect(q("settings-about-daemon")).toBeNull();
});

it("the Sending section follows Timeline in General and holds the per-browser send mode, steer by default, sending no settings.set", async () => {
  localStorage.removeItem("claude-ui.sendMode");
  const { q, calls, pick } = await render();
  await pick("general");
  expect(q("settings-timeline")!.nextElementSibling).toBe(q("settings-sending"));
  expect(q("settings-sending")!.textContent).toContain("While Claude works, Enter");
  expect(q("settings-sending")!.textContent).toContain("Kept in this browser.");
  expect(q("settings-send-mode")?.textContent).toContain("Steers the turn");
  await act(async () => q("settings-send-mode")!.click());
  await act(async () => document.querySelector<HTMLElement>("[data-testid=settings-send-mode-queue]")!.click());
  expect(localStorage.getItem("claude-ui.sendMode")).toBe("queue");
  expect(q("settings-send-mode")?.textContent).toContain("Queues the message");
  expect(calls.some((c) => c.type === "settings.set")).toBe(false);
  localStorage.removeItem("claude-ui.sendMode");
});

it("Usage limits: Usage ring shows is a per-browser choice, Highest usage by default, and sends no settings.set", async () => {
  localStorage.removeItem("claude-ui.usageRing");
  const { q, calls, pick } = await render();
  await pick("usageLimit");
  expect(q("settings-usage-ring")?.textContent).toContain("Highest usage");
  await act(async () => q("settings-usage-ring")!.click());
  await act(async () => document.querySelector<HTMLElement>("[data-testid=settings-usage-ring-weekly]")!.click());
  expect(localStorage.getItem("claude-ui.usageRing")).toBe("weekly");
  expect(q("settings-usage-ring")?.textContent).toContain("Weekly");
  expect(calls.some((c) => c.type === "settings.set")).toBe(false);
  localStorage.removeItem("claude-ui.usageRing");
});

it("GH-378 Settings > Layout > Tabs has Auto-close idle tabs after (Off, 1 hour, 1 day), shows the value and calls onTabAutoClose", async () => {
  const { q, calls, onTabAutoClose, pick } = await render();
  await pick("layout");
  expect(document.getElementById("settings-tabs-autoclose-label")?.textContent).toBe("Auto-close idle tabs after");
  expect(q("settings-tabs-autoclose")?.textContent).toContain("Off");
  await act(async () => q("settings-tabs-autoclose")!.click());
  expect([...document.querySelectorAll("[role=option]")].map((o) => o.textContent)).toEqual(["Off", "1 hour", "1 day"]);
  await act(async () => document.querySelectorAll<HTMLElement>("[role=option]")[1]!.click());
  expect(onTabAutoClose).toHaveBeenCalledWith("1h");
  expect(q("settings-tabs-autoclose")?.textContent).toContain("1 hour");
  expect(calls.some((c) => c.type === "settings.set")).toBe(false);
});

it("Settings > General > Screen has the Keep screen awake switches; unsupported here: held with the reason, choice still stored (GH-361)", async () => {
  localStorage.removeItem("claude-ui.keepAwake");
  const { q, pick } = await render();
  await pick("general");
  expect(q("settings-screen")?.querySelector("h3")?.textContent).toBe("Screen");
  // jsdom has no wake lock API.
  expect(q("settings-keep-awake")!.getAttribute("aria-disabled")).toBe("true");
  expect(q("settings-screen")!.textContent).toContain("needs HTTPS or localhost");
  await act(async () => q("settings-keep-awake")!.click());
  expect(loadKeepAwake().on).toBe(false);
});

it("Screen switches write the store; the sub-switch is held while the main one is off (GH-361)", async () => {
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "wakeLock", { value: { request: async () => ({}) }, configurable: true });
  try {
    saveKeepAwake({ on: false, onlyRunning: false });
    const { q, pick } = await render();
    await pick("general");
    expect(q("settings-keep-awake-running")!.getAttribute("aria-disabled")).toBe("true");
    await act(async () => q("settings-keep-awake")!.click());
    expect(loadKeepAwake()).toEqual({ on: true, onlyRunning: false });
    expect(q("settings-keep-awake")!.getAttribute("aria-checked")).toBe("true");
    expect(q("settings-keep-awake-running")!.getAttribute("aria-disabled")).toBe("false");
    await act(async () => q("settings-keep-awake-running")!.click());
    expect(loadKeepAwake()).toEqual({ on: true, onlyRunning: true });
  } finally {
    delete (navigator as { wakeLock?: unknown }).wakeLock;
    Object.defineProperty(window, "isSecureContext", { value: undefined, configurable: true });
    localStorage.removeItem("claude-ui.keepAwake");
  }
});

it("Settings › Git shows the nine settings with VS Code's labels and defaults; the parent-folders hint names the difference", async () => {
  const { q, pick } = await render();
  await pick("git");
  expect(q("settings-git-intro")?.textContent).toContain("Same settings as VS Code's Git extension");
  const label = (k: string) => document.querySelector(`label[for="settings-git-${k}"]`)?.textContent ?? q(`settings-git-${k}`)?.querySelector("[id$=-label]")?.textContent;
  expect(["autoRepositoryDetection", "repositoryScanMaxDepth", "repositoryScanIgnoredFolders", "scanRepositories", "ignoredRepositories", "detectSubmodules", "detectSubmodulesLimit", "ignoreSubmodules", "openRepositoryInParentFolders"].map(label)).toEqual(["Auto repository detection", "Repository scan max depth", "Repository scan ignored folders", "Scan repositories", "Ignored repositories", "Detect submodules", "Detect submodules limit", "Ignore submodules", "Open repository in parent folders"]);
  expect(q("settings-git-autoRepositoryDetection")?.textContent).toContain("true");
  expect((q("settings-git-repositoryScanMaxDepth") as HTMLInputElement).value).toBe("1");
  expect(q("settings-git-repositoryScanIgnoredFolders")?.querySelectorAll('[data-testid$="-item"]')).toHaveLength(1);
  expect(q("settings-git-repositoryScanIgnoredFolders")?.textContent).toContain("node_modules");
  expect(q("settings-git-scanRepositories")?.querySelectorAll('[data-testid$="-item"]')).toHaveLength(0);
  expect(q("settings-git-detectSubmodules")?.getAttribute("aria-checked")).toBe("true");
  expect(q("settings-git-ignoreSubmodules")?.getAttribute("aria-checked")).toBe("false");
  expect((q("settings-git-detectSubmodulesLimit") as HTMLInputElement).value).toBe("10");
  expect(q("settings-git-openRepositoryInParentFolders")?.textContent).toContain("always");
  expect(document.getElementById("settings-git-openRepositoryInParentFolders-hint")?.textContent).toContain("VS Code: prompt");
});

it("Auto repository detection saves true/false as booleans and subFolders as a string", async () => {
  const { q, pick, calls } = await render();
  await pick("git");
  const choose = async (v: string) => {
    await act(async () => q("settings-git-autoRepositoryDetection")!.click());
    await act(async () => document.querySelector<HTMLElement>(`[data-testid="settings-git-autoRepositoryDetection-${v}"]`)!.click());
    return calls.filter((c) => c.type === "settings.set").at(-1);
  };
  expect(await choose("false")).toEqual({ type: "settings.set", patch: { git: { autoRepositoryDetection: false } } });
  expect(await choose("subFolders")).toEqual({ type: "settings.set", patch: { git: { autoRepositoryDetection: "subFolders" } } });
  expect(await choose("true")).toEqual({ type: "settings.set", patch: { git: { autoRepositoryDetection: true } } });
});

const typeInto = async (el: HTMLInputElement, v: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const key = async (el: HTMLElement, k: string) => void (await act(async () => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }))));

it("a list setting adds, edits and removes an item, saving the whole array each time", async () => {
  const { q, pick, calls } = await render();
  await pick("git");
  const id = "settings-git-repositoryScanIgnoredFolders";
  const sets = () => calls.filter((c) => c.type === "settings.set");
  await act(async () => q(`${id}-add`)!.click());
  await typeInto(q(`${id}-input`) as HTMLInputElement, "dist");
  await key(q(`${id}-input`)!, "Enter");
  expect(sets().at(-1)).toEqual({ type: "settings.set", patch: { git: { repositoryScanIgnoredFolders: ["node_modules", "dist"] } } });
  expect(q(`${id}-input`)).toBeNull();
  await act(async () => q(`${id}`)!.querySelectorAll<HTMLElement>(`[data-testid="${id}-edit"]`)[0]!.click());
  expect((q(`${id}-input`) as HTMLInputElement).value).toBe("node_modules");
  await typeInto(q(`${id}-input`) as HTMLInputElement, "vendor");
  await act(async () => q(`${id}-ok`)!.click());
  expect(sets().at(-1)).toMatchObject({ patch: { git: { repositoryScanIgnoredFolders: ["vendor", "dist"] } } });
  await act(async () => q(`${id}`)!.querySelectorAll<HTMLElement>(`[data-testid="${id}-remove"]`)[0]!.click());
  expect(sets().at(-1)).toMatchObject({ patch: { git: { repositoryScanIgnoredFolders: ["dist"] } } });
  const n = sets().length;
  await act(async () => q(`${id}-add`)!.click());
  await typeInto(q(`${id}-input`) as HTMLInputElement, "zzz");
  await key(q(`${id}-input`)!, "Escape");
  expect(q(`${id}-input`)).toBeNull();
  await act(async () => q(`${id}-add`)!.click());
  await act(async () => q(`${id}-cancel`)!.click());
  expect(sets()).toHaveLength(n);
});

it("a refused list entry keeps the input open and shows the daemon's message", async () => {
  const { q, pick, refuse } = await render();
  await pick("git");
  const id = "settings-git-scanRepositories";
  refuse("Scan repositories must be at most 50 relative paths without .. or .git, of at most 260 characters");
  await act(async () => q(`${id}-add`)!.click());
  await typeInto(q(`${id}-input`) as HTMLInputElement, "../x");
  await act(async () => q(`${id}-ok`)!.click());
  expect(q(`${id}-input`)).not.toBeNull();
  expect(q("settings-dialog")?.textContent).toContain("Scan repositories must be");
});

it("list buttons are 44px below md", async () => {
  const { q, pick } = await render();
  await pick("git");
  const id = "settings-git-repositoryScanIgnoredFolders";
  expect(q(`${id}-edit`)!.className).toContain("max-md:size-11");
  expect(q(`${id}-remove`)!.className).toContain("max-md:size-11");
  expect(q(`${id}-add`)!.className).toContain("max-md:h-11");
  await act(async () => q(`${id}-add`)!.click());
  expect(q(`${id}-ok`)!.className).toContain("max-md:h-11");
  expect(q(`${id}-input`)!.className).toContain("max-md:h-11");
});

it("Appearance (GH-468): the theme list has 7 themes in order, each with a swatch; Dracula says dark only; a pick recolours without reload and is kept", async () => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.classList.remove("dark");
  const { q } = await render();
  expect(q("settings-appearance")!.querySelector("h3")?.textContent).toBe("Appearance");
  expect(q("settings-theme")!.querySelector('[data-testid="settings-theme-swatch"]')).not.toBeNull();
  expect(q("settings-theme")!.textContent).toContain("Default");
  await act(async () => q("settings-theme")!.click());
  const items = [...document.querySelectorAll('[role=option]')];
  expect(items.map((i) => i.textContent)).toEqual(["Default", "Catppuccin", "Tokyo Night", "Solarized", "Nord", "Dracula" + "dark only", "One"]);
  for (const i of items) expect(i.querySelector('[data-testid="settings-theme-swatch"]')).not.toBeNull();
  expect(q("settings-theme-dracula")!.textContent).toContain("dark only");
  expect(q("settings-theme-nord")!.textContent).not.toContain("dark only");
  await act(async () => q("settings-theme-catppuccin")!.click());
  expect(document.documentElement.getAttribute("data-theme")).toBe("catppuccin");
  expect(localStorage.getItem("claude-ui.colorTheme")).toBe("catppuccin");
  expect(q("settings-theme")!.textContent).toContain("Catppuccin");
});

it("Appearance (GH-468): Dracula in light mode shows the warning; dark mode does not", async () => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  const { q } = await render();
  await act(async () => q("settings-theme")!.click());
  await act(async () => q("settings-theme-dracula")!.click());
  expect(q("settings-theme-dracula-warning")!.textContent).toBe("Dracula has no light colors: light mode shows Default.");
  await act(async () => void document.documentElement.classList.add("dark"));
  expect(q("settings-theme-dracula-warning")).toBeNull();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
});

const LOCAL = { id: "local", label: "Windows", state: "ready" } as const;

it("Sides group: shown only with a non-local side or docker", async () => {
  expect((await render({ sides: [LOCAL] })).q("settings-group-sides")).toBeNull();
  document.body.innerHTML = "";
  expect((await render({})).q("settings-group-sides")).toBeNull();
  document.body.innerHTML = "";
  const a = await render({ sides: [LOCAL], docker: "empty" });
  expect(a.q("settings-group-sides")).not.toBeNull();
  await a.pick("sides");
  expect(a.q("settings-sides")?.textContent).toContain("No WSL distro or container");
});

it("Sides group: a row per side with state; the switches send side.prefs; Update automatically is held while start is off", async () => {
  const { q, pick, calls } = await render({
    sides: [LOCAL, { id: "wsl:Ubuntu", label: "WSL: Ubuntu", state: "ready", autoStart: true }, { id: "docker:dev", label: "Docker: dev", state: "off", missing: true }, { id: "wsl:Old", label: "WSL: Old", state: "starting", autoStart: true, autoUpdate: false }],
  });
  await pick("sides");
  expect(q("settings-side-wsl:Ubuntu")?.textContent).toContain("WSL: Ubuntu");
  expect(q("settings-side-wsl:Ubuntu")?.textContent).toContain("Running");
  expect(q("settings-side-docker:dev")?.textContent).toContain("Not running");
  expect(q("settings-side-wsl:Old")?.textContent).toContain("Starting…");
  expect(q("settings-side-start-wsl:Ubuntu")?.getAttribute("aria-checked")).toBe("true");
  expect(q("settings-side-start-docker:dev")?.getAttribute("aria-checked")).toBe("false");
  expect(q("settings-side-update-wsl:Ubuntu")?.getAttribute("aria-checked")).toBe("true");
  expect(q("settings-side-update-wsl:Old")?.getAttribute("aria-checked")).toBe("false");
  expect(q("settings-side-update-docker:dev")?.getAttribute("aria-disabled")).toBe("true");
  await act(async () => q("settings-side-start-wsl:Ubuntu")!.click());
  expect(calls.at(-1)).toEqual({ type: "side.prefs", side: "wsl:Ubuntu", start: false });
  await act(async () => q("settings-side-start-docker:dev")!.click());
  expect(calls.at(-1)).toEqual({ type: "side.prefs", side: "docker:dev", start: true });
  await act(async () => q("settings-side-update-wsl:Old")!.click());
  expect(calls.at(-1)).toEqual({ type: "side.prefs", side: "wsl:Old", update: true });
  const n = calls.length;
  await act(async () => q("settings-side-update-docker:dev")!.click());
  expect(calls).toHaveLength(n);
});

it("Appearance (GH-510): Language offers System, English, Tiếng Việt; a pick applies at once and is kept", async () => {
  localStorage.clear();
  const { q } = await render();
  expect(q("settings-language")!.textContent).toContain("System");
  await act(async () => q("settings-language")!.click());
  expect([...document.querySelectorAll('[data-testid^="settings-language-"][role=option]')].map((i) => i.textContent)).toEqual(["System", "English", "Tiếng Việt"]);
  await act(async () => q("settings-language-vi")!.click());
  expect(document.documentElement.lang).toBe("vi");
  expect(localStorage.getItem("claude-ui.locale")).toBe("vi");
  expect(q("settings-language")!.textContent).toContain("Tiếng Việt");
  expect(document.getElementById("settings-language-label")!.textContent).toBe("Ngôn ngữ");
  const { setLocalePref } = await import("./i18n.ts");
  act(() => setLocalePref("system"));
  expect(document.getElementById("settings-language-label")!.textContent).toBe("Language");
});

it("renders Vietnamese: group list, daemon rows with their hints, and select labels", async () => {
  const { setLocalePref } = await import("./i18n.ts");
  act(() => setLocalePref("vi"));
  try {
    const { q, pick } = await render();
    expect(q("settings-groups")!.textContent).toContain("Giao diện");
    await pick("orchestration");
    expect(document.querySelector('label[for="settings-orchestration-workerCap"]')?.textContent).toBe("Số worker tối đa mỗi cây");
    expect(q("settings-orchestration-enabled")?.getAttribute("aria-label")).toBe("Bật điều phối");
    expect(document.getElementById("settings-orchestration-enabled-hint")?.textContent).toContain("Mọi phiên có thể khởi động");
    await pick("general");
    expect(q("settings-dialog")!.textContent).toContain("Chỉ tín hiệu");
    expect(q("settings-send-mode")!.textContent).toContain("Điều hướng lượt");
  } finally {
    act(() => setLocalePref("system"));
  }
});
