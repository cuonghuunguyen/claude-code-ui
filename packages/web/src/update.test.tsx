// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nextUpdate, UpdateToast, type UpdateInfo } from "./update.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
const render = (update: UpdateInfo, request: (m: never) => Promise<unknown> = vi.fn(async () => ({}))) => act(async () => root.render(<UpdateToast update={update} request={request as never} />));
const toast = () => el.querySelector<HTMLElement>('[data-testid="update-toast"]');
const button = (label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === label);

const available = nextUpdate(undefined, { type: "update_available", version: "0.2.1", current: "0.2.0" })!;

it("available -> installing -> waiting -> restarting, and the install then restart requests", async () => {
  const request = vi.fn(async (m: { type: string }) => (m.type === "update.install" ? { installed: "0.2.1" } : { waitingFor: 1 }));
  await render(available, request);
  expect(toast()!.textContent).toContain("Update available");
  expect(toast()!.textContent).toContain("claude-ui 0.2.1 is available (you have 0.2.0).");
  await act(async () => button("Update and restart")!.click());
  expect(request.mock.calls.map((c) => c[0])).toEqual([{ type: "update.install" }, { type: "update.restart" }]);

  let u = nextUpdate(available, { type: "update_state", phase: "installing" })!;
  await render(u, request);
  expect(toast()!.textContent).toContain("Installing claude-ui 0.2.1…");
  expect(el.querySelectorAll("button")).toHaveLength(0);

  u = nextUpdate(u, { type: "update_state", phase: "waiting", waitingFor: 1, terminals: 2 })!;
  await render(u, request);
  expect(toast()!.textContent).toContain("Restarts when 1 session is idle and closes 2 open terminals. Restart now ends 1 running session.");
  await act(async () => button("Restart now")!.click());
  expect(request).toHaveBeenLastCalledWith({ type: "update.restart", now: true });

  u = nextUpdate(u, { type: "update_state", phase: "restarting" })!;
  await render(u, request);
  expect(toast()!.textContent).toContain("Restarting claude-ui 0.2.1…");
});

it("open terminals only: the notice says the restart closes them and waits for Restart now", async () => {
  const request = vi.fn(async () => ({}));
  await render({ ...available, state: { phase: "waiting", waitingFor: 0, terminals: 1 } }, request);
  expect(toast()!.textContent).toContain("Restarting closes 1 open terminal.");
  await act(async () => button("Restart now")!.click());
  expect(request).toHaveBeenLastCalledWith({ type: "update.restart", now: true });
  await render({ ...available, state: { phase: "waiting", waitingFor: 2, terminals: 0 } }, request);
  expect(toast()!.textContent).toContain("Restarts when 2 sessions are idle. Restart now ends 2 running sessions.");
});

it("Not yet hides it until a newer version", async () => {
  await render(available);
  await act(async () => button("Not yet")!.click());
  expect(toast()).toBeNull();
  await render({ ...available });
  expect(toast()).toBeNull();
  // A reload of the page: still hidden.
  act(() => root.unmount());
  root = createRoot(el);
  await render(available);
  expect(toast()).toBeNull();
  await render({ version: "0.2.2", current: "0.2.0" });
  expect(toast()!.textContent).toContain("0.2.2");
});

it("an install failure shows npm's lines with Try again", async () => {
  const request = vi.fn(async () => {
    throw new Error("npm ERR! code EACCES");
  });
  await render(available, request);
  await act(async () => button("Update and restart")!.click());
  expect(toast()!.textContent).toContain("Update failed");
  expect(toast()!.textContent).toContain("npm ERR! code EACCES");
  expect(button("Try again")).toBeTruthy();
});

it("an update_state without a known version is ignored; update_available starts over", () => {
  expect(nextUpdate(undefined, { type: "update_state", phase: "installing" })).toBeUndefined();
  const waiting = nextUpdate(available, { type: "update_state", phase: "installing" });
  expect(nextUpdate(waiting, { type: "update_available", version: "0.2.1", current: "0.2.0" })).toEqual(available);
});

it("uses the toast frame and 44px touch targets on coarse pointers", async () => {
  await render(available);
  expect(toast()!.className).toContain("min-[601px]:w-80");
  expect(button("Not yet")!.className).toContain("pointer-coarse:min-h-11");
});
