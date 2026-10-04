// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { McpServerInfo } from "@claude-ui/protocol";
import type { Request } from "./client.ts";
import { McpDialog } from "./mcp-dialog.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SERVERS: McpServerInfo[] = [
  { name: "ctx", status: "connected", scope: "user", config: { type: "http", url: "https://x/mcp" }, tools: [{ name: "search", readOnly: true }, { name: "drop", destructive: true }] },
  { name: "broken", status: "failed", scope: "project", error: "Connection closed\nat x", config: { type: "stdio", command: "false" } },
  { name: "auth", status: "needs-auth", scope: "local", config: { type: "http", url: "https://y/mcp" } },
  { name: "off", status: "disabled", scope: "local", config: { type: "stdio", command: "x" } },
  { name: "drive", status: "connected", scope: "claudeai", config: { type: "claudeai-proxy", url: "https://claude.ai/x" } },
];

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
});

type Handler = (msg: Request) => unknown;
async function render(handlers: Record<string, Handler> = {}, props: { server?: string } = {}) {
  let servers = structuredClone(SERVERS);
  const calls: Request[] = [];
  const request = vi.fn(async (msg: Request) => {
    calls.push(msg);
    const h = handlers[msg.type];
    if (h) return h(msg);
    if (msg.type === "mcp.list") return { servers };
    return {};
  });
  const el = document.createElement("div");
  document.body.append(el);
  const prompt = document.createElement("textarea");
  prompt.setAttribute("aria-label", "Prompt");
  // jsdom has no layout: offsetParent is null for every element; the shown prompt box needs one.
  Object.defineProperty(prompt, "offsetParent", { get: () => document.body });
  document.body.append(prompt);
  let setOpen!: (o: boolean) => void;
  function Host() {
    const [open, set] = useState(true);
    setOpen = set;
    return <McpDialog open={open} cwd="/p" sessionId="s1" server={props.server} request={request as never} onClose={() => set(false)} />;
  }
  root = createRoot(el);
  await act(async () => root!.render(<Host />));
  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const text = () => q("mcp-dialog")?.textContent ?? "";
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
  const click = (el: HTMLElement | null | undefined) => act(async () => void el!.click());
  const type = async (el: HTMLElement, v: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  return { q, all, text, button, click, type, calls, request, prompt, setServers: (s: McpServerInfo[]) => (servers = s), setOpen };
}

// The first dialog render loads Base UI cold.
it("lists servers by scope with status icons and labels, disabled rows dimmed; filter and no match", { timeout: 20_000 }, async () => {
  const d = await render();
  expect(d.calls[0]).toEqual({ type: "mcp.list", cwd: "/p", sessionId: "s1" });
  expect(d.all("mcp-scope").map((e) => e.textContent)).toEqual(["Project (1)", "Local (2)", "User (1)", "claude.ai (1)"]);
  expect(d.all("mcp-row").map((r) => r.textContent)).toEqual(["broken✗Failed", "auth⚠Needs Auth", "off○Disabled", "ctx✓Connected", "drive✓Connected"]);
  expect(d.all("mcp-row")[2]!.className).toContain("opacity-60");
  expect(d.all("mcp-row")[0]!.getAttribute("role")).toBe("button");
  await d.type(d.q("mcp-filter")!, "zzz");
  expect(d.text()).toContain("No matching servers.");
  await d.type(d.q("mcp-filter")!, "c");
  expect(d.all("mcp-row").map((r) => r.querySelector("span")!.textContent)).toEqual(["ctx"]);
});

it("shows loading, empty and load error states with Retry", async () => {
  let fail = true;
  const d = await render({ "mcp.list": () => (fail ? Promise.reject(new Error("boom")) : { servers: [] }) });
  expect(d.text()).toContain("Failed to load servers: boom");
  expect(d.text()).toContain("Retry");
  fail = false;
  await d.click(d.button("Retry"));
  expect(d.text()).toContain("No MCP servers configured.");
  expect(d.button("Add server")).toBeTruthy();
});

it("opens a server with Enter: back link, error first line, actions per status with busy labels and banners", async () => {
  let release!: () => void;
  const d = await render({ "mcp.reconnect": () => new Promise<void>((r) => (release = r)) });
  const broken = d.all("mcp-row")[0]!;
  await act(async () => void broken.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(d.text()).toContain("← Back to list");
  expect(d.text()).toContain("Connection closed");
  expect(d.text()).not.toContain("at x");
  expect(d.all("mcp-detail")[0]!.querySelectorAll("button").length).toBeGreaterThan(0);
  expect(d.button("Authenticate")).toBeUndefined();
  expect(["Reconnect", "Disable", "Remove"].every((l) => d.button(l))).toBe(true);
  await d.click(d.button("Reconnect"));
  expect(d.button("Reconnecting…")).toBeTruthy();
  await act(async () => release());
  expect(d.calls.find((c) => c.type === "mcp.reconnect")).toEqual({ type: "mcp.reconnect", cwd: "/p", sessionId: "s1", name: "broken" });
  expect(d.q("banner-success")!.textContent).toBe("Reconnected to broken");
  await d.click(d.button("← Back to list"));
  expect(d.all("mcp-row")).toHaveLength(5);
});

it("connected HTTP server: Clear authentication, Disable with its banner, tools with annotation badges", async () => {
  const d = await render({ "mcp.clearAuth": () => Promise.reject(new Error("")) }, { server: "ctx" });
  expect(["Reconnect", "Clear authentication", "Disable"].every((l) => d.button(l))).toBe(true);
  await d.click(d.q("mcp-tools-toggle"));
  expect(d.all("mcp-tools")[0]!.textContent).toBe("searchread-onlydropdestructive");
  expect(d.q("mcp-tools-toggle")!.textContent).toBe("Hide tools ▴");
  await d.click(d.button("Clear authentication"));
  expect(d.q("banner-error")!.textContent).toBe("Failed to clear authentication");
  await d.click(d.button("Disable"));
  expect(d.calls.find((c) => c.type === "mcp.toggle")).toMatchObject({ name: "ctx", enabled: false });
  // Back on the list with the result.
  expect(d.q("banner-success")!.textContent).toBe("Disabled ctx");
  expect(d.q("mcp-detail")).toBeNull();
});

it("disabled server: only Enable; claude.ai server: no Remove", async () => {
  const d = await render({}, { server: "off" });
  expect(d.button("Enable")).toBeTruthy();
  expect(d.button("Disable")).toBeUndefined();
  await d.click(d.button("Enable"));
  expect(d.q("banner-success")!.textContent).toBe("Enabled off");
  await d.click(d.button("← Back to list"));
  await d.click(d.all("mcp-row").find((r) => r.textContent?.startsWith("drive")));
  expect(d.button("Remove")).toBeUndefined();
  expect(d.button("Clear authentication")).toBeUndefined();
});

it("Remove asks inline, then removes from its scope and returns to the list", async () => {
  const d = await render({}, { server: "auth" });
  await d.click(d.button("Remove"));
  expect(d.q("mcp-remove-confirm")!.textContent).toContain("Remove auth from local config?");
  await d.click(d.button("Cancel"));
  expect(d.q("mcp-remove-confirm")).toBeNull();
  await d.click(d.button("Remove"));
  d.setServers(SERVERS.filter((s) => s.name !== "auth"));
  await d.click(d.button("Confirm remove"));
  expect(d.calls.find((c) => c.type === "mcp.remove")).toEqual({ type: "mcp.remove", cwd: "/p", name: "auth", scope: "local" });
  expect(d.q("banner-success")!.textContent).toBe("Removed auth from local config. Running sessions keep it until restarted.");
  expect(d.all("mcp-row")).toHaveLength(4);
});

it("Authenticate opens the sign-in page, waits with Check connection and the paste field, polls every 2 s until connected", async () => {
  const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
  const open = vi.spyOn(window, "open").mockReturnValue(tab as never);
  let callbackOk = false;
  const d = await render(
    {
      "mcp.authenticate": () => ({ authUrl: "https://auth/x", requiresUserAction: true }),
      "mcp.oauthCallback": () => (callbackOk ? {} : Promise.reject(new Error("Invalid callback URL — no authorization code, or it belongs to a different sign-in attempt (state mismatch). The flow is still open; retry"))),
    },
    { server: "auth" },
  );
  vi.useFakeTimers();
  await d.click(d.button("Authenticate"));
  expect(open).toHaveBeenCalledWith("about:blank", "_blank");
  expect(tab.opener).toBeNull();
  expect(tab.location.href).toBe("https://auth/x");
  const wait = d.q("mcp-auth-wait")!;
  expect(wait.textContent).toContain("Completing authentication in browser…");
  expect(wait.textContent).toContain("If the redirect page shows a connection error, paste the URL from your browser's address bar:");
  expect((d.q("mcp-callback") as HTMLInputElement).placeholder).toBe("http://localhost:.../callback?code=...&state=...");
  expect(wait.querySelector("a")!.getAttribute("href")).toBe("https://auth/x");
  expect(wait.querySelector("a")!.className).toContain("max-md:min-h-11");
  expect(d.text()).toContain("Learn more about MCP");
  expect([...document.querySelectorAll("a")].find((x) => x.textContent === "Learn more about MCP")!.className).toContain("max-md:min-h-11");
  expect(d.button("Check connection")).toBeTruthy();
  expect(d.button("Authenticate")).toBeUndefined();
  await d.type(d.q("mcp-callback")!, "http://localhost:1/callback");
  await d.click(d.button("Submit"));
  expect(d.q("banner-error")!.textContent).toContain("Invalid callback URL");
  const lists = () => d.calls.filter((c) => c.type === "mcp.list").length;
  const before = lists();
  await act(async () => void vi.advanceTimersByTime(2000));
  expect(lists()).toBe(before + 1);
  d.setServers(SERVERS.map((s) => (s.name === "auth" ? { ...s, status: "connected" } : s)));
  await act(async () => void vi.advanceTimersByTime(2000));
  expect(d.q("mcp-auth-wait")).toBeNull();
  const after = lists();
  await act(async () => void vi.advanceTimersByTime(6000));
  expect(lists()).toBe(after);
  open.mockRestore();
});

it("polls every 5 s while a server is connecting", async () => {
  vi.useFakeTimers();
  const d = await render({ "mcp.list": () => ({ servers: [{ name: "p", status: "pending", scope: "user", config: { type: "stdio" } }] }) });
  const n = d.calls.length;
  await act(async () => void vi.advanceTimersByTime(5000));
  expect(d.calls.length).toBe(n + 1);
  expect(d.text()).toContain("◐Connecting…");
});

it("add form: validation texts, transports, project scope warning, submit and its banner", async () => {
  const d = await render({ "mcp.add": (m) => ((m as { name: string }).name === "dup" ? Promise.reject(new Error("MCP server dup already exists in local config")) : {}) });
  await d.click(d.q("mcp-add"));
  expect(d.text()).toContain("Add MCP server");
  await d.click(d.button("Add server"));
  expect(d.q("banner-error")!.textContent).toBe("Server name is required.");
  await d.type(document.getElementById("mcp-add-name")!, "my tools");
  await d.click(d.button("Add server"));
  expect(d.q("banner-error")!.textContent).toBe("Invalid name my tools. Names can only contain letters, numbers, hyphens, and underscores.");
  await d.type(document.getElementById("mcp-add-name")!, "tools");
  await d.type(document.getElementById("mcp-add-command")!, "npx");
  await d.type(document.getElementById("mcp-add-env")!, "A=1\nbad");
  await d.click(d.button("Add server"));
  expect(d.q("banner-error")!.textContent).toBe("Environment variables must be KEY=value (line 2).");
  await d.click([...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("HTTP (remote)")));
  expect(document.getElementById("mcp-add-command")).toBeNull();
  await d.type(document.getElementById("mcp-add-url")!, "https://x/mcp");
  await d.type(document.getElementById("mcp-add-headers")!, "nocolon");
  await d.click(d.button("Add server"));
  expect(d.q("banner-error")!.textContent).toBe('Headers must be "Header-Name: value" (line 1).');
  await d.type(document.getElementById("mcp-add-headers")!, "Authorization: Bearer t");
  await d.click([...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Project")));
  expect(d.text()).toContain("Saved to .mcp.json and shared with everyone who opens this project.");
  await d.click(d.button("Add server"));
  expect(d.calls.find((c) => c.type === "mcp.add")).toEqual({ type: "mcp.add", cwd: "/p", name: "tools", scope: "project", config: { transport: "http", url: "https://x/mcp", headers: ["Authorization: Bearer t"] } });
  expect(d.q("banner-success")!.textContent).toBe("Added tools to project config. It will be available in new sessions.");
  expect(d.q("mcp-add-form")).toBeNull();
  await d.click(d.q("mcp-add"));
  await d.type(document.getElementById("mcp-add-name")!, "dup");
  await d.type(document.getElementById("mcp-add-command")!, "x");
  await d.click(d.button("Add server"));
  expect(d.q("banner-error")!.textContent).toBe("MCP server dup already exists in local config");
});

it("Esc closes the dialog and returns the focus to the prompt box", async () => {
  const d = await render();
  await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  expect(d.q("mcp-dialog")).toBeNull();
  expect(document.activeElement).toBe(d.prompt);
});
