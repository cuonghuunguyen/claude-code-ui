// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SkillRow, SlashCommand } from "@claude-ui/protocol";
import type { Request } from "./client.ts";
import { SkillsDialog } from "./skills-dialog.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const skill = (name: string, over: Partial<SkillRow> = {}): SkillRow => ({ name, displayName: name, description: `${name} desc`, source: "user", tokens: 100, state: "on", advertised: true, handles: {}, ...over });
const SKILLS: SkillRow[] = [
  skill("probe", { source: "project", tokens: 17 }),
  skill("review-pr", { source: "user", tokens: 285 }),
  skill("ponytail:ponytail", { source: "plugin", tokens: 281, lockedBy: "plugin", handles: { aliases: ["ponytail"] } }),
  skill("hidden", { source: "user", tokens: 40, state: "off", advertised: false }),
  skill("fixed", { source: "user", state: "name-only", lockedBy: "reserved-name" }),
];
const cmd = (name: string, description: string, argumentHint = ""): SlashCommand => ({ name, description, argumentHint });
const COMMANDS = [cmd("compact", "Shrink the transcript"), cmd("probe", "Probe skill"), cmd("review-pr", "Review a PR", "<pr>"), cmd("ponytail:ponytail", "Lazy")];

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

type Handler = (msg: Request) => unknown;
async function render(handlers: Record<string, Handler> = {}, commands = COMMANDS) {
  let skills = structuredClone(SKILLS);
  const calls: Request[] = [];
  const request = vi.fn(async (msg: Request) => {
    calls.push(msg);
    const h = handlers[msg.type];
    if (h) return h(msg);
    if (msg.type === "skills.list") return { skills };
    if (msg.type === "skills.setState") {
      const m = msg as { name: string; state: string };
      skills = skills.map((s) => (s.name === m.name ? { ...s, state: m.state } : s));
      return { skills, confirmed: true };
    }
    return {};
  });
  const el = document.createElement("div");
  document.body.append(el);
  const prompt = document.createElement("textarea");
  prompt.setAttribute("aria-label", "Prompt");
  Object.defineProperty(prompt, "offsetParent", { get: () => document.body });
  document.body.append(prompt);
  const runs: unknown[] = [];
  let setOpen!: (o: boolean) => void;
  function Host() {
    const [open, set] = useState(true);
    setOpen = set;
    return <SkillsDialog open={open} cwd="/p" sessionId="s1" commands={commands} request={request as never} onRun={(r) => runs.push(r)} onClose={() => set(false)} />;
  }
  root = createRoot(el);
  await act(async () => root!.render(<Host />));
  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const text = () => q("skills-dialog")?.textContent ?? "";
  const click = (e: HTMLElement | null | undefined) => act(async () => void e!.click());
  const type = async (e: HTMLElement, v: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(e, v);
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const state = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  return { q, all, text, click, type, state, calls, runs, setOpen };
}

// The first dialog render loads Base UI cold.
it("lists commands with their skills: meta text, state buttons, locks, inert rows last; ordered by source then name", { timeout: 20_000 }, async () => {
  const d = await render();
  expect(d.calls[0]).toEqual({ type: "skills.list", cwd: "/p", sessionId: "s1" });
  expect(d.text()).toContain("Slash commands");
  expect(d.all("skills-row").map((r) => r.textContent)).toEqual([
    "/compactShrink the transcript",
    "/ponytail:ponytailplugin · ~281 tokensOn · locked",
    "/probeproject · < 20 tokensOn",
    "/review-pruser · ~285 tokensOn",
    "/fixeduser · ~100 tokensName only · locked",
    "/hiddenuser · ~40 tokensOff",
  ]);
  expect(d.all("skills-inert").map((r) => r.textContent)).toEqual(["/fixeduser · ~100 tokens", "/hiddenuser · ~40 tokens"]);
});

it("state button: tooltip, cycle to the next state, 'Saving…' while saving, then the daemon's rows", async () => {
  let release!: (v: unknown) => void;
  const d = await render({ "skills.setState": () => new Promise((r) => (release = r)) });
  const btn = d.state("/probe: On");
  expect(btn.title).toBe("Claude sees it and you can invoke it. Click to change.");
  await d.click(btn);
  expect(d.calls.at(-1)).toEqual({ type: "skills.setState", cwd: "/p", sessionId: "s1", name: "probe", state: "name-only", handles: {} });
  expect(btn.textContent).toBe("Saving…");
  // One save at a time.
  expect(d.all("skills-state").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  await act(async () => release({ skills: SKILLS.map((s) => (s.name === "probe" ? { ...s, state: "name-only" } : s)), confirmed: true }));
  expect(d.state("/probe: Name only").textContent).toBe("Name only");
  expect(d.state("/probe: Name only").title).toBe("Claude sees only its name. Click to change.");
  expect(d.q("banner-success")).toBeNull();
});

it("cycles name-only → user-invocable-only → off → on", async () => {
  const d = await render();
  for (const [from, to] of [["On", "Name only"], ["Name only", "User only"], ["User only", "Off"], ["Off", "On"]] as const) {
    await d.click(d.state(`/probe: ${from}`));
    expect(d.state(`/probe: ${to}`)).toBeTruthy();
  }
  expect(d.calls.filter((c) => c.type === "skills.setState").map((c) => (c as { state: string }).state)).toEqual(["name-only", "user-invocable-only", "off", "on"]);
});

it("a hidden skill can be turned back on from its inert row", async () => {
  const d = await render();
  await d.click(d.state("/hidden: Off"));
  expect(d.calls.at(-1)).toMatchObject({ type: "skills.setState", name: "hidden", state: "on" });
});

it("locked rows have no button and the reason as tooltip", async () => {
  const d = await render();
  const locks = d.all("skills-lock");
  expect(locks.map((l) => [l.textContent, l.title])).toEqual([
    ["On · locked", "Controlled by its plugin"],
    ["Name only · locked", "This name can't be saved in settings; rename the skill's folder or file to change it"],
  ]);
  expect(d.state("/ponytail:ponytail: On")).toBeNull();
});

it("an unconfirmed save shows the 'Saved, but…' notice with the daemon's rows; a CLI timeout the 'took too long' one", async () => {
  const d = await render({ "skills.setState": () => ({ skills: SKILLS, confirmed: false }) });
  await d.click(d.state("/probe: On"));
  expect(d.q("banner-success")!.textContent).toBe("Saved. This session still has the old state and may not have reloaded yet; reopen the dialog to check.");
  expect(d.state("/probe: On")).toBeTruthy();
  await act(async () => root!.unmount());
  const slow = await render({ "skills.setState": () => Promise.reject(Object.assign(new Error("Claude CLI timed out after 30s"), { code: "cli_timeout" })) });
  await slow.click(slow.state("/probe: On"));
  expect(slow.q("banner-success")!.textContent).toBe("No confirmation from Claude Code in time; this session still has the old state. Retry, or reopen the dialog to check.");
  expect(slow.calls.filter((c) => c.type === "skills.list")).toHaveLength(2);
});

it("another failure shows the error and re-reads the list", async () => {
  const d = await render({ "skills.setState": () => Promise.reject(new Error("This setting cannot be changed")) });
  await d.click(d.state("/probe: On"));
  expect(d.q("banner-error")!.textContent).toBe("This setting cannot be changed");
  expect(d.state("/probe: On")).toBeTruthy();
});

it("filters by name, description and source; texts for no match and for nothing at all", async () => {
  const d = await render();
  await d.type(d.q("skills-filter")!, "/PRO");
  expect(d.all("skills-row").map((r) => r.querySelector("span")!.textContent)).toEqual(["/probe"]);
  await d.type(d.q("skills-filter")!, "plugin");
  expect(d.all("skills-row").map((r) => r.querySelector("span")!.textContent)).toEqual(["/ponytail:ponytail"]);
  await d.type(d.q("skills-filter")!, "zzz");
  expect(d.text()).toContain("No matching commands.");
  await act(async () => root!.unmount());
  const empty = await render({ "skills.list": () => ({ skills: [] }) }, []);
  expect(empty.text()).toContain("No slash commands available.");
});

it("clicking a command runs it as the picker does and closes the dialog; inert rows do not run", async () => {
  const d = await render();
  const rows = d.all("skills-row");
  await d.click(rows.find((r) => r.textContent!.startsWith("/review-pr"))!.querySelector("button"));
  expect(d.runs).toEqual([{ text: "/review-pr " }]);
  expect(d.q("skills-dialog")).toBeNull();
  await act(async () => d.setOpen(true));
  expect(d.all("skills-inert")[0]!.tagName).toBe("DIV");
  await d.click(d.all("skills-row")[0]!.querySelector("button"));
  expect(d.runs.at(-1)).toEqual({ send: "/compact" });
});

it("shows commands alone when the CLI has no skill list, and the load error with them", async () => {
  const d = await render({ "skills.list": () => ({ skills: [] }) });
  expect(d.all("skills-row").map((r) => r.querySelector("span")!.textContent)).toEqual(["/compact", "/ponytail:ponytail", "/probe", "/review-pr"]);
  await act(async () => root!.unmount());
  const bad = await render({ "skills.list": () => Promise.reject(new Error("boom")) });
  expect(bad.text()).toContain("Failed to load skills: boom");
  expect(bad.all("skills-row")).toHaveLength(COMMANDS.length);
});

it("rows and state buttons are 44 px high on phone and buttons for the keyboard; Esc closes", async () => {
  const d = await render();
  expect(d.all("skills-row")[1]!.querySelector("button")!.className).toContain("min-h-11");
  expect(d.all("skills-state")[0]!.className).toContain("max-md:h-11");
  await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(d.q("skills-dialog")).toBeNull();
});
