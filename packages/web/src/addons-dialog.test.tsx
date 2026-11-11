// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AddonInfo, AddonUpdateCheck, AddonsListResult } from "@claude-ui/protocol";
import type { Request } from "./client.ts";
import { AddonsDialog } from "./addons-dialog.tsx";
import { capabilityDiff, rendererConflicts, type AddonLogEntry } from "./addons.ts";

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

it("installs from a git URL and shows the approval card with the declared capabilities", async () => {
  const fresh = addon("example", { state: "needs_approval", approved: [] });
  const d = await render({ addons: [], picks: {} }, { "addons.install": () => ((d.set({ addons: [fresh], picks: {} }), fresh)) });
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
  const d = await render({ addons: [fresh], picks: {} }, { "addons.install": () => fresh });
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

it("the switch enables and disables; uninstall asks first", async () => {
  const d = await render({ addons: [addon("example")], picks: {} });
  await d.click(d.q("addons-enabled"));
  expect(d.calls).toContainEqual({ type: "addons.setEnabled", name: "example", enabled: false });
  await d.click(d.q("addons-uninstall"));
  expect(d.calls.some((c) => c.type === "addons.uninstall")).toBe(false);
  await d.click(d.q("addons-remove"));
  expect(d.calls).toContainEqual({ type: "addons.uninstall", name: "example" });
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

it("capabilityDiff and rendererConflicts", () => {
  expect(capabilityDiff(["a", "b"], ["b", "c"])).toEqual({ added: ["a"], removed: ["c"] });
  expect(rendererConflicts([addon("b"), addon("a"), addon("c", { state: "disabled" })])).toEqual({ "fence:example": ["a", "b"] });
});
