// @vitest-environment jsdom
// GH-417: the phone tab switcher switches tabs only on a pick of a row, never because the tab list changed.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TabsBar, type TabInfo } from "./tabs-bar.tsx";
import { NEW_TAB, replaceTab } from "./tabs.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INFO: Record<string, TabInfo> = {
  a: { title: "Alpha", cwd: "/p/a", state: "idle", unread: false },
  b: { title: "Beta", cwd: "/p/a", state: "idle", unread: false },
  c: { title: "Gamma", cwd: "/p/b", state: "idle", unread: false },
  x: { title: "Untitled", cwd: "/p/a", state: "running", unread: false },
  [NEW_TAB]: { title: "New session", unread: false },
};

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => (root?.unmount(), (root = undefined), document.body.replaceChildren()));
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const rows = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];

/** TabsBar on the phone; `bar(tabs, activeId)` re-renders it as App would. */
function mount() {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const onSelect = vi.fn();
  const bar = (tabs: string[], activeId: string) =>
    act(async () => root!.render(<TabsBar tabs={tabs} activeId={activeId} info={(id) => INFO[id]!} onSelect={onSelect} onClose={() => {}} onMove={() => {}} onMoveGroup={() => {}} onMoveGroupTo={() => {}} onNew={() => {}} onAction={() => {}} onRenamed={() => {}} />));
  const trigger = () => el.querySelector<HTMLElement>('[data-testid="tab-switcher"]')!;
  // A tap ends with the compatibility mousedown, which is what opens base-ui's Select.
  const openList = async () => {
    await act(async () => void trigger().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })));
    await wait(60);
  };
  const closeList = async () => {
    await act(async () => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await wait(60);
  };
  return { onSelect, bar, openList, closeList };
}

it("phone: the New session tab turning into the session its first prompt created keeps that session shown", async () => {
  const { onSelect, bar, openList, closeList } = mount();
  await bar(["a", "b"], "a");
  let tabs = ["a", "b", NEW_TAB];
  await bar(tabs, NEW_TAB);
  // The list was opened once on this page: base-ui keeps it mounted from then on.
  await openList();
  expect(rows().length).toBe(3);
  await closeList();
  onSelect.mockClear();
  tabs = replaceTab(tabs, NEW_TAB, "x");
  await bar(tabs, "x");
  await wait(60);
  expect(onSelect).not.toHaveBeenCalled();
});

it("phone: a /clear that puts the active tab on a new session keeps that session shown", async () => {
  const { onSelect, bar, openList, closeList } = mount();
  // The switcher mounts on Beta, then the user goes to Alpha.
  await bar(["a", "b", "c"], "b");
  await bar(["a", "b", "c"], "a");
  await openList();
  await closeList();
  onSelect.mockClear();
  // App's follow(): the tab of `a` now shows its heir `x`, and `x` is opened.
  const tabs = replaceTab(["a", "b", "c"], "a", "x");
  await bar(tabs, "x");
  await wait(60);
  expect(onSelect).not.toHaveBeenCalled();
});

it("phone: a tap on a row of the switcher still switches to its tab", async () => {
  const { onSelect, bar, openList } = mount();
  await bar(["a", "b", "c"], "a");
  await openList();
  const row = rows().find((r) => r.textContent?.includes("Gamma"))!;
  await act(async () => {
    row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    row.click();
  });
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("c");
});

it("phone: Enter on a highlighted row of the switcher switches to its tab", async () => {
  const { onSelect, bar, openList } = mount();
  await bar(["a", "b", "c"], "a");
  await openList();
  const row = rows().find((r) => r.textContent?.includes("Beta"))!;
  await act(async () => void row.focus());
  await act(async () => void row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await wait(20);
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("b");
});
