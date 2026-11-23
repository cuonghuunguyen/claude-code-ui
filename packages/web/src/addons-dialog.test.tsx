// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AddonCandidate, AddonInfo, AddonUpdateCheck, AddonsListResult } from "@claude-ui/protocol";
import type { Request } from "./client.ts";
import { AddonsDialog } from "./addons-dialog.tsx";
import { sourceKey, sourceText, type AddonLogEntry } from "./addons.ts";

const CAPS = ["session.read", "ui.pane", "render.fence:example", "net:https://api.github.com"];
const addon = (name: string, o: Partial<AddonInfo> = {}): AddonInfo => ({
  name,
  source: { kind: "git", url: "https://example.com/r.git", ref: "v1" },
  sha: "abcdef0123456789",
  approved: CAPS,
  state: "enabled",
  base: `/addon/${"0".repeat(32)}/${name}/`,
  manifest: { name, version: "1.2.0", description: `${name} addon`, capabilities: CAPS, themes: [{ id: "d", name: "Dusk" }], views: [{ id: "stats", title: "Stats", entry: "pane.html", kind: "pane" }], commands: [{ name: "cmd", description: "c" }], renderers: [{ fence: "example", entry: "r.html" }] },
  ...o,
});

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

type Handler = (msg: Request) => unknown;
async function render(list: AddonsListResult, handlers: Record<string, Handler> = {}, log = new Map<string, AddonLogEntry[]>(), onClearLog = vi.fn()) {
  const calls: Request[] = [];
  let current = list;
  const request = vi.fn(async (msg: Request) => {
    calls.push(msg);
    const h = handlers[msg.type];
    if (h) return h(msg);
    if (msg.type === "addons.list") return structuredClone(current);
    return {};
  });
  const el = document.createElement("div");
  document.body.append(el);
  function Host() {
    const [open, set] = useState(true);
    return <AddonsDialog open={open} log={log} onClearLog={onClearLog} request={request as never} onClose={() => set(false)} />;
  }
  root = createRoot(el);
  await act(async () => root!.render(<Host />));
  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const click = (e: HTMLElement | null | undefined) => act(async () => void e!.click());
  const type = (e: HTMLElement, v: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(e, v);
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
  return { calls, q, all, click, type, set: (l: AddonsListResult) => (current = l) };
}

const cand = (path: string, name: string, o: Partial<AddonCandidate> = {}): AddonCandidate => ({ path, name, version: "1.0.0", description: `${name} addon`, ...o });

it("a repository with one addon in a subfolder installs it at once with that path", async () => {
  const d = await render({ addons: [], picks: {} }, { "addons.discover": () => [cand("reze", "reze")], "addons.install": () => addon("reze", { state: "needs_approval", approved: [] }) });
  await d.type(d.q("addons-url")!, "https://example.com/r.git");
  await d.click(d.q("addons-install"));
  expect(d.calls).toContainEqual({ type: "addons.discover", source: { kind: "git", url: "https://example.com/r.git" } });
  expect(d.calls).toContainEqual({ type: "addons.install", source: { kind: "git", url: "https://example.com/r.git", path: "reze" } });
  expect(d.q("addons-pick")).toBeNull();
});

it("a repository without addon.json shows an error and installs nothing", async () => {
  const d = await render({ addons: [], picks: {} }, { "addons.discover": () => [] });
  await d.type(d.q("addons-url")!, "https://example.com/r.git");
  await d.click(d.q("addons-install"));
  expect(document.body.textContent).toContain("No addon.json found in the repository");
  expect(d.calls.some((c) => c.type === "addons.install")).toBe(false);
});

it("a repository with several addons shows a picker and installs only the checked ones, reporting a failure without stopping", async () => {
  const items = [cand("a", "alpha"), cand("b", "beta"), cand("c", "gamma"), cand("bad", "", { error: "addon.json is not valid JSON" })];
  const d = await render({ addons: [], picks: {} }, {
    "addons.discover": () => items,
    "addons.install": (m) => {
      const path = (m as { source: { path?: string } }).source.path;
      if (path === "a") throw new Error('addon "alpha" is already installed');
      return addon("gamma", { state: "needs_approval", approved: [] });
    },
  });
  await d.type(d.q("addons-url")!, "https://example.com/r.git");
  await d.click(d.q("addons-install"));
  expect(d.calls.some((c) => c.type === "addons.install")).toBe(false);
  const rows = d.all("addons-candidate");
  expect(rows).toHaveLength(4);
  const checks = d.all("addons-candidate-check") as HTMLInputElement[];
  expect(checks.map((c) => c.checked)).toEqual([false, false, false, false]);
  expect(checks[3]!.disabled).toBe(true);
  expect(rows[3]!.textContent).toContain("addon.json is not valid JSON");
  await d.click(checks[0]!);
  await d.click(checks[2]!);
  await d.click(d.q("addons-install-selected"));
  const installs = d.calls.filter((c) => c.type === "addons.install");
  expect(installs).toEqual([
    { type: "addons.install", source: { kind: "git", url: "https://example.com/r.git", path: "a" } },
    { type: "addons.install", source: { kind: "git", url: "https://example.com/r.git", path: "c" } },
  ]);
  expect(d.all("addons-candidate").map((r) => r.dataset.path)).toEqual(["a", "b", "bad"]);
  expect(d.all("addons-candidate-error")[0]!.textContent).toContain("already installed");
});

it("installs from a git URL and shows the approval card with the declared capabilities", async () => {
  const fresh = addon("example", { state: "needs_approval", approved: [] });
  const d = await render({ addons: [], picks: {} }, { "addons.discover": () => [cand("", "example")], "addons.install": () => ((d.set({ addons: [fresh], picks: {} }), fresh)) });
  await d.type(d.q("addons-url")!, "https://example.com/r.git");
  await d.type(d.q("addons-ref")!, "v1");
  await d.click(d.q("addons-install"));
  expect(d.calls).toContainEqual({ type: "addons.install", source: { kind: "git", url: "https://example.com/r.git", ref: "v1" } });
  const card = d.q("addons-approve-card")!;
  expect(card.textContent).toContain("Approve example?");
  expect(d.all("addons-capability").map((c) => c.textContent)).toEqual([
    "Read the messages and tool results of the session",
    "Show panes next to the conversation",
    "Draw ```example code blocks",
    "Connect to https://api.github.com",
  ]);
  expect(card.textContent).toContain("Dusk");
  expect(card.textContent).toContain("Stats (pane)");
  expect(card.textContent).toContain("/example:cmd");
  expect(d.all("addons-row")).toHaveLength(0);
});

it("a local folder install sends the path", async () => {
  const d = await render({ addons: [], picks: {} }, { "addons.install": () => addon("example", { state: "needs_approval", approved: [] }) });
  await d.click(d.q("addons-source-local"));
  await d.type(d.q("addons-path")!, "/work/addon");
  await d.click(d.q("addons-install"));
  expect(d.calls).toContainEqual({ type: "addons.install", source: { kind: "local", path: "/work/addon" } });
});

it("approve sends addons.approve with the declared set", async () => {
  const fresh = addon("example", { state: "needs_approval", approved: [] });
  const d = await render({ addons: [fresh], picks: {} }, { "addons.discover": () => [cand("", "example")], "addons.install": () => fresh });
  await d.click(d.q("addons-source-git"));
  await d.type(d.q("addons-url")!, "https://example.com/r.git");
  await d.click(d.q("addons-install"));
  await d.click(d.q("addons-approve"));
  expect(d.calls).toContainEqual({ type: "addons.approve", name: "example", capabilities: CAPS });
});

it("a needs_approval row shows added and removed capabilities", async () => {
  const d = await render({ addons: [addon("example", { state: "needs_approval", approved: ["session.read", "ui.pane", "ui.toast"], manifest: { ...addon("example").manifest!, capabilities: ["session.read", "ui.pane", "ui.band"] } })], picks: {} });
  const diff = d.q("addons-diff")!.textContent!;
  expect(diff).toContain("+ ui.band");
  expect(diff).toContain("− ui.toast");
  expect(d.q("addons-state")!.textContent).toBe("Needs approval");
  expect(d.q("addons-enabled")).toBeNull();
  await d.click(d.q("addons-approve"));
  expect(d.calls.at(-2)).toMatchObject({ type: "addons.approve", capabilities: ["session.read", "ui.pane", "ui.band"] });
});

it("an addon row lists its lint warnings under Checks, with the file, line and the fix; an addon without findings has no Checks", async () => {
  const lint: AddonInfo["lint"] = [
    { level: "warning", code: "selects-testid", file: "dusk.css", line: 3, count: 2 },
    { level: "warning", code: "unknown-part", file: "dusk.css", line: 9, name: "sidebr" },
    { level: "warning", code: "unprefixed-name", file: "dusk.css", line: 12, name: "spin", suggest: "dusk-spin" },
    { level: "warning", code: "top-level-css", file: "legacy.css" },
    { level: "warning", code: "unknown-part", file: "dusk.css", line: 4, name: "tabs", suggest: "tab" },
    { level: "warning", code: "low-contrast", name: "dusk: fg on bg 3.3:1 (dark)" },
    { level: "warning", code: "css-large", file: "dusk.css" },
    { level: "warning", code: "deprecated-part", file: "dusk.css", line: 5, name: "tab", until: "1.7" },
    { level: "warning", code: "asset-missing", file: "art/dark.png", name: "bg-dark" },
    { level: "warning", code: "asset-large", file: "art/big.jpg", name: "big", count: 3072 },
    { level: "warning", code: "extends-missing", name: "gojo", suggest: "base:night" },
  ];
  const d = await render({ addons: [addon("themed", { lint }), addon("plain")], picks: {} });
  const rows = d.all("addons-row");
  const checks = rows[0]!.querySelector<HTMLElement>('[data-testid="addons-checks"]')!;
  expect(checks.textContent).toContain("Checks (11)");
  const items = [...checks.querySelectorAll("li")].map((li) => li.textContent);
  expect(items).toHaveLength(11);
  expect(items[0]).toContain("dusk.css line 3");
  expect(items[0]).toContain("[data-part]");
  expect(items[1]).toContain('"sidebr"');
  expect(items[2]).toContain('"dusk-spin"');
  expect(items[3]).toContain("themes[].css");
  expect(items[4]).toContain('Did you mean "tab"?');
  expect(items[5]).toContain("fg on bg 3.3:1 (dark)");
  expect(items[6]).toContain("256 KB");
  expect(items[7]).toContain("removed in 1.7");
  expect(items[8]).toContain('"bg-dark" (art/dark.png) is not in the addon folder');
  expect(items[9]).toContain("3072 KB");
  expect(items[10]).toContain('Theme "gojo" extends "base:night"');
  expect(rows[1]!.querySelector('[data-testid="addons-checks"]')).toBeNull();
});

it("an addon that needs a newer Claude UI shows the reason (not the dev last-good note), stays listed and a git one can still check for an update", async () => {
  const d = await render({ addons: [addon("needy", { state: "error", error: "needs Claude UI >=1.6 (this is 1.5.0)" })], picks: {} });
  const row = d.all("addons-row")[0]!;
  expect(row.textContent).toContain("needs Claude UI >=1.6 (this is 1.5.0)");
  expect(row.textContent).not.toContain("last good manifest");
  expect(row.textContent).toContain("needy addon");
  expect(row.querySelector('[data-testid="addons-check-update"]')).not.toBeNull();
});

it("the switch enables and disables; uninstall asks first", async () => {
  const d = await render({ addons: [addon("example")], picks: {} });
  await d.click(d.q("addons-enabled"));
  expect(d.calls).toContainEqual({ type: "addons.setEnabled", name: "example", enabled: false });
  await d.click(d.q("addons-uninstall"));
  expect(d.calls.some((c) => c.type === "addons.uninstall")).toBe(false);
  await d.click(d.q("addons-remove"));
  expect(d.calls).toContainEqual({ type: "addons.uninstall", name: "example" });
});

it("dev mode: the switch is for local folders only; an addon.json error shows beside the last good manifest", async () => {
  const local = { ...addon("mine"), source: { kind: "local" as const, path: "/x/mine" }, dev: true, rev: 5, error: "addon.json: bad JSON" };
  const d = await render({ addons: [local, addon("example")], picks: {} });
  const rows = d.all("addons-row");
  expect(rows[0]!.querySelector('[data-testid="addons-error"]')!.textContent).toContain("bad JSON");
  expect(rows[1]!.querySelector('[data-testid="addons-dev"]')).toBeNull();
  await d.click(rows[0]!.querySelector<HTMLElement>('[data-testid="addons-dev"]')!);
  expect(d.calls).toContainEqual({ type: "addons.setDev", name: "mine", dev: false });
});

it("check for updates shows current and latest SHAs and the capability diff", async () => {
  const check: AddonUpdateCheck = { name: "example", current: "abcdef0123456789", latest: "1234567890abcdef", added: ["ui.toast"], removed: ["ui.band"] };
  const d = await render({ addons: [addon("example")], picks: {} }, { "addons.checkUpdate": () => check });
  await d.click(d.q("addons-check-update"));
  const c = d.q("addons-update-card")!.textContent!;
  expect(c).toContain("example: abcdef0 → 1234567");
  expect(c).toContain("+ ui.toast");
  expect(c).toContain("− ui.band");
  await d.click(d.q("addons-update"));
  expect(d.calls).toContainEqual({ type: "addons.update", name: "example", sha: "1234567890abcdef" });
});

it("check for updates with nothing new says so; a local folder has no update button", async () => {
  const d = await render({ addons: [addon("example"), addon("loc", { source: { kind: "local", path: "/w/loc" }, sha: undefined })], picks: {} }, { "addons.checkUpdate": () => ({ name: "example", current: "a", latest: "a", added: [], removed: [] }) });
  expect(d.all("addons-check-update")).toHaveLength(1);
  await d.click(d.q("addons-check-update"));
  expect(d.q("banner-success")!.textContent).toBe("example is up to date.");
  expect(d.all("addons-row")[1]!.textContent).toContain("folder: /w/loc");
});

it("two addons claiming one fence show the conflict picker and send pickRenderer", async () => {
  const d = await render({ addons: [addon("a"), addon("b")], picks: { "fence:example": "a" } });
  const sel = d.q("addons-pick-fence:example") as HTMLSelectElement;
  expect([...sel.options].map((o) => o.value)).toEqual(["a", "b"]);
  expect(sel.value).toBe("a");
  await act(async () => {
    sel.value = "b";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(d.calls).toContainEqual({ type: "addons.pickRenderer", target: "fence:example", name: "b" });
});

it("a row in error shows the error and no switch", async () => {
  const d = await render({ addons: [addon("gone", { state: "error", error: "addon.json not found", manifest: undefined, base: undefined })], picks: {} });
  expect(d.q("addons-error")!.textContent).toBe("addon.json not found");
  expect(d.q("addons-enabled")).toBeNull();
});

it("a subfolder addon shows its folder in the source and has its own key", () => {
  expect(sourceText({ source: { kind: "git", url: "https://example.com/r.git", path: "reze" }, sha: "abcdef0123" })).toBe("git: https://example.com/r.git (reze)@HEAD · abcdef0");
  expect(sourceKey({ kind: "git", url: "u", path: "a" })).not.toBe(sourceKey({ kind: "git", url: "u", path: "b" }));
});

it("the source URL is shown as the daemon sent it", async () => {
  const d = await render({ addons: [addon("example", { source: { kind: "git", url: "https://example.com/r.git" } })], picks: {} });
  expect(d.q("addons-row")!.textContent).toContain("git: https://example.com/r.git@HEAD · abcdef0");
});

it("the log of an addon lists its entries with their level, and Clear empties it", async () => {
  const onClearLog = vi.fn();
  const d = await render({ addons: [addon("example")], picks: {} }, {}, new Map([["example", [{ at: 1, level: "warn", text: "refused prompt.submit: no" }, { at: 2, level: "info", text: "hello" }]]]), onClearLog);
  expect(d.q("addons-log")!.textContent).toContain("prompt.submit");
  expect(d.all("addons-log-entry").map((e) => e.dataset.level)).toEqual(["warn", "info"]);
  await d.click(d.q("addons-log-clear"));
  expect(onClearLog).toHaveBeenCalledWith("example");
});
