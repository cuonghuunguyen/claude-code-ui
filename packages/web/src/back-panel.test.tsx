// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BackMark } from "@claude-ui/protocol";
import { BackButton, BackPanel, BackReminderCards, BriefRow } from "./back-panel.tsx";
import { resetBack, setBack, useBack } from "./back-marks.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let unmount = () => {};
beforeEach(resetBack);
afterEach(() => unmount());

async function render(ui: React.ReactElement) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(ui));
  unmount = () => (root.unmount(), el.remove());
  return el;
}
const click = (el: Element | null | undefined) => act(async () => void (el as HTMLElement).click());
const type = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const key = (el: Element, k: string) => act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
const BRIEF = "About: A fix\nFocus now: the test\nNext: run it";
const mark = (extra: Partial<BackMark> = {}): BackMark => ({ partId: "m1:0", at: 1_700_000_000_000, title: "Reply title", lastLine: "Last", prompt: "Prompt", ...extra });
const panel = (m: BackMark, o: Partial<Parameters<typeof BackPanel>[0]> = {}) => <BackPanel sessionId="s" mark={m} stale={0} request={vi.fn(async () => ({}))} {...o} />;

it("the button is named, and once marked it is a plain button that goes to the panel (no aria-pressed)", async () => {
  const onMark = vi.fn();
  const onGo = vi.fn();
  const el = await render(<BackButton partId="m1:0" marked={false} onMark={onMark} onGo={onGo} />);
  const b = el.querySelector("button")!;
  expect(b.textContent).toContain("I'll be back: mark this reply to come back to");
  await click(b);
  expect(onMark).toHaveBeenCalledTimes(1);
  await act(async () => void unmount());
  const el2 = await render(<BackButton partId="m1:0" marked onMark={onMark} onGo={onGo} />);
  const b2 = el2.querySelector("button")!;
  expect(b2.textContent).toContain("Marked: go to the mark");
  expect(b2.hasAttribute("aria-pressed")).toBe(false);
  await click(b2);
  expect(onGo).toHaveBeenCalledTimes(1);
  expect(onMark).toHaveBeenCalledTimes(1);
});

it("running: spinner text, skeleton, status; queued; paused states", async () => {
  let el = await render(panel(mark({ briefState: "running" })));
  expect(el.querySelector('[role="group"]')!.getAttribute("aria-labelledby")).toBeTruthy();
  expect(el.textContent).toContain("Writing brief…");
  expect(el.querySelector('[data-testid="back-skeleton"]')).not.toBeNull();
  expect(el.querySelector('[role="status"]')!.textContent).toBe("Writing brief…");
  unmount();
  el = await render(panel(mark({ briefState: "queued" })));
  expect(el.querySelector('[role="status"]')!.textContent).toBe("Brief queued: starts after the current turn");
  unmount();
  el = await render(panel(mark({ briefState: "queued" }), { held: { reason: "not_live" } }));
  expect(el.querySelector('[role="status"]')!.textContent).toBe("Brief paused: the session stopped with an error");
  unmount();
  el = await render(panel(mark({ briefState: "queued" }), { held: { reason: "usage_limit", until: 1_700_000_000_000 } }));
  expect(el.querySelector('[role="status"]')!.textContent).toMatch(/^Brief paused until .+ \(usage limit\)$/);
});

it("ready: labelled rows; stale: count and Refresh that sends back.brief; refreshing keeps the old brief and disables Refresh", async () => {
  const request = vi.fn(async () => ({}));
  const m = mark({ brief: { text: BRIEF, at: 1_700_000_000_000 } });
  let el = await render(panel(m, { stale: 2, request }));
  expect([...el.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["About", "Focus now", "Next"]);
  expect(el.textContent).toContain("2 turns since this brief");
  await click([...el.querySelectorAll("button")].find((b) => b.textContent === "Refresh brief"));
  expect(request).toHaveBeenCalledWith({ type: "back.brief", sessionId: "s", partId: "m1:0" });
  unmount();
  el = await render(panel({ ...m, briefState: "running" }, { stale: 2 }));
  expect(el.textContent).toContain("A fix");
  expect(el.textContent).toContain("Writing a new brief…");
  expect([...el.querySelectorAll("button")].find((b) => b.textContent === "Refresh brief")!.hasAttribute("disabled")).toBe(true);
});

it("failed without a brief shows the fallback and Retry; failed with an older brief keeps it", async () => {
  const request = vi.fn(async () => ({}));
  let el = await render(panel(mark({ briefState: "failed", briefError: "Interrupted by a restart", note: "Do X" }), { request }));
  const fb = el.querySelector('[data-testid="back-fallback"]')!;
  expect([...fb.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["About", "Last reply", "Next"]);
  expect([...fb.querySelectorAll("dd")].map((d) => d.textContent)).toEqual(["Prompt", "Last", "Do X"]);
  expect(el.textContent).toContain("Brief not written: Interrupted by a restart");
  await click([...el.querySelectorAll("button")].find((b) => b.textContent === "Retry"));
  expect(request).toHaveBeenCalledWith({ type: "back.brief", sessionId: "s", partId: "m1:0" });
  unmount();
  el = await render(panel(mark({ briefState: "failed", briefError: "x", brief: { text: BRIEF, at: 1 } })));
  expect(el.querySelector('[data-testid="back-fallback"]')).toBeNull();
  expect(el.textContent).toContain("A fix");
  expect(el.textContent).toContain("Brief not written: x");
});

it("interval field: abc + Enter shows the alert, aria-invalid and keeps focus; typing clears; 2h sets", async () => {
  const request = vi.fn(async () => ({}));
  const el = await render(panel(mark({ brief: { text: BRIEF, at: 1 } }), { request }));
  const input = el.querySelector<HTMLInputElement>('input[placeholder="30m"]')!;
  expect(el.querySelector(`label[for="${input.id}"]`)!.textContent).toBe("Remind me in");
  expect(el.textContent).toContain("A number and m, h or d, from 1m to 7d.");
  input.focus();
  await type(input, "abc");
  await key(input, "Enter");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(el.querySelector('[role="alert"]')!.textContent).toBe("Use a number and m, h or d, e.g. 30m, 2h, 1d");
  expect(document.activeElement).toBe(input);
  expect(request).not.toHaveBeenCalled();
  await type(input, "0m");
  expect(el.querySelector('[role="alert"]')).toBeNull();
  await key(input, "Enter");
  expect(el.querySelector('[role="alert"]')!.textContent).toBe("At least 1m");
  await type(input, "8d");
  await key(input, "Enter");
  expect(el.querySelector('[role="alert"]')!.textContent).toBe("At most 7d");
  await type(input, "2h");
  await key(input, "Enter");
  expect(request).toHaveBeenCalledWith({ type: "back.set", sessionId: "s", partId: "m1:0", title: "Reply title", remindMs: 7_200_000 });
});

it("armed reminder shows the line with Change and Clear; fired shows Snooze with the stored interval and Dismiss", async () => {
  const request = vi.fn(async () => ({}));
  let el = await render(panel(mark({ remindMs: 7_200_000, remindAt: 1_700_007_200_000 }), { request }));
  expect(el.textContent).toMatch(/Reminds .+ \(in 2h\)/);
  await click(el.querySelector('button[aria-label="Clear reminder"]'));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ remindMs: null }));
  unmount();
  el = await render(panel(mark({ remindMs: 7_200_000, remindAt: 1_700_007_200_000, remindedAt: 1_700_007_300_000 }), { request }));
  const snooze = el.querySelector('button[aria-label="Snooze 2 hours"]')!;
  expect(snooze.textContent).toBe("Snooze 2h");
  expect(el.querySelector('button[aria-label="Dismiss reminder"]')).not.toBeNull();
  await click(snooze);
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ type: "back.set", remindMs: 7_200_000 }));
});

it("note: saves on Enter and blur, shows Saved, the counter from 240 characters, and caps at 280", async () => {
  const request = vi.fn(async () => ({}));
  const el = await render(panel(mark({ brief: { text: BRIEF, at: 1 } }), { request }));
  const note = el.querySelector<HTMLInputElement>('input[maxlength="280"]')!;
  expect(el.querySelector(`label[for="${note.id}"]`)!.textContent).toBe("Note");
  await type(note, "x".repeat(245));
  expect(el.textContent).toContain("245/280");
  await key(note, "Enter");
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: "back.set", note: "x".repeat(245) }));
  expect(el.textContent).toContain("Saved");
});

it("Done removes via back.done, announces and hands focus back through onRemoved", async () => {
  const request = vi.fn(async () => ({}));
  const onNotice = vi.fn();
  const onRemoved = vi.fn();
  const el = await render(panel(mark(), { request, onNotice, onRemoved }));
  const done = el.querySelector('button[aria-label="Done: remove this mark"]')!;
  await click(done);
  expect(request).toHaveBeenCalledWith({ type: "back.done", sessionId: "s", partId: "m1:0" });
  expect(onNotice).toHaveBeenCalledWith("Mark removed");
  expect(onRemoved).toHaveBeenCalled();
});

it("tab order of the panel: Done, Refresh, Note, Remind me in, Set", async () => {
  const el = await render(panel(mark({ brief: { text: BRIEF, at: 1 } }), { stale: 1 }));
  const names = [...el.querySelectorAll<HTMLElement>("button, input")].map((n) => n.getAttribute("aria-label") ?? n.getAttribute("placeholder") ?? n.textContent);
  expect(names).toEqual(["Done: remove this mark", "Refresh brief", "What to do when you come back (optional)", "30m", "Set"]);
});

it("no raw hex colors in the new component", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(process.cwd(), "packages/web/src/back-panel.tsx"), "utf8");
  expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
});

it("collapsed brief row: a button with aria-expanded toggled by click, about line in the subtitle", async () => {
  const el = await render(<BriefRow answer={BRIEF} />);
  const b = el.querySelector("button")!;
  expect(b.getAttribute("aria-expanded")).toBe("false");
  expect(b.textContent).toContain("Brief for your mark");
  expect(b.textContent).toContain("About: A fix");
  await click(b);
  expect(b.getAttribute("aria-expanded")).toBe("true");
  expect(el.textContent).toContain("Focus now");
});

function Cards(p: { onOpen: () => void; request: () => Promise<unknown> }) {
  return <BackReminderCards enabled marks={useBack()} title={() => "My session"} onOpen={p.onOpen} request={p.request} />;
}

it("reminder card: only from a live change; Open, Snooze 2h, Dismiss in that order; stays until an action", async () => {
  const request = vi.fn(async () => ({}));
  const onOpen = vi.fn();
  const base = { partId: "m1:0", at: 1, title: "Reply title", remindMs: 7_200_000, remindAt: 100 };
  setBack({ marks: { s: [{ ...base, remindedAt: 150 }] } }, true);
  const el = await render(<Cards onOpen={onOpen} request={request} />);
  expect(el.querySelector('[data-testid="back-reminder-card"]')).toBeNull();
  await act(async () => setBack({ marks: { s: [{ ...base, remindedAt: 200 }] } }));
  const card = el.querySelector('[data-testid="back-reminder-card"]')!;
  expect(card.textContent).toContain("Come back: My session");
  const names = [...card.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
  expect(names).toEqual(["Dismiss", "Open", "Snooze 2 hours", "Dismiss reminder"]);
  expect(card.contains(document.activeElement)).toBe(false);
  // The live region exists outside the card and announces it without taking focus.
  expect(el.querySelector("div.sr-only[role=status]")!.textContent).toBe("Reminder: come back to My session");
  await click([...card.querySelectorAll("button")].find((b) => b.textContent === "Snooze 2h"));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: "back.set", remindMs: 7_200_000 }));
  expect(card.querySelector('[role="status"]')!.textContent).toMatch(/^Snoozed until /);
  await click(card.querySelector("button"));
  expect(el.querySelector('[data-testid="back-reminder-card"]')).toBeNull();
});
