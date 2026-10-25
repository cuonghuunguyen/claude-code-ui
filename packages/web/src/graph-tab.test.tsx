// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { GraphTab } from "./graph-tab.tsx";

vi.mock("@pierre/diffs/react", () => ({ MultiFileDiff: () => <div data-testid="pierre-diff" /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;
Element.prototype.scrollTo = function (this: Element, o?: ScrollToOptions | number) {
  this.scrollTop = typeof o === "object" ? (o.top ?? 0) : 0;
  this.dispatchEvent(new Event("scroll"));
} as never;

// The list reports a size, so the virtualizer can compute scroll offsets.
const rect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function (this: Element) {
  return this.getAttribute("role") === "listbox" ? ({ width: 400, height: 500, top: 0, left: 0, right: 400, bottom: 500, x: 0, y: 0, toJSON() {} } as DOMRect) : rect.call(this);
};
// jsdom has no layout: the list is as high as its rows say and 500px of it shows.
const isList = (e: Element) => e.getAttribute("role") === "listbox";
Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return isList(this) ? Number.parseFloat((this.firstElementChild as HTMLElement).style.height) : 0; } });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return isList(this) ? 500 : 0; } });
const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(null)));
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const hash = (i: number) => i.toString(16).padStart(40, "0");
type Req = { type: string; cwd?: string; [k: string]: unknown };
function fake() {
  const sent: Req[] = [];
  const request = vi.fn(async (m: Req) => {
    sent.push(m);
    if (m.type === "git.repos") return { repos: [{ path: "/p/repo", rel: "repo", kind: "nested" }] };
    if (m.type === "git.log") return { log: { commits: [{ hash: hash(1), parents: [], author: "Ann", email: "a@x.test", time: 1_700_000_001, subject: "commit 1", refs: ["HEAD", "refs/heads/main"] }], more: false, branches: ["refs/heads/main"], refs: "s1", head: "refs/heads/main" } };
    if (m.type === "git.refs") return { refs: "s1" };
    return {};
  });
  return Object.assign({ request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>, { sent });
}
const mount = async (c: ReturnType<typeof fake>, hidden: boolean) => {
  await act(async () => root.render(<GraphTab client={c} cwd="/p" hidden={hidden} connected openFiles={[]} seq={0} />));
  await flush();
};

it("GH-396 asks git.repos for its own folder and shows the default repository's graph (exact)", async () => {
  const c = fake();
  await mount(c, false);
  expect(c.sent.find((m) => m.type === "git.repos")).toMatchObject({ cwd: "/p" });
  expect(c.sent.find((m) => m.type === "git.log")).toMatchObject({ cwd: "/p/repo", exact: true });
  expect(el.querySelector("[data-testid=graph-panel]")).not.toBeNull();
});

it("GH-396 hidden keeps the loaded list: no second git.log while hidden, none on return when the refs stamp is equal", async () => {
  const c = fake();
  await mount(c, false);
  await mount(c, true);
  expect(el.querySelector<HTMLElement>("[data-testid=graph-panel]")!.className).toContain("hidden");
  await mount(c, false);
  expect(c.sent.filter((m) => m.type === "git.log")).toHaveLength(1);
  expect(c.sent.filter((m) => m.type === "git.repos")).toHaveLength(1);
});
