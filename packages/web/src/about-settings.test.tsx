// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateCheckResult } from "@claude-ui/protocol";
import { AboutSection } from "./about-settings.tsx";
import type { UpdateInfo } from "./update.tsx";

const el = document.createElement("div");
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  localStorage.clear();
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
});

type Props = { update?: UpdateInfo; onCheckUpdate?: () => Promise<UpdateCheckResult>; request?: (m: never) => Promise<unknown> };
const render = (p: Props) => act(async () => root.render(<AboutSection daemonVersion="0.2.0" {...(p as object)} />));
const row = () => el.querySelector<HTMLElement>('[data-testid="settings-about-updates"]');
const button = (label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === label);
const available: UpdateInfo = { version: "0.2.1", current: "0.2.0" };

it("shows the available version even after Not yet hid the notice, and updates from here", async () => {
  localStorage.setItem("claude-ui.update.dismissed", "0.2.1");
  const request = vi.fn(async (m: { type: string }) => (m.type === "update.install" ? { installed: "0.2.1" } : { waitingFor: 0 }));
  await render({ update: available, onCheckUpdate: vi.fn(), request: request as never });
  expect(row()!.textContent).toContain("claude-ui 0.2.1 is available (you have 0.2.0).");
  await act(async () => button("Update and restart")!.click());
  expect(request.mock.calls.map((c) => c[0])).toEqual([{ type: "update.install" }, { type: "update.restart" }]);
});

it("Check for updates: says when this is the latest version", async () => {
  const onCheckUpdate = vi.fn(async () => ({ current: "0.2.0" }));
  await render({ onCheckUpdate });
  expect(row()!.textContent).toContain("Checked when claude-ui starts and once a day.");
  expect(button("Update and restart")).toBeUndefined();
  await act(async () => button("Check for updates")!.click());
  expect(onCheckUpdate).toHaveBeenCalledOnce();
  expect(row()!.textContent).toContain("claude-ui 0.2.0 is the latest version.");
});

it("Check for updates: updates off here, or the daemon's reason", async () => {
  await render({ onCheckUpdate: async () => Promise.reject(Object.assign(new Error("updates are off"), { code: "update_unavailable" })) });
  await act(async () => button("Check for updates")!.click());
  expect(row()!.textContent).toContain("Updates are off here");
  await render({ onCheckUpdate: async () => Promise.reject(Object.assign(new Error("the registry answered 503"), { code: "update_failed" })) });
  await act(async () => button("Check for updates")!.click());
  expect(row()!.textContent).toContain("Could not check for updates: the registry answered 503");
});

it("an update under way shows its phase and offers no buttons but the check", async () => {
  await render({ update: { ...available, state: { phase: "installing" } }, onCheckUpdate: vi.fn() });
  expect(row()!.textContent).toContain("Installing claude-ui 0.2.1…");
  expect(button("Update and restart")).toBeUndefined();
  expect(button("Check for updates")!.disabled).toBe(true);
});

it("no updates row without a check (the dialog in tests, an older App)", async () => {
  await render({});
  expect(row()).toBeNull();
  expect(el.querySelector('[data-testid="settings-about-daemon"]')!.textContent).toBe("0.2.0");
});
