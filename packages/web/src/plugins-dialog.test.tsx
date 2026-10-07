// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginsListResult } from "@claude-ui/protocol";
import type { Request } from "./client.ts";
import { PluginsDialog } from "./plugins-dialog.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LIST: PluginsListResult = {
  installed: [
    { id: "ponytail@ponytail", scope: "user", enabled: true, description: "Lazy senior dev", mcpServers: ["lazy", "docs"], updatable: true },
    { id: "notes@synced", scope: "synced", enabled: false, updatable: false },
  ],
  available: [
    { pluginId: "small@m", name: "small", marketplaceName: "m", official: false, installCount: 12 },
    { pluginId: "big@claude-plugins-official", name: "big", description: "Git helper", marketplaceName: "claude-plugins-official", official: true, sourceUrl: "https://github.com/anthropics/claude-plugins-official/tree/main/plugins/big", installCount: 1234 },
  ],
  marketplaces: [
    { name: "claude-plugins-official", source: "github", repo: "anthropics/claude-plugins-official", official: true },
    { name: "local", source: "directory", path: "/home/me/mk", official: false },
  ],
};
const OK = { reload: { reloaded: 1, failed: [], errorCount: 0 } };

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

type Handler = (msg: Request) => unknown;
async function render(handlers: Record<string, Handler> = {}, props: { reloadFailed?: boolean; sessionId?: string } = { sessionId: "s1" }) {
  const calls: Request[] = [];
  const request = vi.fn(async (msg: Request) => {
    calls.push(msg);
    const h = handlers[msg.type];
    if (h) return h(msg);
    if (msg.type === "plugins.list") return structuredClone(LIST);
    if (msg.type === "mcp.list") return { servers: [{ name: "plugin:ponytail:lazy", status: "connected" }, { name: "docs", status: "failed", error: "boom" }] };
    if (msg.type.startsWith("plugins.") || msg.type === "marketplace.remove") return OK;
    return {};
  });
  const onClose = vi.fn();
  const onRestarted = vi.fn();
  const el = document.createElement("div");
  document.body.append(el);
  function Host() {
    const [open, set] = useState(true);
    return <PluginsDialog open={open} cwd="/p" sessionId={props.sessionId} reloadFailed={props.reloadFailed} request={request as never} onRestarted={onRestarted} onClose={() => (onClose(), set(false))} />;
  }
  root = createRoot(el);
  await act(async () => root!.render(<Host />));
  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const text = () => q("plugins-dialog")?.textContent ?? "";
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
  const click = (el: HTMLElement | null | undefined) => act(async () => void el!.click());
  const type = async (el: HTMLElement, v: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  return { calls, q, all, text, button, click, type, onClose, onRestarted };
}

it("shows tabs with counts and installed rows with dot, id, description, MCP chips, switch and the actions the rule allows", async () => {
  const d = await render();
  expect(d.q("plugins-tab-plugins")!.textContent).toBe("Plugins2");
  expect(d.q("plugins-tab-marketplaces")!.textContent).toBe("Marketplaces2");
  const [pony, notes] = d.all("plugin-installed");
  expect(pony!.textContent).toContain("ponytail@ponytail");
  expect(pony!.textContent).toContain("Lazy senior dev");
  expect(d.all("plugin-dot").map((x) => x.className.includes("bg-success"))).toEqual([true, false]);
  expect(d.all("plugin-mcp").map((c) => c.title)).toEqual(["lazy: connected", "docs: failed - boom"]);
  const sw = d.all("plugin-switch");
  expect(sw.map((s) => [s.getAttribute("aria-label"), s.getAttribute("aria-checked"), s.title])).toEqual([
    ["Enable ponytail@ponytail", "true", "Turn off (stays installed, does not load)"],
    ["Enable notes@synced", "false", "Enable plugin"],
  ]);
  // Update only for the user-scope marketplace plugin, not for the synced one.
  expect(pony!.querySelector('[aria-label="Update plugin"]')?.getAttribute("title")).toBe("Update to the newest version");
  expect(notes!.querySelector('[aria-label="Update plugin"]')).toBeNull();
  expect(notes!.querySelector('[aria-label="Uninstall notes@synced"]')?.getAttribute("title")).toBe("Uninstall");
});

it("toggles and uninstalls, then refreshes the list", async () => {
  const d = await render();
  await d.click(d.all("plugin-switch")[0]);
  expect(d.calls).toContainEqual({ type: "plugins.setEnabled", cwd: "/p", pluginId: "ponytail@ponytail", enabled: false });
  const lists = d.calls.filter((c) => c.type === "plugins.list").length;
  await d.click(d.button("Uninstall notes@synced"));
  expect(d.calls).toContainEqual({ type: "plugins.uninstall", cwd: "/p", pluginId: "notes@synced", scope: "synced" });
  expect(d.calls.filter((c) => c.type === "plugins.list").length).toBe(lists + 1);
});

it("the switch and Uninstall are disabled with a pending label while their request runs; a double click sends one request", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const d = await render({ "plugins.setEnabled": async () => (await gate, OK), "plugins.uninstall": async () => (await gate, OK) });
  const sw = d.all("plugin-switch")[0]!;
  // Both clicks in one task: the second sees the state from before the first.
  await act(async () => (sw.click(), sw.click()));
  expect(d.calls.filter((c) => c.type === "plugins.setEnabled")).toHaveLength(1);
  expect(sw.getAttribute("aria-label")).toBe("Disabling…");
  expect(sw.getAttribute("aria-disabled")).toBe("true");
  expect(d.q("plugin-pending")!.textContent).toBe("Disabling…");
  // Another plugin stays usable while the first one runs.
  await d.click(d.all("plugin-switch")[1]!);
  expect(d.calls.filter((c) => c.type === "plugins.setEnabled")).toHaveLength(2);
  await act(async () => release());
  expect(d.all("plugin-switch")[0]!.getAttribute("aria-label")).toBe("Enable ponytail@ponytail");
  await act(async () => root!.unmount());
  document.body.innerHTML = "";
  const gate2 = new Promise<void>((r) => (release = r));
  const d2 = await render({ "plugins.uninstall": async () => (await gate2, OK) });
  const un = d2.button("Uninstall notes@synced")!;
  await act(async () => (un.click(), un.click()));
  expect(d2.calls.filter((c) => c.type === "plugins.uninstall")).toHaveLength(1);
  expect(un.disabled).toBe(true);
  expect(un.getAttribute("aria-label")).toBe("Uninstalling…");
  await act(async () => release());
});

it("lists available plugins by installs with source and official badge, filters by search, installs through the scope picker", async () => {
  const d = await render();
  const rows = d.all("plugin-available");
  expect(rows.map((r) => r.querySelector("span")!.textContent)).toEqual(["big", "small"]);
  expect(rows[0]!.textContent).toContain("1.2k installs");
  expect(rows[0]!.textContent).toContain("from claude-plugins-official");
  expect(rows[0]!.querySelector('[title="Official Claude Code marketplace"]')).not.toBeNull();
  expect(rows[0]!.querySelector("a")!.href).toBe("https://github.com/anthropics/claude-plugins-official/tree/main/plugins/big");
  expect(rows[1]!.querySelector('[title="Official Claude Code marketplace"]')).toBeNull();
  // Meta lines are text: --faint is 3.95:1 in the light theme (icons only), --muted-foreground passes 4.5:1.
  expect(rows[0]!.querySelector(".text-faint")).toBeNull();
  expect(rows.map((r) => [...r.querySelectorAll("p, span")].filter((e) => /installs|^from |^Source:/.test(e.textContent ?? "") && !e.querySelector("p, span")).every((e) => e.classList.contains("text-muted-foreground")))).toEqual([true, true]);
  await d.type(d.q("plugins-search")!, "git");
  expect(d.all("plugin-available").length).toBe(1);
  await d.click(d.all("plugin-available")[0]!.querySelector("button"));
  const picker = d.q("plugin-scopes")!;
  expect(picker.textContent).toContain("Install, update and use only plugins you trust.");
  expect([...picker.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
    "Install for youYou, in every project",
    "Install for this projectEveryone on this project",
    "Install locallyOnly you, only this project",
    "Cancel",
  ]);
  await d.click([...picker.querySelectorAll("button")][2]);
  expect(d.calls).toContainEqual({ type: "plugins.install", cwd: "/p", pluginId: "big@claude-plugins-official", scope: "local" });
});

it("shows progress while a plugin installs (a git clone can take minutes) and blocks a second install", async () => {
  let finish!: (v: unknown) => void;
  const d = await render({ "plugins.install": () => new Promise((r) => (finish = r)) });
  await d.click(d.all("plugin-available")[0]!.querySelector("button"));
  await d.click(d.button("Install for youYou, in every project"));
  expect(d.q("plugins-installing")!.textContent).toBe("Installing big@claude-plugins-official…");
  expect(d.all("plugin-available").flatMap((r) => [...r.querySelectorAll("button")]).every((b) => b.disabled)).toBe(true);
  await act(async () => finish(OK));
  expect(d.q("plugins-installing")).toBeNull();
});

it("shows the install error line", async () => {
  const d = await render({
    "plugins.install": () => {
      throw new Error('Plugin "big" is already installed.');
    },
  });
  await d.click(d.all("plugin-available")[0]!.querySelector("button"));
  await d.click(d.button("Install for youYou, in every project"));
  expect(d.q("banner-error")!.textContent).toBe('Plugin "big" is already installed.');
});

it("updates: a notice when nothing changed, a dialog per failure kind with its actions", async () => {
  let next: unknown = { outcome: "ok", message: "ponytail is already at the latest version (4.9.0)." };
  const d = await render({ "plugins.update": () => next });
  await d.click(d.button("Update plugin"));
  expect(d.calls).toContainEqual({ type: "plugins.update", cwd: "/p", pluginId: "ponytail@ponytail", scope: "user" });
  expect(d.q("banner-success")!.textContent).toBe("ponytail is up to date.");
  next = { outcome: "failed", kind: "not_found", message: 'Plugin "ponytail" not found' };
  await d.click(d.button("Update plugin"));
  expect(d.q("plugins-update-failure")!.textContent).toContain("ponytail (local copy) has no ponytail");
  next = { outcome: "ok", reload: OK.reload };
  await d.click(d.button("Update marketplace and retry"));
  expect(d.calls).toContainEqual({ type: "marketplace.update", cwd: "/p", name: "ponytail" });
  expect(d.calls.filter((c) => c.type === "plugins.update").length).toBe(3);
  expect(d.q("plugins-update-failure")).toBeNull();
  next = { outcome: "failed", kind: "policy", message: "blocked" };
  await d.click(d.button("Update plugin"));
  expect(d.q("plugins-update-failure")!.textContent).toBe("Updating ponytail is not allowedA policy from your organization prevents this update.OK");
  await d.click(d.button("OK"));
  // "Turned off" for a plugin that is on reads as the generic failure.
  next = { outcome: "failed", kind: "disabled", message: "x" };
  await d.click(d.button("Update plugin"));
  expect(d.q("plugins-update-failure")!.textContent).toContain("Could not update ponytail");
  expect(d.button("Copy error")).toBeDefined();
});

it("shows the reload-failed dialog after a change, and Restart restarts those sessions", async () => {
  const d = await render({ "plugins.setEnabled": () => ({ reload: { reloaded: 0, failed: ["s1"], errorCount: 0 } }) });
  await d.click(d.all("plugin-switch")[1]);
  expect(d.q("plugins-reload-failed")!.textContent).toBe("Reload pluginsReloading plugins failed in this session.Try againRestartCancel");
  await d.click(d.button("Restart"));
  expect(d.calls).toContainEqual({ type: "plugins.restart", cwd: "/p", sessionId: "s1" });
  expect(d.onRestarted).toHaveBeenCalledWith(["s1"]);
  expect(d.onClose).toHaveBeenCalled();
});

it("shows the restart banner for a session whose reload failed", async () => {
  const d = await render({}, { sessionId: "s1", reloadFailed: true });
  expect(d.q("plugins-restart-banner")!.textContent).toBe("Plugin changes apply after Claude restartsRestart");
  await d.click(d.q("plugins-restart-banner")!.querySelector("button"));
  expect(d.calls).toContainEqual({ type: "plugins.restart", cwd: "/p", sessionId: "s1" });
});

it("explains loading, failure and empty states", async () => {
  let resolve!: (v: unknown) => void;
  const d = await render({ "plugins.list": () => new Promise((r) => (resolve = r)) });
  expect(d.text()).toContain("Loading plugins…");
  await d.click(d.q("plugins-tab-marketplaces"));
  expect(d.text()).toContain("Loading marketplaces…");
  await act(async () => resolve({ installed: [], available: [], marketplaces: [] }));
  expect(d.text()).toContain("No marketplaces yet. Add one above.");
  await d.click(d.q("plugins-tab-plugins"));
  expect(d.text()).toContain("No plugins yet. Add a marketplace to find some.");
  act(() => root?.unmount());
  document.body.innerHTML = "";
  const e = await render({
    "plugins.list": () => {
      throw new Error("Claude CLI timed out after 30s");
    },
  });
  expect(e.text()).toContain("Failed to load plugins: Claude CLI timed out after 30s");
  await e.click(e.q("plugins-tab-marketplaces"));
  expect(e.text()).toContain("Failed to load marketplaces: Claude CLI timed out after 30s");
});

it("manages marketplaces: source text, add with Enter and its error, refresh, remove after the inline confirm", async () => {
  let fail = true;
  const d = await render({
    "marketplace.add": () => {
      if (fail) throw new Error("Path does not exist: /x");
      return {};
    },
  });
  await d.click(d.q("plugins-tab-marketplaces"));
  const rows = d.all("marketplace-row");
  expect(rows.map((r) => r.textContent)).toEqual(["claude-plugins-officialGitHub: anthropics/claude-plugins-official", "localDirectory: /home/me/mk"]);
  expect(rows[0]!.querySelector("a")!.href).toBe("https://github.com/anthropics/claude-plugins-official");
  expect(rows[1]!.querySelector("a")).toBeNull();
  const input = d.q("marketplace-source")! as HTMLInputElement;
  expect(input.placeholder).toBe("GitHub repo, URL, or path…");
  await d.type(input, "/x");
  await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(d.calls).toContainEqual({ type: "marketplace.add", cwd: "/p", source: "/x" });
  expect(d.q("banner-error")!.textContent).toBe("Failed to add marketplace: Path does not exist: /x");
  // The error belongs to the tab it came from.
  await d.click(d.q("plugins-tab-plugins"));
  expect(d.q("banner-error")).toBeNull();
  await d.click(d.q("plugins-tab-marketplaces"));
  fail = false;
  await d.click(d.button("Add"));
  expect((d.q("marketplace-source") as HTMLInputElement).value).toBe("");
  await d.click(d.all("marketplace-row")[1]!.querySelector('[aria-label="Refresh marketplace"]') as HTMLElement);
  expect(d.calls).toContainEqual({ type: "marketplace.update", cwd: "/p", name: "local" });
  await d.click(d.all("marketplace-row")[1]!.querySelector('[aria-label="Remove marketplace"]') as HTMLElement);
  expect(d.q("marketplace-remove-confirm")!.textContent).toBe("Remove local? Its plugins are uninstalled.RemoveCancel");
  expect(d.calls.some((c) => c.type === "marketplace.remove")).toBe(false);
  await d.click(d.button("Remove"));
  expect(d.calls).toContainEqual({ type: "marketplace.remove", cwd: "/p", name: "local" });
});
