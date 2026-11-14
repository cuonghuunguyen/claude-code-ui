// @vitest-environment jsdom
// GH-774: a session tab with no view yet shows the session skeleton, replaced in place by the pane.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";

Element.prototype.scrollIntoView ??= () => {};
let width = 1440;
const matches = (query: string) => {
  const min = /min-width: (\d+)px/.exec(query);
  if (min) return width >= +min[1]!;
  const max = /width < (\d+(?:\.\d+)?)rem/.exec(query);
  return max ? width < +max[1]! * 16 : false;
};
window.matchMedia = ((query: string) => ({
  get matches() {
    return matches(query);
  },
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})) as never;

const OLD = "11111111-2222-3333-4444-555555555555";
const PARTNER = "22222222-2222-3333-4444-555555555555";
const info = { id: OLD, cwd: "/p/demo", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"] };
const item = (id: string, title: string, over: object = {}): SessionListItem => ({ ...info, id, title, lastActivity: 0, archived: false, transcript: true, ...over }) as SessionListItem;
const defer = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const replies: Record<string, unknown> = {};
vi.mock("@xterm/xterm", () => ({ Terminal: class { options = {}; cols = 80; rows = 24; loadAddon() {} open() {} focus() {} write() {} reset() {} onData() {} onResize() {} onSelectionChange() {} onScroll() {} attachCustomKeyEventHandler() {} dispose() {} } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
const sent: { type: string; sessionId?: string }[] = [];
vi.mock("./client.ts", async (orig) => ({
  ...(await orig<typeof import("./client.ts")>()),
  connect: (opts: { onEvents: (es: unknown[]) => void; onOpen?: () => void; onStatus?: (s: string) => void }) => {
    queueMicrotask(() => (opts.onStatus?.("connected"), opts.onOpen?.()));
    return {
      request: async (m: { type: string }) => (sent.push(m), typeof replies[m.type] === "function" ? (replies[m.type] as (m: unknown) => unknown)(m) : (replies[m.type] ?? {})),
      onFsChanged: () => () => {},
      onTerminal: () => () => {},
      close() {},
    };
  },
}));
const { App } = await import("./App.tsx");
const { saveSplit } = await import("./split.ts");
const { saveTabs } = await import("./tabs.ts");

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const hiddenTab = "[hidden], [style*='display: none']";
const visible = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)].filter((n) => !n.closest(hiddenTab));
const one = <T extends Element = HTMLElement>(sel: string) => visible<T>(sel)[0];
const mount = async (hash: string) => {
  location.hash = hash;
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
};
const settle = () => act(async () => {});
const OPEN = "Open or create a session to start.";
const subscribed = (id: string) => sent.some((m) => m.type === "session.subscribe" && m.sessionId === id);

beforeEach(() => {
  width = 1440;
  sent.length = 0;
  localStorage.clear();
  for (const k of Object.keys(replies)) delete replies[k];
  Object.assign(replies, {
    "session.list": { sessions: [item(OLD, "Old")], projects: ["/p/demo"] },
    "models.list": { models: [] },
    "session.defaultMode": { mode: "default" },
    "fs.list": { entries: [] },
    "fs.search": { paths: [] },
  });
});
afterEach(() => (act(() => root.unmount()), el.remove()));

describe("session skeleton", () => {
  it("a listed tab with no view shows the session skeleton, then the session pane in place", async () => {
    const sub = defer<unknown>();
    replies["session.subscribe"] = () => sub.promise;
    await mount("#" + OLD);
    const sk = one('[data-testid="session-skeleton"]')!;
    expect(sk).toBeTruthy();
    expect(sk.getAttribute("aria-busy")).toBe("true");
    expect(sk.querySelector('[data-testid="prompt-skeleton"]')).toBeTruthy();
    expect(sk.querySelector('[data-testid="session-project"]')?.textContent).toBe("demo");
    expect(el.textContent).not.toContain(OPEN);
    const wrap = one(`[data-testid="session-area"] [data-session-id="${OLD}"]`)!;
    expect(wrap).toBeTruthy();
    await act(async () => sub.resolve({ logEpoch: "e1", seq: 0, session: info, title: "Old" }));
    await settle();
    expect(visible('[data-testid="session-skeleton"]')).toHaveLength(0);
    expect(one(`[data-testid="session-area"] [data-session-id="${OLD}"]`)).toBe(wrap);
    expect(one('textarea[aria-label="Prompt"]')).toBeTruthy();
    expect(wrap.querySelector('[data-testid="session-header"]')).toBeTruthy();
  });

  it("before the session list arrives the skeleton shows placeholder header bars", async () => {
    const list = defer<unknown>();
    const sub = defer<unknown>();
    replies["session.list"] = () => list.promise;
    replies["session.subscribe"] = () => sub.promise;
    await mount("#" + OLD);
    expect(one('[data-testid="session-skeleton"]')).toBeTruthy();
    expect(one('[data-testid="session-project"]')).toBeUndefined();
    expect(el.textContent).not.toContain(OPEN);
    await act(async () => list.resolve({ sessions: [item(OLD, "Old")], projects: ["/p/demo"] }));
    await act(async () => sub.resolve({ logEpoch: "e1", seq: 0, session: info, title: "Old" }));
    await settle();
    expect(visible('[data-testid="session-skeleton"]')).toHaveLength(0);
    expect(one('textarea[aria-label="Prompt"]')).toBeTruthy();
  });

  it("a failed subscribe ends the skeleton", async () => {
    replies["session.subscribe"] = () => Promise.reject(new Error("boom"));
    await mount("#" + OLD);
    await settle();
    expect(visible('[data-testid="session-skeleton"]')).toHaveLength(0);
    expect(el.textContent).toContain(OPEN);
  });

  it("a session the daemon does not know closes its tab, no skeleton stays", async () => {
    replies["session.subscribe"] = () => Promise.reject(Object.assign(new Error("gone"), { code: "unknown_session" }));
    await mount("#" + OLD);
    await settle();
    expect(visible('[data-testid="session-skeleton"]')).toHaveLength(0);
    expect(document.querySelector(`[data-testid="session-area"] [data-session-id="${OLD}"]`)).toBeNull();
  });

  it("a split restored by a reload subscribes its idle, not live partner and shows its skeleton", async () => {
    const partner = defer<unknown>();
    replies["session.list"] = { sessions: [item(OLD, "Old"), item(PARTNER, "Partner", { live: false })], projects: ["/p/demo"] };
    replies["session.subscribe"] = (m: unknown) => ((m as { sessionId: string }).sessionId === PARTNER ? partner.promise : { logEpoch: "e1", seq: 0, session: info, title: "Old" });
    saveTabs([OLD, PARTNER]);
    saveSplit({ ids: [OLD, PARTNER], dir: "row", ratio: 0.5, at: 0 } as never);
    await mount("#" + OLD);
    expect(subscribed(PARTNER)).toBe(true);
    expect(one('[data-testid="session-area"] [data-testid="session-skeleton"]')).toBeTruthy();
    await act(async () => partner.resolve({ logEpoch: "e1", seq: 0, session: { ...info, id: PARTNER }, title: "Partner" }));
    await settle();
    expect(visible('[data-testid="session-skeleton"]')).toHaveLength(0);
    expect(visible('textarea[aria-label="Prompt"]').length).toBe(2);
  });

  it("on a phone the skeleton has no header", async () => {
    width = 390;
    replies["session.subscribe"] = () => new Promise(() => {});
    await mount("#" + OLD);
    const sk = one('[data-testid="session-skeleton"]')!;
    expect(sk).toBeTruthy();
    expect(sk.querySelector('[data-testid="session-header"]')).toBeNull();
    expect(sk.querySelector('[data-testid="prompt-skeleton"]')).toBeTruthy();
  });
});
