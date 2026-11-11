// @vitest-environment jsdom
// GH-517: shake to locate rings the active tab (or its group chip) and the active sidebar row.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";
import { TabsBar, type TabInfo } from "./tabs-bar.tsx";
import { SessionList } from "./sidebar.tsx";
import { saveShakeLocate, ringLocate } from "./locate.ts";
import { ConfirmDialog } from "./session-actions.tsx";
import { NEW_TAB } from "./tabs.ts";

const T = (title: string, cwd: string): TabInfo => ({ title, cwd, group: cwd, state: "idle", unread: false });
const INFO: Record<string, TabInfo> = { [NEW_TAB]: { title: "New session", unread: false }, a1: T("First", "/p/alpha"), a2: T("Second", "/p/alpha"), b1: T("Beta one", "/p/beta") };
const row = (id: string, title: string): SessionListItem => ({ id, cwd: "/p/alpha", title, state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: [], lastActivity: Date.now(), archived: false, transcript: true });
const LIST = [row("a", "Fix login"), row("b", "Docs")];
const noop = { onSelect: () => {}, onClose: () => {}, onMove: () => {}, onMoveGroup: () => {}, onMoveGroupTo: () => {}, onNew: () => {}, onAction: () => {}, onRenamed: () => {} };

let root: ReturnType<typeof createRoot> | undefined;
const scroll = vi.fn();
const mm = window.matchMedia;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Element.prototype.scrollIntoView = scroll;
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  window.matchMedia = mm;
  scroll.mockClear();
  vi.useRealTimers();
});

const mount = async (o: { activeId?: string; sessionId?: string; compact?: boolean } = {}) => {
  if (!root) {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
  }
  await act(async () =>
    root!.render(
      <>
        <TabsBar {...noop} compact={o.compact} tabs={["a1", "a2", "b1"]} activeId={o.activeId ?? "a2"} info={(id) => INFO[id]!} />
        <SessionList list={LIST} projects={["/p/alpha"]} state={(s) => s.state} unread={new Set()} activeId={o.sessionId} onOpen={() => {}} onNew={() => {}} onRemove={() => {}} onOpenProject={() => {}} onAction={() => {}} onRenamed={() => {}} />
      </>,
    ),
  );
};
const shake = (pointerType = "mouse") =>
  act(() => {
    for (const x of [300, 360, 300, 360, 300, 360]) {
      const e = new PointerEvent("pointermove", { clientX: x, pointerType, bubbles: true });
      if (e.pointerType !== pointerType) Object.defineProperty(e, "pointerType", { value: pointerType });
      window.dispatchEvent(e);
    }
  });
const rung = () => [...document.querySelectorAll("[data-locate]")];

it("shake rings the active tab and the active sidebar row, and the ring ends after 1.5 s", async () => {
  await mount({ sessionId: "a" });
  shake();
  expect(document.querySelector('[data-tab-id="a2"]')!.hasAttribute("data-locate")).toBe(true);
  expect(document.querySelector('[data-session-id="a"]')!.hasAttribute("data-locate")).toBe(true);
  expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: "nearest" }));
  act(() => void vi.advanceTimersByTime(1500));
  expect(rung()).toHaveLength(0);
});

it("compact tabs: the group chip rings, not the tab", async () => {
  await mount({ compact: true, sessionId: "a" });
  shake();
  expect(document.querySelector('[data-group-chip="/p/alpha"]')!.hasAttribute("data-locate")).toBe(true);
  expect(document.querySelector('[data-tab-id="a2"]')!.hasAttribute("data-locate")).toBe(false);
});

it("New session tab: nothing rings", async () => {
  await mount({ activeId: NEW_TAB });
  shake();
  expect(rung()).toHaveLength(0);
});

it("a sidebar row hidden from the list is left alone", async () => {
  await mount({ sessionId: "gone" });
  shake();
  expect(document.querySelector('[data-session-id]:not([data-session-id="gone"])[data-locate]')).toBeNull();
  expect(document.querySelector('[data-testid="session-item"][data-locate]')).toBeNull();
});

it("setting off: nothing rings", async () => {
  saveShakeLocate(false);
  await mount({ sessionId: "a" });
  shake();
  expect(rung()).toHaveLength(0);
  saveShakeLocate(true);
});

it("phone: no listener", async () => {
  window.matchMedia = ((q: string) => ({ matches: q.includes("40rem"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  await mount({ sessionId: "a" });
  shake();
  expect(rung()).toHaveLength(0);
});

it("touch shake does nothing", async () => {
  await mount({ sessionId: "a" });
  shake("touch");
  expect(rung()).toHaveLength(0);
});

it("an open confirm dialog blocks the shake", async () => {
  await mount({ sessionId: "a" });
  await act(async () => createRoot(document.body.appendChild(document.createElement("div"))).render(<ConfirmDialog open title="Delete?" description="Sure" confirm="Delete" onConfirm={() => {}} onCancel={() => {}} testId="x" />));
  expect(document.querySelector('[data-testid="x-dialog"]')?.getAttribute("aria-modal")).toBe("true");
  shake();
  expect(rung()).toHaveLength(0);
});

it("the shake follows the active tab right after it changed, and leaves no ring on the old one", async () => {
  await mount({ activeId: "a1" });
  shake();
  expect(document.querySelector('[data-tab-id="a1"]')!.hasAttribute("data-locate")).toBe(true);
  await mount({ activeId: "b1" });
  act(() => void vi.advanceTimersByTime(2500)); // cooldown
  shake();
  expect(rung().map((e) => e.getAttribute("data-tab-id"))).toEqual(["b1"]);
});

it("ringLocate scrolls nearest, smooth unless reduced motion; the ring is static then", () => {
  const el = document.createElement("div");
  document.body.append(el);
  el.scrollIntoView = vi.fn();
  ringLocate(el);
  expect(el.scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest", behavior: "smooth" });
  window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  ringLocate(el);
  expect(el.scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest", behavior: "auto" });
  expect(el.hasAttribute("data-locate")).toBe(true);
});
