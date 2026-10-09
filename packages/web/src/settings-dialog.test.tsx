// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Settings } from "@claude-ui/protocol";
import type { Request } from "./client.ts";
import { SettingsDialog } from "./settings-dialog.tsx";
import { loadSignalOnly, saveSignalOnly } from "./signal.ts";
import { bind, resetAll } from "./keymap.ts";
import type { TabGrouping } from "./tab-grouping.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

async function render({ failGet = false, group, daemon = { host: "box" } as { host: string; version?: string; desktopForcedOff?: true } | null, push = { on: false, supported: true, busy: false, error: undefined as string | undefined } }: { failGet?: boolean; group?: string; daemon?: { host: string; version?: string; desktopForcedOff?: true } | null; push?: { on: boolean; supported: boolean; busy: boolean; error: string | undefined } } = {}) {
  const toggle = vi.fn();
  localStorage.removeItem("claude-ui.settingsGroup");
  if (group) localStorage.setItem("claude-ui.settingsGroup", group);
  const onTabGrouping = vi.fn();
  const onRestartGuide = vi.fn();
  const onTabCompact = vi.fn();
  const onShortcuts = vi.fn();
  let settings: Settings = { orchestration: { enabled: false, workerCap: 4, coordinatorPermissions: true, workerMode: "coordinator" }, usageLimit: { autoContinue: false }, notifications: { desktop: true } };
  const calls: Request[] = [];
  const request = vi.fn(async (msg: Request) => {
    calls.push(msg);
    if (failGet && msg.type === "settings.get") throw new Error("daemon unreachable");
    if (msg.type === "settings.set") {
      const v = (msg.patch.orchestration ?? {}) as Record<string, unknown>;
      if (typeof v.workerCap === "number" && (v.workerCap < 1 || v.workerCap > 20 || !Number.isInteger(v.workerCap))) throw new Error("Maximum workers must be a whole number from 1 to 20");
      settings = { orchestration: { ...settings.orchestration, ...v }, usageLimit: { ...settings.usageLimit, ...((msg.patch.usageLimit ?? {}) as object) }, notifications: { ...settings.notifications, ...((msg.patch.notifications ?? {}) as object) } };
    }
    return { settings, ...(daemon && { daemon }) };
  });
  const el = document.createElement("div");
  const prompt = document.createElement("textarea");
  prompt.setAttribute("aria-label", "Prompt");
  Object.defineProperty(prompt, "offsetParent", { get: () => document.body });
  document.body.append(el, prompt);
  function Host() {
    const [open, set] = useState(true);
    const [grouping, setGrouping] = useState<TabGrouping>("project");
    const [compact, setCompact] = useState(false);
    return (
      <SettingsDialog
        open={open}
        onShortcuts={onShortcuts}
        push={{ ...push, toggle }}
        request={request as never}
        onClose={() => set(false)}
        tabCompact={compact}
        onTabCompact={(on) => {
          onTabCompact(on);
          setCompact(on);
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
  return { calls, toggle, q, pick, prompt, onTabGrouping, onTabCompact, onShortcuts, onRestartGuide };
}

it("shows the Orchestration section with labelled controls, loaded from the daemon", async () => {
  const { q, pick } = await render();
  await pick("orchestration");
  expect(q("settings-dialog")?.textContent).toContain("Orchestration");
  expect(q("settings-orchestration-enabled")?.getAttribute("aria-checked")).toBe("false");
  expect(q("settings-orchestration-coordinatorPermissions")?.getAttribute("aria-checked")).toBe("true");
  expect((q("settings-orchestration-workerCap") as HTMLInputElement).value).toBe("4");
  expect(document.querySelector('label[for="settings-orchestration-workerCap"]')?.textContent).toBe("Maximum workers");
  // Short accessible name; the hint is the description.
  const desc = (id: string) => document.getElementById(q(id)!.getAttribute("aria-describedby")!)?.textContent;
  expect(q("settings-orchestration-enabled")?.getAttribute("aria-label")).toBe("Enable orchestration");
  expect(desc("settings-orchestration-enabled")).toContain("start and supervise worker sessions");
  expect(desc("settings-orchestration-workerCap")).toContain("1 to 20");
  expect(desc("settings-orchestration-coordinatorPermissions")).toContain("read-only git commands (status, log, diff, show). Other commands and everything else wait for you");
  expect(desc("settings-orchestration-coordinatorPermissions")).toContain("Edits can change code that commands you approve later will run.");
});

it("a switch sends a patch of its field only", async () => {
  const { q, calls, pick } = await render();
  await pick("orchestration");
  await act(async () => q("settings-orchestration-enabled")!.click());
  expect(calls.at(-1)).toEqual({ type: "settings.set", patch: { orchestration: { enabled: true } } });
  expect(q("settings-orchestration-enabled")?.getAttribute("aria-checked")).toBe("true");
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
  expect(q("banner-error")?.textContent).toContain("Maximum workers must be a whole number");
});

it("Compact tabs is a switch that applies at once, and is disabled with a hint while grouping is None", async () => {
  const { q, calls, onTabCompact, pick } = await render();
  await pick("tabs");
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
  await pick("tabs");
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
  await pick("tabs");
  expect(q("settings-tabs")).not.toBeNull();
});

it("Esc closes the dialog and the focus returns to the prompt box", async () => {
  const { q, prompt } = await render();
  await act(async () => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => void new Promise((r) => setTimeout(r, 50)));
  expect(q("settings-dialog")).toBeNull();
  expect(document.activeElement).toBe(prompt);
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
  await pick("changes");
  expect(q("settings-diff-mode")?.textContent).toContain("Session changes");
  await act(async () => q("settings-diff-mode")!.click());
  await act(async () => document.querySelector<HTMLElement>("[data-testid=settings-diff-mode-uncommitted]")!.click());
  expect(localStorage.getItem("claude-ui.diffMode")).toBe("uncommitted");
  expect(q("settings-diff-mode")?.textContent).toContain("Uncommitted");
  expect(calls.some((c) => c.type === "settings.set")).toBe(false);
  localStorage.removeItem("claude-ui.diffMode");
});

it("Sidebar section: Show only active sessions is the sidebar's own per-browser setting, off by default (GH-159)", async () => {
  localStorage.clear();
  const { q, pick } = await render();
  await pick("sidebar");
  const sw = q("settings-sidebar-active-only")!;
  expect(q("settings-sidebar")!.textContent).toContain("Lists sessions that are running or need input. Search still finds every session, and the one you have open stays listed.");
  expect(sw.getAttribute("aria-checked")).toBe("false");
  await act(async () => sw.click());
  expect(sw.getAttribute("aria-checked")).toBe("true");
  expect(JSON.parse(localStorage.getItem("claude-ui.sidebarView")!).onlyActive).toBe(true);
  await act(async () => sw.click());
  expect(JSON.parse(localStorage.getItem("claude-ui.sidebarView")!).onlyActive).toBe(false);
});

it("shows a Guide section whose Restart guide button calls onRestartGuide", async () => {
  const { q, onRestartGuide, pick } = await render();
  await pick("guide");
  expect(q("settings-guide")!.textContent).toContain("Guided tour");
  const button = q("settings-guide-restart") as HTMLButtonElement;
  expect(button.textContent).toBe("Restart guide");
  expect(button.getAttribute("aria-describedby")).toBe("settings-guide-tour-hint");
  await act(async () => button.click());
  expect(onRestartGuide).toHaveBeenCalledTimes(1);
});

it("lists the groups: Timeline first, Guide after Tabs, the daemon's groups last", async () => {
  const { q } = await render();
  const ids = [...document.querySelectorAll('[role=tab]')].map((t) => t.textContent);
  expect(ids).toEqual(["Timeline", "Notifications", "Changes", "Sidebar", "Tabs", "Keyboard", "Guide", "Orchestration", "Usage limits", "About"]);
  expect(q("settings-groups")?.getAttribute("role")).toBe("tablist");
});

it("the Keyboard section's Customize button opens the shortcuts dialog", async () => {
  const { q, onShortcuts, pick } = await render();
  await pick("keyboard");
  expect(q("settings-keyboard")?.textContent).toContain("Keyboard");
  await act(async () => q("settings-shortcuts")!.click());
  expect(onShortcuts).toHaveBeenCalledOnce();
});

it("shows one group at a time: the first by default, picking another swaps the panel and the choice is remembered per browser", async () => {
  const { q, pick } = await render();
  expect(document.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe("Timeline");
  expect(q("settings-timeline")).not.toBeNull();
  expect(q("settings-tabs")).toBeNull();
  expect(q("settings-panel")?.getAttribute("aria-labelledby")).toBe("settings-tab-timeline");
  await pick("tabs");
  expect(q("settings-tabs")).not.toBeNull();
  expect(q("settings-timeline")).toBeNull();
  expect(localStorage.getItem("claude-ui.settingsGroup")).toBe("tabs");
  act(() => root?.unmount());
  document.body.innerHTML = "";
  const again = await render({ group: "tabs" });
  expect(again.q("settings-tabs")).not.toBeNull();
  expect(document.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe("Tabs");
});

it("an unknown remembered group falls back to the first", async () => {
  const { q } = await render({ group: "nope" });
  expect(q("settings-timeline")).not.toBeNull();
});

it("arrow keys move through the groups (roving tabindex), Home and End jump, and the panel follows", async () => {
  const { q } = await render();
  const key = (k: string) => act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
  await act(async () => q("settings-group-timeline")!.focus());
  await key("ArrowDown");
  expect(document.activeElement).toBe(q("settings-group-notifications"));
  expect(q("settings-group-notifications")!.getAttribute("aria-selected")).toBe("true");
  expect(q("settings-group-timeline")!.getAttribute("tabindex")).toBe("-1");
  expect(q("settings-group-notifications")!.getAttribute("tabindex")).toBe("0");
  expect(q("settings-notifications")).not.toBeNull();
  await key("End");
  expect(document.activeElement).toBe(q("settings-group-about"));
  await key("ArrowDown");
  expect(document.activeElement).toBe(q("settings-group-timeline"));
  await key("ArrowUp");
  expect(document.activeElement).toBe(q("settings-group-about"));
  await key("Home");
  expect(document.activeElement).toBe(q("settings-group-timeline"));
});

it("the Back button shows on the drill-in panel and returns the focus to the group in the list", async () => {
  const { q, pick } = await render();
  await pick("sidebar");
  expect(q("settings-back")?.textContent).toBe("Settings");
  expect(q("settings-groups")!.className).toContain("max-md:hidden");
  expect(q("settings-panel")!.className).not.toContain("max-md:hidden");
  await act(async () => q("settings-back")!.click());
  await act(async () => void new Promise((r) => setTimeout(r, 50)));
  expect(q("settings-groups")!.className).not.toContain("max-md:hidden");
  expect(q("settings-panel")!.className).toContain("max-md:hidden");
  expect(document.activeElement).toBe(q("settings-group-sidebar"));
});

it("Signal only is a per-browser switch in the Timeline group, off by default, that saves at once and sends no settings.set (GH-205)", async () => {
  localStorage.clear();
  const { q, calls } = await render();
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
  const { q } = await render();
  expect(q("settings-signal-keys")?.textContent).toMatch(/Alt\+S$/);
  await act(async () => bind("signal.toggle", "mod+alt+j"));
  expect(q("settings-signal-keys")?.textContent).toMatch(/Alt\+J$/);
  await act(async () => bind("signal.toggle", null));
  expect(q("settings-signal-keys")).toBeNull();
  await act(async () => resetAll());
});

it("Tab from the group list reaches the first visible control of the panel, not the hidden phone Back button (GH-214)", async () => {
  const { q } = await render();
  // jsdom has no Tailwind: hide the Back button the way `md:hidden` does from md up.
  q("settings-back")!.style.display = "none";
  await act(async () => q("settings-group-timeline")!.focus());
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

it("About, the last group, shows the web version and the daemon's as selectable text, with no extra request", async () => {
  const { q, pick, calls } = await render({ daemon: { host: "box", version: "1.2.3" } });
  const before = calls.length;
  await pick("about");
  const about = q("settings-about")!;
  expect(about.textContent).toContain("Web app");
  expect(q("settings-about-web")!.textContent).toBe("dev");
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
