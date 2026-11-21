// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PlanUsage } from "@claude-ui/protocol";
import { PlanMeter, planLevel, resetText, type PlanAccounts, type PlanProject } from "./plan-meter.tsx";
import { t } from "./i18n.ts";

const OAUTH_UNAVAILABLE = t("app.plan.oauthUnavailable");

const now = Date.now();
const usage: PlanUsage = {
  plan: "team",
  status: "allowed",
  windows: [
    { kind: "session", label: "Current session", percent: 55, resetsAt: now + (2 * 60 + 5) * 60_000 + 30_000, severity: "normal", active: true },
    { kind: "weekly_all", label: "Current week (all models)", percent: 44, resetsAt: now + (2 * 24 + 3) * 3_600_000 + 30_000, severity: "normal", active: false },
    { kind: "weekly_scoped", label: "Current week (Fable)", percent: 2, resetsAt: null, severity: "normal", active: false },
  ],
};

let unmount = () => {};
afterEach(() => unmount());

async function render(u: PlanUsage, switcher?: PlanAccounts, project?: PlanProject) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(<PlanMeter usage={u} switcher={switcher} project={project} />));
  unmount = () => (root.unmount(), el.remove());
  return el;
}
const meter = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-testid="plan-meter"]')!;

it("shows the server's headline window as percent, the label names window and reset", async () => {
  const el = await render(usage);
  expect(meter(el).textContent).toBe("55%");
  expect(meter(el).dataset.level).toBe("ok");
  expect(meter(el).getAttribute("aria-label")).toMatch(/^Plan usage: Current session 55%, resets .* \(in 2h 5m\), show details$/);
});

it("click opens each window with percent and reset time", async () => {
  const el = await render(usage);
  await act(async () => meter(el).click());
  const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="plan-window"]')];
  expect(rows.map((r) => r.querySelector("span")!.textContent)).toEqual(["Current session", "Current week (all models)", "Current week (Fable)"]);
  expect(rows.map((r) => r.querySelectorAll("span")[1]!.textContent)).toEqual(["55%", "44%", "2%"]);
  expect(rows[0]!.textContent).toContain("(in 2h 5m)");
  expect(rows[1]!.textContent).toContain("(in 2d 3h)");
  expect(document.querySelector('[data-testid="plan-usage"]')!.textContent).toContain("Team plan");
});

it("warns past the threshold or on the server's grade, with an icon (not color only)", async () => {
  expect(planLevel({ ...usage, windows: [{ ...usage.windows[0]!, percent: 80 }] })).toBe("warning");
  expect(planLevel({ ...usage, windows: [{ ...usage.windows[0]!, severity: "warning" }] })).toBe("warning");
  expect(planLevel({ ...usage, status: "allowed_warning" })).toBe("warning");
  const el = await render({ ...usage, windows: [{ ...usage.windows[0]!, percent: 91 }, usage.windows[1]!] });
  expect(meter(el).dataset.level).toBe("warning");
  expect(meter(el).querySelector('[data-testid="plan-warning-icon"]')).not.toBeNull();
});

it("warning caused by another window: the trigger shows that window and its label names the warning", async () => {
  const el = await render({ ...usage, windows: [{ ...usage.windows[0]!, percent: 72 }, { ...usage.windows[1]!, percent: 86 }] });
  expect(meter(el).dataset.level).toBe("warning");
  expect(meter(el).textContent).toBe("86%");
  expect(meter(el).getAttribute("aria-label")).toMatch(/^Plan usage warning: Current week \(all models\) 86%, resets .*, show details$/);
  expect(meter(el).title).toMatch(/^Plan usage warning: Current week \(all models\) 86%/);
});

it("limit hit: a window at 100% or a rejected rate_limit_event, shown with its reset time", async () => {
  expect(planLevel({ ...usage, windows: [{ ...usage.windows[1]!, percent: 100 }] })).toBe("limit");
  const el = await render({ ...usage, status: "rejected", statusResetsAt: now + 65 * 60_000 + 30_000 });
  expect(meter(el).dataset.level).toBe("limit");
  expect(meter(el).getAttribute("aria-label")).toMatch(/^Plan usage: limit reached, resets .* \(in 1h 5m\), show details$/);
  await act(async () => meter(el).click());
  expect(document.querySelector('[data-testid="plan-limit"]')!.textContent).toMatch(/^Limit reached\. Resets .* \(in 1h 5m\)$/);
});

it("a rejected limit names its window when the event did; the popover's relative reset time counts down while open", async () => {
  vi.useFakeTimers({ now, toFake: ["Date", "setInterval", "clearInterval"] });
  try {
    const el = await render({ ...usage, status: "rejected", statusLimit: "Current week (Opus)", statusResetsAt: now + 65 * 60_000 + 30_000 });
    expect(meter(el).getAttribute("aria-label")).toMatch(/^Plan usage: limit reached: Current week \(Opus\), resets /);
    await act(async () => meter(el).click());
    const limit = () => document.querySelector('[data-testid="plan-limit"]')!.textContent;
    expect(limit()).toMatch(/^Limit reached: Current week \(Opus\)\. Resets .* \(in 1h 5m\)$/);
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(limit()).toMatch(/\(in 1h 4m\)$/);
  } finally {
    vi.useRealTimers();
  }
});

it("reset text: time today, weekday otherwise, relative part", () => {
  const base = new Date(2026, 9, 1, 9, 0).getTime();
  expect(resetText(base + 30 * 60_000, base)).toMatch(/^Resets \d{1,2}:30.* \(in 30m\)$/);
  expect(resetText(base + 26 * 3_600_000, base)).toMatch(/^Resets Fri.* \(in 1d 2h\)$/);
  expect(resetText(base - 1, base)).toBe("Resets now");
});

const set = (v?: string) => (v ? localStorage.setItem("claude-ui.usageRing", v) : localStorage.removeItem("claude-ui.usageRing"));
afterEach(() => set());

it("Usage ring shows Weekly: the weekly window's percent and ring, the popover still lists every window", async () => {
  set("weekly");
  const el = await render(usage);
  expect(meter(el).textContent).toBe("44%");
  expect(meter(el).getAttribute("aria-label")).toContain("Current week (all models) 44%");
  await act(async () => meter(el).click());
  expect(document.querySelectorAll('[data-testid="plan-window"]').length).toBe(3);
});

it("Usage ring shows Session while a weekly window is at its limit: session percent, limit icon and level stay", async () => {
  set("session");
  const el = await render({ ...usage, windows: [usage.windows[0]!, { ...usage.windows[1]!, percent: 100 }, usage.windows[2]!] });
  expect(meter(el).textContent).toBe("55%");
  expect(meter(el).dataset.level).toBe("limit");
  expect(el.querySelector('[data-testid="plan-warning-icon"]')).not.toBeNull();
});

it("Usage ring shows a missing window: falls back to the highest", async () => {
  set("session");
  const el = await render({ ...usage, windows: usage.windows.slice(1) });
  expect(meter(el).textContent).toBe("44%");
});

it("env token without windows: muted ring and '–' with a 44px touch width below md, titled 'Plan usage is not available with CLAUDE_CODE_OAUTH_TOKEN'; the popover says to run claude login", async () => {
  const el = await render({ plan: null, status: "allowed", windows: [], auth: "oauth_token" });
  expect(meter(el).textContent).toBe("–");
  expect(meter(el).className).toContain("max-md:min-w-11");
  expect(meter(el).title).toBe(OAUTH_UNAVAILABLE);
  expect(meter(el).getAttribute("aria-label")).toBe(`${OAUTH_UNAVAILABLE}, show details`);
  expect(meter(el).dataset.unavailable).toBe("true");
  expect(meter(el).dataset.level).toBe("ok");
  expect(meter(el).querySelector('[data-testid="plan-warning-icon"]')).toBeNull();
  await act(async () => meter(el).click());
  expect(document.querySelector('[data-testid="plan-auth-note"]')!.textContent).toContain("claude login");
  expect(document.querySelectorAll('[data-testid="plan-window"]')).toHaveLength(0);
  expect(document.querySelector('[data-testid="plan-usage"]')!.textContent).not.toMatch(/[A-Z][a-z]+ plan(?! usage)/);
});

it("env token with event windows: ring shows the percent, the popover notes the limited windows", async () => {
  const el = await render({ ...usage, plan: null, windows: usage.windows.slice(0, 2), auth: "oauth_token" });
  expect(meter(el).textContent).toBe("55%");
  expect(meter(el).dataset.unavailable).toBeUndefined();
  await act(async () => meter(el).click());
  expect(document.querySelector('[data-testid="plan-auth-note"]')!.textContent).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  expect(document.querySelectorAll('[data-testid="plan-window"]')).toHaveLength(2);
});

it("env token, no windows, limit reached: the name says the limit, not unavailable", async () => {
  const el = await render({ plan: null, status: "rejected", windows: [], auth: "oauth_token", statusLimit: "Current session" });
  expect(meter(el).title).toMatch(/^Plan usage: limit reached: Current session/);
  expect(meter(el).title).not.toBe(OAUTH_UNAVAILABLE);
});

// GH-615: the account switcher of the usage ring.
const accounts = { accounts: [{ id: "a1", name: "bad" }], active: "a1", envToken: false, onSwitch: vi.fn() };
const open = async (el: HTMLElement) => {
  await act(async () => meter(el).click());
  return document.querySelector<HTMLElement>('[data-testid="plan-usage"]')!;
};

it("the ring label and the popover name the active account; the switcher lists CLI login and token accounts (Default only with an env token); the active row is checked", async () => {
  const el = await render({ ...usage, account: "bad" }, accounts);
  expect(meter(el).getAttribute("aria-label")).toMatch(/^bad: Plan usage/);
  const pop = await open(el);
  expect(pop.querySelector('[data-testid="plan-account"]')!.textContent).toBe("Account: bad");
  const rows = [...pop.querySelectorAll<HTMLElement>('[data-testid="plan-account-option"]')];
  expect(rows.map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([["CLI login", "false"], ["bad", "true"]]);
  expect(rows.every((r) => r.className.includes("max-md:h-11") && r.className.includes("pointer-coarse:h-11"))).toBe(true);
  unmount();
  const el2 = await render(usage, { ...accounts, envToken: true, active: "" });
  const rows2 = [...(await open(el2)).querySelectorAll<HTMLElement>('[data-testid="plan-account-option"]')];
  expect(rows2.map((r) => r.textContent)).toEqual(["Default (daemon environment)", "CLI login", "bad"]);
  expect(rows2[0]!.getAttribute("aria-checked")).toBe("true");
});

it("clicking another row calls onSwitch with its id and keeps the popover open", async () => {
  const onSwitch = vi.fn();
  const el = await render(usage, { ...accounts, onSwitch });
  const pop = await open(el);
  await act(async () => pop.querySelectorAll<HTMLElement>('[data-testid="plan-account-option"]')[0]!.click());
  expect(onSwitch).toHaveBeenCalledWith("cli");
  expect(document.querySelector('[data-testid="plan-usage"]')).not.toBeNull();
});

it("no other choice, no switcher; a rejected limit points at the switcher", async () => {
  const el = await render(usage, { ...accounts, accounts: [], active: "cli" });
  expect((await open(el)).querySelector('[data-testid="plan-accounts"]')).toBeNull();
  unmount();
  const el2 = await render({ ...usage, status: "rejected" }, accounts);
  expect((await open(el2)).querySelector('[data-testid="plan-limit"]')!.textContent).toContain("Switch account below.");
});

it("a token account's note points at CLI login, not at claude login (GH-615)", async () => {
  const el = await render({ plan: null, windows: [], status: "allowed", auth: "oauth_token", account: "bad" }, accounts);
  const note = (await open(el)).querySelector('[data-testid="plan-auth-note"]')!.textContent!;
  expect(note).toContain("Switch to CLI login");
  expect(note).not.toContain("Run claude login");
});

// GH-900: the shown Session's Project overrides the Claude account.
const project = (more: Partial<PlanProject> = {}): PlanProject => ({ name: "Acme", account: "bad", globalName: "Personal", onGlobal: vi.fn(), onSettings: vi.fn(), ...more });

it("Project scope: the chip names the account with an icon on desktop and the label names account and Project; no chip in global scope", async () => {
  const el = await render({ ...usage, account: "bad" }, accounts, project());
  const chip = meter(el).querySelector<HTMLElement>('[data-testid="plan-account-chip"]')!;
  expect(chip.textContent).toBe("bad");
  expect(chip.querySelector("svg")).not.toBeNull();
  expect(meter(el).getAttribute("aria-label")).toMatch(/^bad \(Project Acme\): Plan usage: Current session 55%.*, show details$/);
  unmount();
  const el2 = await render({ ...usage, account: "bad" }, accounts);
  expect(meter(el2).querySelector('[data-testid="plan-account-chip"]')).toBeNull();
});

it("Project scope on a phone: the account name is hidden below md, the icon stays", async () => {
  const el = await render(usage, accounts, project());
  const chip = meter(el).querySelector<HTMLElement>('[data-testid="plan-account-chip"]')!;
  expect(chip.querySelector("svg")!.getAttribute("class")).not.toContain("max-md:hidden");
  expect(chip.querySelector("[data-testid='plan-account-name']")!.getAttribute("class")).toContain("max-md:hidden");
});

it("Project scope popover: account, who sets it, switcher with Global first; picking writes through onSwitch, Global through onGlobal; footer opens the Project settings", async () => {
  const p = project();
  const onSwitch = vi.fn();
  const el = await render({ ...usage, account: "bad" }, { ...accounts, onSwitch }, p);
  const pop = await open(el);
  expect(pop.querySelector('[data-testid="plan-account"]')!.textContent).toBe("Account: bad");
  expect(pop.querySelector('[data-testid="plan-project"]')!.textContent).toBe("Set by Project Acme");
  expect(pop.querySelector('[data-testid="plan-accounts"] p')!.textContent).toBe("Account for this Project");
  const rows = [...pop.querySelectorAll<HTMLElement>('[data-testid="plan-account-option"]')];
  expect(rows.map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([["Global (Personal)", "false"], ["CLI login", "false"], ["bad", "true"]]);
  await act(async () => rows[1]!.click());
  expect(onSwitch).toHaveBeenCalledWith("cli");
  await act(async () => rows[0]!.click());
  expect(p.onGlobal).toHaveBeenCalledTimes(1);
  expect(onSwitch).toHaveBeenCalledTimes(1);
  await act(async () => pop.querySelector<HTMLElement>('[data-testid="plan-project-settings"]')!.click());
  expect(p.onSettings).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-testid="plan-usage"]'), "the dialog opens: the popover closes").toBeNull();
});

it("global scope popover: no Project line, no Global row, no Project settings link", async () => {
  const pop = await open(await render({ ...usage, account: "bad" }, accounts));
  expect(pop.querySelector('[data-testid="plan-project"]')).toBeNull();
  expect(pop.querySelector('[data-testid="plan-project-settings"]')).toBeNull();
  expect(pop.querySelectorAll('[data-testid="plan-account-option"]')).toHaveLength(2);
});
