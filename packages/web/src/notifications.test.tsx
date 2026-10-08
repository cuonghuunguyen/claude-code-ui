// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Described, Card } from "./notify.ts";
import { NotificationStack, useNotifications, type CardItem } from "./notifications.tsx";
import { applyEvent, emptySession } from "./store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const el = document.createElement("div");
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  vi.useRealTimers();
});

const item = (sessionId: string, kind: Card["kind"] = "permission", d: Partial<Described> = {}, c: Partial<Card> = {}): CardItem => ({
  card: { sessionId, kind, requestId: kind === "permission" || kind === "question" ? `r-${sessionId}` : undefined, since: 0, ...c },
  d: { kind, extra: 0, summary: "", body: "", ...(kind === "permission" && { tool: "Read", summary: "Read · src/a.ts", body: "src/a.ts", tier: "low" as const }), ...d },
  title: `Session ${sessionId}`,
  place: "proj",
  cwd: "/p",
});
const noop = () => {};
type Handlers = Partial<Parameters<typeof NotificationStack>[0]>;
async function show(items: CardItem[], h: Handlers = {}) {
  const props = { items, now: 0, focusTick: 0, hidden: false, onRespond: vi.fn(async () => ({ settled: true })), onOpenFocus: vi.fn(), onOpenSession: vi.fn(), onDismiss: vi.fn(), onOpenAll: vi.fn(), restoreFocus: vi.fn(), ...h };
  await act(async () => root.render(<NotificationStack {...props} />));
  return props;
}
const q = (s: string) => el.querySelector<HTMLElement>(s)!;
const qa = (s: string) => [...el.querySelectorAll<HTMLElement>(s)];
const button = (name: string | RegExp, within: ParentNode = el) => [...within.querySelectorAll<HTMLElement>("button")].find((b) => (typeof name === "string" ? b.textContent === name : name.test(b.textContent ?? "")))!;
const key = (target: Element, k: string, init: KeyboardEventInit = {}) => act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })));

it("is a Notifications landmark only while it holds a card, and the cards are not live regions", async () => {
  await show([]);
  expect(el.querySelector('[role="region"]')).toBeNull();
  await show([item("b")]);
  const region = q('section[aria-label="Notifications"]');
  expect(region).not.toBeNull();
  expect(region.querySelector('[role="status"], [aria-live]')).toBeNull();
  expect(region.querySelector("article")).not.toBeNull();
});

it("a low-tier read card: title, project, kind word, tool and path, then Allow once, Deny and Open in Focus", async () => {
  await show([item("b")]);
  const card = q("article");
  expect(card.textContent).toContain("Session b");
  expect(card.textContent).toContain("proj");
  expect(card.textContent).toContain("Needs permission");
  expect(card.querySelector("strong, b, [data-tool]")?.textContent).toBe("Read");
  expect(card.textContent).toContain("src/a.ts");
  expect([...card.querySelectorAll("button")].map((b) => b.textContent).filter(Boolean)).toEqual(["Allow once", "Deny", "Open in Focus"]);
  expect(button("Allow once")!.getAttribute("aria-label")).toBe("Allow once: Read src/a.ts in Session b");
  expect(card.getAttribute("aria-labelledby")).toBeTruthy();
  expect(document.getElementById(card.getAttribute("aria-labelledby")!)?.textContent).toBe("Session b");
});

it("Allow once and Deny answer through onRespond with the card; there is no Allow always", async () => {
  const h = await show([item("b")]);
  await act(async () => button("Allow once")!.click());
  expect(h.onRespond).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "b" }), "allow");
  await act(async () => button("Deny")!.click());
  expect(h.onRespond).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "b" }), "deny");
  expect(el.textContent).not.toMatch(/always/i);
});

it("while the answer is on its way the buttons are aria-disabled; a failure shows Not sent as an alert and enables them again", async () => {
  let fail!: (e: Error) => void;
  const onRespond = vi.fn(() => new Promise((_, rej) => (fail = rej)));
  await show([item("b")], { onRespond: onRespond as never });
  await act(async () => button("Allow once")!.click());
  expect(button("Allow once")!.getAttribute("aria-disabled")).toBe("true");
  expect(button("Deny")!.getAttribute("aria-disabled")).toBe("true");
  await act(async () => button("Deny")!.click());
  expect(onRespond).toHaveBeenCalledTimes(1);
  await act(async () => fail(new Error("disconnected")));
  expect(q('[role="alert"]').textContent).toBe("Not sent: disconnected");
  expect(button("Allow once")!.getAttribute("aria-disabled")).not.toBe("true");
});

it("high tier (or tier not read yet): a High tier badge and only Open in Focus and Open session", async () => {
  await show([item("c", "permission", { tool: "Bash", summary: "Bash · npm test", body: "npm test", tier: undefined })]);
  const card = q("article");
  expect(card.textContent).toContain("High tier");
  expect([...card.querySelectorAll("button")].map((b) => b.textContent).filter(Boolean)).toEqual(["Open in Focus", "Open session"]);
});

it("a low-tier edit offers no Allow and points at the diff in Focus", async () => {
  await show([item("f", "permission", { tool: "Edit", summary: "Edit · README.md +1 −0", body: "README.md +1 −0", tier: "low" })]);
  expect(button("Allow once")).toBeUndefined();
  expect(q("article").textContent).toContain("Review the change in Focus.");
});

it("a tier arriving later adds Allow once and Deny in place after the focused button", async () => {
  const high = item("b", "permission", { tier: undefined });
  await show([high]);
  const open = button("Open in Focus")!;
  open.focus();
  await show([item("b")]);
  expect(button("Allow once")).toBeDefined();
  expect(document.activeElement).toBe(button("Open in Focus"));
  expect(button("Open in Focus")).toBe(open);
});

it("a question has Open in Focus and Open session; escalated and extra requests show their note", async () => {
  await show([item("d", "question", { body: "Keep the old route?", summary: "Keep the old route?", escalated: true, reason: "outside the folder", extra: 1 })]);
  const card = q("article");
  expect(card.textContent).toContain("Question");
  expect(card.textContent).toContain("Keep the old route?");
  expect(card.textContent).toContain("Escalated by coordinator: outside the folder");
  expect(card.textContent).toContain("+1 more request in this session");
  expect(button("Allow once")).toBeUndefined();
});

it("the buttons call their handlers with the card", async () => {
  const h = await show([item("b", "permission", { tier: undefined })]);
  await act(async () => button("Open in Focus")!.click());
  expect(h.onOpenFocus).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "b" }));
  await act(async () => button("Open session")!.click());
  expect(h.onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "b" }));
  await act(async () => q('[aria-label="Dismiss notification for Session b"]').click());
  expect(h.onDismiss).toHaveBeenCalledWith("b");
});

it("a finished card has only Open session and hides after 8 s; an error and a request never hide", async () => {
  const onDismiss = vi.fn();
  await show([item("e", "finished", { body: "All 12 tests pass.", summary: "All 12 tests pass." }), item("x", "error", { body: "rate_limit" }), item("b")], { onDismiss });
  expect(q('article[data-kind="finished"]').textContent).toContain("Finished");
  expect(q('article[data-kind="finished"]').textContent).toContain("All 12 tests pass.");
  expect([...q('article[data-kind="finished"]').querySelectorAll("button")].map((b) => b.textContent).filter(Boolean)).toEqual(["Open session"]);
  await act(async () => void vi.advanceTimersByTime(7500));
  expect(onDismiss).not.toHaveBeenCalled();
  await act(async () => void vi.advanceTimersByTime(1000));
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onDismiss).toHaveBeenCalledWith("e");
  await act(async () => void vi.advanceTimersByTime(120_000));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("the finished timer waits while the pointer is over the region or focus is inside it", async () => {
  const onDismiss = vi.fn();
  await show([item("e", "finished", { body: "ok" })], { onDismiss });
  const region = q("section");
  await act(async () => void region.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  await act(async () => void vi.advanceTimersByTime(30_000));
  expect(onDismiss).not.toHaveBeenCalled();
  await act(async () => void region.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
  await act(async () => void vi.advanceTimersByTime(8500));
  expect(onDismiss).toHaveBeenCalledTimes(1);
  onDismiss.mockClear();
  await show([item("e2", "finished", { body: "ok" })], { onDismiss });
  await act(async () => button("Open session")!.focus());
  await act(async () => void vi.advanceTimersByTime(30_000));
  expect(onDismiss).not.toHaveBeenCalled();
});

it("Esc on a focused card dismisses it and never reaches the page (Esc there stops the turn)", async () => {
  const outer = vi.fn();
  window.addEventListener("keydown", outer);
  document.addEventListener("keydown", outer);
  const h = await show([item("a"), item("b")]);
  button("Deny", q('article[data-session="a"]'))!.focus();
  await key(document.activeElement!, "Escape");
  expect(h.onDismiss).toHaveBeenCalledWith("a");
  expect(outer).not.toHaveBeenCalled();
  // Focus moved to the other card's first action.
  expect(document.activeElement).toBe(q('article[data-session="b"] [data-action]'));
  window.removeEventListener("keydown", outer);
  document.removeEventListener("keydown", outer);
});

it("Esc outside the region is left alone", async () => {
  const outer = vi.fn();
  window.addEventListener("keydown", outer);
  await show([item("a")]);
  await key(document.body, "Escape");
  expect(outer).toHaveBeenCalledTimes(1);
  window.removeEventListener("keydown", outer);
});

it("ArrowDown and ArrowUp move between the cards' first actions", async () => {
  await show([item("a"), item("b"), item("c")]);
  const first = (s: string) => q(`article[data-session="${s}"] [data-action]`);
  first("a").focus();
  await key(first("a"), "ArrowDown");
  expect(document.activeElement).toBe(first("b"));
  await key(document.activeElement!, "ArrowDown");
  expect(document.activeElement).toBe(first("c"));
  await key(document.activeElement!, "ArrowUp");
  expect(document.activeElement).toBe(first("b"));
});

it("the go-to-notifications command (focusTick) focuses the newest card's first action, and Esc on the last card gives focus back", async () => {
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  const h = await show([item("a")]);
  await show([item("a")], { focusTick: 1, onDismiss: h.onDismiss });
  expect(document.activeElement).toBe(q("article [data-action]"));
  await key(document.activeElement!, "Escape");
  expect(document.activeElement).toBe(input);
  input.remove();
});

it("with nothing remembered, focus goes to restoreFocus after the last card is dismissed", async () => {
  const h = await show([item("a")]);
  button("Deny")!.focus();
  await key(document.activeElement!, "Escape");
  expect(h.restoreFocus).toHaveBeenCalled();
});

it("more than three waiting: three cards and a pill that opens Focus; finished cards are dropped before waiting ones", async () => {
  const h = await show([item("1"), item("2"), item("3"), item("4"), item("5", "finished", { body: "ok" })]);
  expect(qa("article")).toHaveLength(3);
  expect(qa('article[data-kind="finished"]')).toHaveLength(0);
  const pill = q('[data-testid="notifications-more"]');
  expect(pill.textContent).toBe("+1 more need you · Open Focus");
  await act(async () => pill.click());
  expect(h.onOpenAll).toHaveBeenCalledTimes(1);
});

it("hidden (drawer or a dialog is open): nothing is shown, the cards come back after", async () => {
  await show([item("a")], { hidden: true });
  expect(el.querySelector("article")).toBeNull();
  await show([item("a")], { hidden: false });
  expect(el.querySelector("article")).not.toBeNull();
});

it("the age reads now, then whole minutes", async () => {
  await show([item("a", "permission", {}, { since: 0 })], { now: 5_000 });
  expect(q("time").textContent).toBe("now");
  await show([item("a", "permission", {}, { since: 0 })], { now: 12 * 60_000 + 1000 });
  expect(q("time").textContent).toBe("12m");
});

it("touch targets: buttons and the X are 44px on a coarse pointer or below sm", async () => {
  await show([item("b")]);
  for (const b of qa("article button")) expect(b.className).toMatch(/pointer-coarse:(h|size|min-h)-11|max-sm:h-11/);
  void noop;
});

it("a request whose render has not landed yet still makes its card: the hook waits for the view to hold the part", async () => {
  const part = { type: "permission_request", id: "r1", requestId: "r1", toolUseId: "t", tool: "Bash", input: { command: "npm test" }, suggestions: [], settled: false } as never;
  const list = [{ id: "b", cwd: "/p", state: "idle", title: "B", lastActivity: 0, archived: false, transcript: true }] as never;
  let api!: ReturnType<typeof useNotifications>;
  function Host({ views }: { views: Record<string, ReturnType<typeof emptySession>> }) {
    api = useNotifications({ enabled: true, focused: true, focusPage: false, shown: () => false, list, views });
    return <p data-testid="n">{api.cards.length}</p>;
  }
  await act(async () => root.render(<Host views={{ b: emptySession() }} />));
  await act(async () => api.observe({ type: "event", sessionId: "b", seq: 1, part }, true));
  await act(async () => void vi.advanceTimersByTime(120));
  expect(q('[data-testid="n"]').textContent).toBe("0");
  const view = applyEvent(emptySession(), { type: "event", sessionId: "b", seq: 1, part });
  await act(async () => root.render(<Host views={{ b: view }} />));
  await act(async () => void vi.advanceTimersByTime(120));
  expect(q('[data-testid="n"]').textContent).toBe("1");
});
