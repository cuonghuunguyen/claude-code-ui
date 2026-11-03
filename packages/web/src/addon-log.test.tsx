// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AddonInfo } from "@claude-ui/protocol";
import { AddonFrame } from "./addon-frame.tsx";
import { AddonApiContext, LOG_KEY, useAddonLog, type AddonApi, type AddonLog, type LogOp } from "./addons.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => localStorage.clear());
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});
async function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(node));
  return el;
}

const stored = () => JSON.parse(localStorage.getItem(LOG_KEY) ?? "{}") as Record<string, { text: string }[]>;
const entry = (text: string) => ({ at: 1, level: "info" as const, text });

async function mountLog() {
  const h: { log: AddonLog; change: (op: LogOp) => void } = {} as never;
  function Probe() {
    [h.log, h.change] = useAddonLog();
    return null;
  }
  await mount(<Probe />);
  return h;
}

it("useAddonLog writes once per 300 ms and keeps writing while lines keep coming", async () => {
  vi.useFakeTimers();
  const h = await mountLog();
  act(() => h.change({ add: "a", entry: entry("1") }));
  expect(h.log.get("a")).toHaveLength(1);
  expect(localStorage.getItem(LOG_KEY)).toBeNull();
  act(() => void vi.advanceTimersByTime(200));
  act(() => h.change({ add: "a", entry: entry("2") }));
  act(() => void vi.advanceTimersByTime(100));
  expect(stored().a!.map((e) => e.text)).toEqual(["1", "2"]);
});

it("useAddonLog applies its own changes on top of what another tab saved, never over it", async () => {
  vi.useFakeTimers();
  const h = await mountLog();
  act(() => h.change({ add: "a", entry: entry("mine") }));
  // Another tab saves first: its line and its clear of addon b.
  localStorage.setItem(LOG_KEY, JSON.stringify({ a: [entry("theirs")] }));
  act(() => void window.dispatchEvent(new StorageEvent("storage", { key: LOG_KEY })));
  expect(h.log.get("a")!.map((e) => e.text)).toEqual(["theirs", "mine"]);
  act(() => void vi.advanceTimersByTime(300));
  expect(stored().a!.map((e) => e.text)).toEqual(["theirs", "mine"]);
  // A clear here is not undone by the other tab's next save of older lines.
  act(() => h.change({ drop: "a" }));
  act(() => void vi.advanceTimersByTime(300));
  expect(stored().a).toBeUndefined();
});

it("useAddonLog flushes on pagehide and stops its timer on unmount", async () => {
  vi.useFakeTimers();
  const h = await mountLog();
  act(() => h.change({ add: "a", entry: entry("x") }));
  act(() => void window.dispatchEvent(new Event("pagehide")));
  expect(stored().a).toHaveLength(1);
  act(() => h.change({ add: "a", entry: entry("y") }));
  act(() => root!.unmount());
  root = undefined;
  expect(vi.getTimerCount()).toBe(0);
});

const addon = { name: "example", source: { kind: "local", path: "/x" }, approved: ["log"], state: "enabled", base: "/addon/n/example/", manifest: { name: "example", version: "1", description: "", capabilities: ["log"], themes: [], views: [], commands: [], renderers: [] } } as AddonInfo;

async function frame(sessionId: string) {
  const api: AddonApi = { insert: vi.fn(), status: vi.fn(), toast: vi.fn(), refused: vi.fn(), log: vi.fn() };
  const el = await mount(
    <AddonApiContext value={api}>
      <AddonFrame addon={addon} entry="pane.html" role={sessionId ? "pane" : "render"} view="v" sessionId={sessionId} />
    </AddonApiContext>,
  );
  const win = el.querySelector("iframe")!.contentWindow!;
  const send = (data: object) => act(async () => void window.dispatchEvent(new MessageEvent("message", { data: { v: 1, id: "1", type: "log", ...data }, source: win })));
  return { api, send };
}

it("the log bridge call: info by default, levels checked, text capped, allowed in a render frame", async () => {
  const { api, send } = await frame("");
  await send({ text: "hi" });
  await send({ level: "error", text: "bad" });
  await send({ level: "debug", text: "x" });
  await send({ text: "x".repeat(501) });
  await send({ text: 5 });
  expect(api.log).toHaveBeenCalledTimes(2);
  expect(api.log).toHaveBeenNthCalledWith(1, "example", "info", "hi");
  expect(api.log).toHaveBeenNthCalledWith(2, "example", "error", "bad");
  expect(api.refused).toHaveBeenCalledTimes(3);
});

it("the log bridge call is refused without the log capability", async () => {
  const api: AddonApi = { insert: vi.fn(), status: vi.fn(), toast: vi.fn(), refused: vi.fn(), log: vi.fn() };
  const el = await mount(
    <AddonApiContext value={api}>
      <AddonFrame addon={{ ...addon, approved: [] }} entry="pane.html" role="pane" view="v" sessionId="s" />
    </AddonApiContext>,
  );
  const win = el.querySelector("iframe")!.contentWindow!;
  await act(async () => void window.dispatchEvent(new MessageEvent("message", { data: { v: 1, id: "1", type: "log", text: "hi" }, source: win })));
  expect(api.log).not.toHaveBeenCalled();
  expect(api.refused).toHaveBeenCalledWith("example", "log", "log needs capability log");
});
