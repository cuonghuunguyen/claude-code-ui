// @vitest-environment jsdom
// OpenCode in App: model lists per folder side, refetch after a provider change, no Claude-only plan meter (GH-665).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OPENCODE_CAPABILITIES } from "../../daemon/src/opencode-engine.ts";
import { tabHash, NEW_TAB } from "./tabs.ts";
import { ALL_CAPABILITIES, type SessionListItem } from "@claude-ui/protocol";

Element.prototype.scrollIntoView ??= () => {};
window.matchMedia = ((query: string) => ({ matches: /min-width: (\d+)px/.test(query) ? 1440 >= +/min-width: (\d+)px/.exec(query)![1]! : false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;

const CLAUDE = "11111111-2222-3333-4444-555555555555";
const OC = "ses_0123456789abcdefghijklmnop";
const item = (id: string, engine: "claude" | "opencode"): SessionListItem => ({ id, cwd: "/p/demo", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"], title: engine === "opencode" ? "OpenCode chat" : "Claude chat", lastActivity: 0, archived: false, transcript: true, engine, capabilities: engine === "opencode" ? OPENCODE_CAPABILITIES : ALL_CAPABILITIES });
const oc = (modes: string[]) => ({ engine: "opencode", capabilities: OPENCODE_CAPABILITIES, permissionModes: modes });
const claude = { engine: "claude", capabilities: ALL_CAPABILITIES, permissionModes: ["default"] };
let list: Record<string, unknown> = {};
let settings: Record<string, unknown> = {};
let opts: { onOpenCodeProviders?: () => void; onPlanUsage?: (u: unknown) => void } = {};
/** Error messages the next OpenCode `models.list` replies reject with, in order. */
const modelFailures: string[] = [];
const sent: { type: string; [k: string]: unknown }[] = [];
vi.mock("@xterm/xterm", () => ({ Terminal: class { options = {}; cols = 80; rows = 24; loadAddon() {} open() {} focus() {} write() {} reset() {} onData() {} onResize() {} attachCustomKeyEventHandler() {} dispose() {} } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("./client.ts", async (orig) => ({
  ...(await orig<typeof import("./client.ts")>()),
  connect: (o: typeof opts & { onOpen?: () => void; onStatus?: (s: string) => void }) => {
    opts = o;
    queueMicrotask(() => (o.onStatus?.("connected"), o.onOpen?.()));
    return {
      request: async (m: { type: string; sessionId?: string }) => {
        sent.push(m);
        if (m.type === "session.list") return list;
        if (m.type === "settings.get") return { settings };
        if (m.type === "session.subscribe") return { logEpoch: "e1", seq: 0, session: (list.sessions as SessionListItem[]).find((s) => s.id === m.sessionId) };
        if (m.type === "models.list") {
          const failure = (m as { engine?: string }).engine === "opencode" ? modelFailures.shift() : undefined;
          if (failure) throw new Error(failure);
          return { models: [{ value: "default", displayName: "Default", description: "" }, ...((m as { engine?: string }).engine === "opencode" ? [{ value: "opencode/big-pickle", displayName: "Big Pickle", description: "", group: "OpenCode" }] : [])] };
        }
        return {};
      },
      onFsChanged: () => () => {},
      onTerminal: () => () => {},
      close() {},
    };
  },
}));
const { App } = await import("./App.tsx");

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));
async function mount(hash: string) {
  location.hash = hash;
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
  await settle();
}
const open = (title: string) => act(async () => (document.querySelector<HTMLElement>(`[title="${title}"]`) ?? [...el.querySelectorAll<HTMLElement>("*")].find((e) => e.children.length === 0 && e.textContent === title))!.click());
const modelRequests = () => sent.filter((m) => m.type === "models.list" && m.engine === "opencode");
beforeEach(() => {
  sent.length = 0;
  modelFailures.length = 0;
  localStorage.clear();
  document.hasFocus = () => true;
  settings = { orchestration: {}, labels: { projects: {}, sides: {} }, sessions: { engine: "claude" } };
  list = { sessions: [item(CLAUDE, "claude"), item(OC, "opencode")], projects: ["/p/demo"], engines: [claude, oc(["default"])] };
});
afterEach(() => (act(() => root.unmount()), el.remove()));

it("a new-session draft in a side folder asks that side for the OpenCode models, a local one asks the hub", async () => {
  settings = { ...settings, sessions: { engine: "opencode" } };
  list = { sessions: [], projects: ["/p/side"], engines: [claude, oc(["default"])], sideEngines: { "wsl:Ubuntu": [claude, oc(["default", "bypassPermissions"])] }, cwdSides: { "/p/side": "wsl:Ubuntu" }, sides: [{ id: "local", label: "Local", state: "ready" }, { id: "wsl:Ubuntu", label: "Ubuntu", state: "ready" }] };
  await mount(tabHash(NEW_TAB));
  expect(modelRequests()).toContainEqual({ type: "models.list", engine: "opencode", cwd: "/p/side" });

  // The provider set changed: every OpenCode list is asked again, also the side's.
  const before = modelRequests().length;
  await act(async () => opts.onOpenCodeProviders!());
  await settle();
  expect(modelRequests().length).toBe(before + 1);
});

it("an OpenCode session asks for its models once and again after a provider change; it has no plan meter, a Claude session has", async () => {
  await mount("");
  await open("OpenCode chat");
  await settle();
  expect(modelRequests()).toEqual([{ type: "models.list", engine: "opencode", cwd: "/p/demo" }]);
  await act(async () => opts.onPlanUsage!({ plan: "pro", windows: [{ kind: "session", label: "Session", percent: 10, active: true }], status: "allowed" }));
  expect(el.querySelector('[data-testid="plan-meter"]')).toBeNull();
  await act(async () => opts.onOpenCodeProviders!());
  await settle();
  expect(modelRequests()).toHaveLength(2);
  act(() => root.unmount());
  el.remove();
  await mount("");
  await open("Claude chat");
  await settle();
  await act(async () => opts.onPlanUsage!({ plan: "pro", windows: [{ kind: "session", label: "Session", percent: 10, active: true }], status: "allowed" }));
  expect(el.querySelector('[data-testid="plan-meter"]')).not.toBeNull();
});

const pickerOpen = async () => {
  await act(async () => document.querySelector<HTMLElement>('[data-testid="session-model"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
};

it("a failed OpenCode model list shows the error and Retry in the model picker; Retry asks again and shows the list (GH-679)", async () => {
  modelFailures.push("models_failed: OpenCode GET /config/providers answered 499");
  await mount("");
  await open("OpenCode chat");
  await settle();
  await pickerOpen();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Models could not be loaded");
  expect(modelRequests()).toHaveLength(1);
  await act(async () => document.querySelector<HTMLElement>('[data-testid="models-retry"]')!.click());
  await settle();
  expect(modelRequests()).toHaveLength(2);
  await pickerOpen();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.body.textContent).toContain("Big Pickle");
  expect(document.body.textContent).toContain("OpenCode");
});

it("the OpenCode model picker links to Settings › OpenCode; a Claude session's picker has no link (GH-679)", async () => {
  await mount("");
  await open("OpenCode chat");
  await settle();
  await pickerOpen();
  const connect = document.querySelector<HTMLElement>('[data-testid="models-connect"]')!;
  expect(connect.textContent).toContain("Connect a provider");
  await act(async () => connect.click());
  await settle();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="session-model"]')!.getAttribute("aria-expanded")).toBe("false");
  act(() => root.unmount());
  el.remove();
  document.body.innerHTML = "";
  await mount("");
  await open("Claude chat");
  await settle();
  await pickerOpen();
  expect(document.querySelector('[data-testid="models-connect"]')).toBeNull();
});
