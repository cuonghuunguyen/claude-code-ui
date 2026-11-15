// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClaudeAccountSection } from "./claude-account-settings.tsx";

const el = document.createElement("div");
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
});

const render = (request: (m: never) => Promise<unknown>, o: { envToken?: boolean; onLogin?: () => void } = {}) =>
  act(async () => root.render(<ClaudeAccountSection active="" accounts={[{ id: "a", name: "One" }, { id: "b", name: "Two" }]} envToken={o.envToken ?? true} request={request as never} onResult={() => {}} onError={() => {}} onLogin={o.onLogin ?? (() => {})} />));
const options = () => [...el.querySelectorAll<HTMLElement>('[data-testid="settings-account-option"]')];
const tests = () => [...el.querySelectorAll<HTMLButtonElement>('[data-testid="settings-account-test"]')];
const results = () => [...el.querySelectorAll<HTMLElement>('[data-testid="settings-account-test-result"]')];

it("Test is only on token rows, 44px below md", async () => {
  await render(async () => ({}));
  expect(tests()).toHaveLength(2);
  expect(tests()[0]!.className).toContain("max-md:h-11");
  expect(el.querySelectorAll('[role="radio"]')).toHaveLength(4); // Default, CLI login, two token accounts
});

it("sends the test, disables the row's button with a spinner while pending, then shows the result", async () => {
  let done!: () => void;
  const request = vi.fn(() => new Promise((r) => (done = () => r({}))));
  await render(request);
  await act(async () => tests()[0]!.click());
  expect(request).toHaveBeenCalledWith({ type: "claude.account.test", id: "a" });
  expect(tests()[0]!.disabled).toBe(true);
  expect(tests()[0]!.getAttribute("aria-busy")).toBe("true");
  expect(tests()[0]!.querySelector("svg.animate-spin")).not.toBeNull();
  expect(tests()[1]!.disabled).toBe(false);
  await act(async () => done());
  expect(tests()[0]!.disabled).toBe(false);
  expect(results()).toHaveLength(1);
  expect(results()[0]!.textContent).toBe("Token works");
  expect(results()[0]!.getAttribute("role")).toBe("status");
});

it("a refused token shows the prefixed CLI text as an alert; other errors show the message", async () => {
  const request = vi.fn(async (m: { id: string }) => {
    throw Object.assign(new Error(m.id === "a" ? "401 invalid" : "timed out"), { code: m.id === "a" ? "claude_auth" : "claude_test_failed" });
  });
  await render(request as never);
  await act(async () => tests()[0]!.click());
  await act(async () => tests()[1]!.click());
  expect(results().map((r) => r.textContent)).toEqual(["Token refused: 401 invalid", "timed out"]);
  expect(results()[0]!.getAttribute("role")).toBe("alert");
  expect(results()[0]!.getAttribute("title")).toBe("Token refused: 401 invalid");
});

it("the CLI login button of Settings opens the login", async () => {
  const onLogin = vi.fn();
  await render(async () => ({}), { onLogin });
  await act(async () => el.querySelector<HTMLElement>('[data-testid="settings-claude-login"]')!.click());
  expect(onLogin).toHaveBeenCalledOnce();
});

it("picking CLI login sends the account patch, and without a daemon token the default login shows as CLI login", async () => {
  const request = vi.fn(async () => ({}));
  await render(request, { envToken: false });
  expect(options().map((o) => [o.textContent, o.getAttribute("aria-checked")])).toEqual([["CLI login", "true"], ["OneToken set", "false"], ["TwoToken set", "false"]]);
  await render(request);
  await act(async () => options().find((o) => o.textContent === "CLI login")!.click());
  expect(request).toHaveBeenCalledWith({ type: "settings.set", patch: { claude: { account: "cli" } } });
});
