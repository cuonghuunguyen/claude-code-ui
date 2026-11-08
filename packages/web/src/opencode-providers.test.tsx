// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenCodeProvider, OpenCodeStatus } from "@claude-ui/protocol";
import { OpenCodeProviders } from "./opencode-providers.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const el = document.createElement("div");
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  vi.restoreAllMocks();
});

const api = { type: "api", label: "API key" } as const;
const P = (id: string, extra: Partial<OpenCodeProvider> = {}): OpenCodeProvider => ({ id, name: id[0]!.toUpperCase() + id.slice(1), connected: false, methods: [api], ...extra });
const base = [P("envp", { connected: true, source: "env" }), P("cfgp", { connected: true, source: "config" }), P("groq"), P("fake", { methods: [{ type: "oauth", label: "Browser login" }, { type: "oauth", label: "Code login" }, api] })];
const q = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string) => [...el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const set = (e: HTMLElement, v: string) => {
  const proto = e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(e, v);
  e.dispatchEvent(new Event(e instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
};
const type = (id: string, v: string) => act(async () => set(q(id)!, v));
const click = (e: HTMLElement | null) => act(async () => e!.click());
const blur = (id: string) => act(async () => (q(id)!.focus(), q(id)!.blur()));
const row = (id: string) => all("settings-opencode-connect-row").find((r) => r.dataset.providerId === id)!;

async function render(handler: (m: any) => unknown, status: OpenCodeStatus = { state: "running", version: "1.18.35" }, onProviders = () => {}) {
  const calls: any[] = [];
  const request = vi.fn(async (m: any) => (calls.push(m), handler(m)));
  await act(async () => root.render(<OpenCodeProviders status={status} request={request as never} onProviders={onProviders} />));
  return { calls, request };
}
const list = (providers = base) => async (m: any) => (m.type === "opencode.providers" ? { providers } : undefined);

it("a running server loads the list at once: connected rows show a status text; env and config have no Log out; the empty-state button focuses the search", async () => {
  await render(list());
  expect(all("settings-opencode-provider-row").map((r) => [r.dataset.providerId, r.querySelector('[data-testid="settings-opencode-provider-status"]')!.textContent])).toEqual([["envp", "Connected · environment variable"], ["cfgp", "Connected · OpenCode config"]]);
  expect(all("settings-opencode-logout")).toHaveLength(0);
  expect(q("settings-opencode-providers-empty")).toBeNull();
});

it("with no connected provider the empty state names the free models and its button focuses the search", async () => {
  await render(list([P("groq")]));
  expect(q("settings-opencode-providers-empty")!.textContent).toContain("No provider connected");
  await click(q("settings-opencode-providers-connect"));
  expect(document.activeElement).toBe(q("settings-opencode-connect-search"));
});

it("a stopped server loads nothing until Show providers; missing hides the block", async () => {
  const { calls } = await render(list(), { state: "stopped", version: "1" });
  expect(calls).toEqual([]);
  expect(q("settings-opencode-providers")!.textContent).toContain("OpenCode is not running.");
  await click(q("settings-opencode-providers-load"));
  expect(calls).toEqual([{ type: "opencode.providers" }]);
  expect(all("settings-opencode-connect-row").length).toBeGreaterThan(0);
  act(() => root.unmount());
  root = createRoot(el);
  await render(list(), { state: "missing" });
  expect(q("settings-opencode-providers")).toBeNull();
});

it("search filters not-connected providers by name and id", async () => {
  await render(list());
  expect(all("settings-opencode-connect-row")).toHaveLength(2);
  await type("settings-opencode-connect-search", "GRO");
  expect(all("settings-opencode-connect-row").map((r) => r.dataset.providerId)).toEqual(["groq"]);
  await type("settings-opencode-connect-search", "zzz");
  expect(all("settings-opencode-connect-row")).toHaveLength(0);
});

it("API key: blur empty and a key with a space show an error under the field; submit sends the key, shows busy, then the connected row and a status line", async () => {
  let done!: (v: unknown) => void;
  const onProviders = vi.fn();
  const { calls } = await render(async (m) => (m.type === "opencode.providers" ? { providers: base } : new Promise((r) => (done = r))), undefined, onProviders);
  await click(row("groq"));
  expect(q("settings-opencode-key")!.getAttribute("type")).toBe("password");
  expect(q("settings-opencode-key")!.getAttribute("autocomplete")).toBe("off");
  await blur("settings-opencode-key");
  expect(q("settings-opencode-key-error")!.textContent).toBe("Enter the API key");
  expect(q("settings-opencode-key")!.getAttribute("aria-invalid")).toBe("true");
  expect(q("settings-opencode-key")!.getAttribute("aria-describedby")).toBe(q("settings-opencode-key-error")!.id);
  await type("settings-opencode-key", "sk test");
  await blur("settings-opencode-key");
  expect(q("settings-opencode-key-error")!.textContent).toBe("An API key has no spaces");
  await type("settings-opencode-key", "sk-throwaway");
  expect(q("settings-opencode-key-error")).toBeNull();
  await click(q("settings-opencode-login-submit"));
  expect(calls.at(-1)).toEqual({ type: "opencode.login", provider: "groq", method: 0, key: "sk-throwaway" });
  expect(q("settings-opencode-login-submit")!.getAttribute("aria-busy")).toBe("true");
  expect(q("settings-opencode-login-submit")!.querySelector("svg.animate-spin")).not.toBeNull();
  await act(async () => done({ providers: [P("groq", { connected: true, source: "api" }), ...base.filter((p) => p.id !== "groq")] }));
  expect(q("settings-opencode-providers-message")!.textContent).toBe("Connected to Groq");
  expect(q("settings-opencode-providers-message")!.getAttribute("role")).toBe("status");
  const r = all("settings-opencode-provider-row").find((x) => x.dataset.providerId === "groq")!;
  expect(r.querySelector('[data-testid="settings-opencode-provider-status"]')!.textContent).toBe("Connected · API key");
  expect(document.activeElement).toBe(r.querySelector('[data-testid="settings-opencode-logout"]'));
  expect(q("settings-opencode-key")).toBeNull();
  expect(onProviders).toHaveBeenCalledTimes(1);
});

it("a daemon error `key: …` lands under the field; another error shows under the form; the values stay and Connect works again", async () => {
  let n = 0;
  await render(async (m) => {
    if (m.type === "opencode.providers") return { providers: base };
    throw Object.assign(new Error(++n === 1 ? "key: Enter the API key" : "OpenCode answered 500: boom"), { code: "login_failed" });
  });
  await click(row("groq"));
  await type("settings-opencode-key", "sk-x");
  await click(q("settings-opencode-login-submit"));
  expect(q("settings-opencode-key-error")!.textContent).toBe("Enter the API key");
  await click(q("settings-opencode-login-submit"));
  expect(q("settings-opencode-login-error")!.textContent).toBe("OpenCode answered 500: boom");
  expect(q("settings-opencode-login-error")!.getAttribute("role")).toBe("alert");
  expect((q("settings-opencode-key") as HTMLInputElement).value).toBe("sk-x");
  expect((q("settings-opencode-login-submit") as HTMLButtonElement).disabled).toBe(false);
});

it("prompts: a select drives a `when` text; shown values go out as inputs", async () => {
  const methods = [{ type: "api" as const, label: "API key", prompts: [{ type: "select" as const, key: "deploymentType", message: "Deployment", options: [{ label: "GitHub.com", value: "github" }, { label: "Enterprise", value: "enterprise" }] }, { type: "text" as const, key: "enterpriseUrl", message: "Enterprise URL", placeholder: "company.ghe.com", when: { key: "deploymentType", op: "eq" as const, value: "enterprise" } }] }];
  const { calls } = await render(async (m) => { if (m.type === "opencode.providers") return { providers: [P("copilot", { methods })] }; throw new Error("stay"); });
  await click(row("copilot"));
  expect(q("settings-opencode-prompt-enterpriseUrl")).toBeNull();
  await type("settings-opencode-key", "k");
  await click(q("settings-opencode-login-submit"));
  expect(calls.at(-1)).toEqual({ type: "opencode.login", provider: "copilot", method: 0, key: "k", inputs: { deploymentType: "github" } });
  await type("settings-opencode-prompt-deploymentType", "enterprise");
  expect(q("settings-opencode-prompt-enterpriseUrl")!.getAttribute("placeholder")).toBe("company.ghe.com");
  await click(q("settings-opencode-login-submit"));
  expect(el.textContent).toContain("Enter Enterprise URL");
  await type("settings-opencode-prompt-enterpriseUrl", "x.ghe.com");
  await click(q("settings-opencode-login-submit"));
  expect(calls.at(-1)).toMatchObject({ inputs: { deploymentType: "enterprise", enterpriseUrl: "x.ghe.com" } });
});

it("the method radio group picks the form", async () => {
  await render(list());
  await click(row("fake"));
  expect(all("settings-opencode-method")).toHaveLength(3);
  expect(q("settings-opencode-key")).toBeNull();
  await click(all("settings-opencode-method")[2]!);
  expect(q("settings-opencode-key")).not.toBeNull();
});

it("OAuth auto: the tab opens before the request, gets the URL, the wait view cancels with loginCancel and the form returns with a status line", async () => {
  const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
  const open = vi.spyOn(window, "open").mockReturnValue(tab as never);
  let finishRejects!: (e: Error) => void;
  const order: string[] = [];
  open.mockImplementation((() => (order.push("open"), tab)) as never);
  const { calls } = await render(async (m) => {
    order.push(m.type);
    if (m.type === "opencode.providers") return { providers: base };
    if (m.type === "opencode.login") return { url: "https://login.example/x", mode: "auto", instructions: "Code: ABCD-1234" };
    if (m.type === "opencode.loginFinish") return new Promise((_, rej) => (finishRejects = rej));
    return {};
  });
  await click(row("fake"));
  await click(q("settings-opencode-login-submit"));
  expect(order.slice(-3)).toEqual(["open", "opencode.login", "opencode.loginFinish"]);
  expect(tab.opener).toBeNull();
  expect(tab.location.href).toBe("https://login.example/x");
  expect(q("settings-opencode-connect-form")!.textContent).toContain("Code: ABCD-1234");
  expect(q("settings-opencode-oauth-wait")!.querySelector("svg.animate-spin")).not.toBeNull();
  const a = q("settings-opencode-connect-form")!.querySelector("a")!;
  expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  expect(a.getAttribute("target")).toBe("_blank");
  await click(q("settings-opencode-login-cancel"));
  expect(calls.at(-1)).toEqual({ type: "opencode.loginCancel", provider: "fake" });
  await act(async () => (finishRejects(Object.assign(new Error("Login cancelled"), { code: "cancelled" })), await new Promise((r) => setTimeout(r, 200))));
  expect(q("settings-opencode-providers-message")!.textContent).toBe("Login cancelled");
  expect(q("settings-opencode-oauth-wait")).toBeNull();
  expect(q("settings-opencode-login-error")).toBeNull();
  expect(q("settings-opencode-login-submit")).not.toBeNull();
});

it("an unsafe login URL closes the tab, shows the URL as text and an error", async () => {
  const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(tab as never);
  const { calls } = await render(async (m) => (m.type === "opencode.providers" ? { providers: base } : { url: "javascript:alert(1)", mode: "auto", instructions: "" }));
  await click(row("fake"));
  await click(q("settings-opencode-login-submit"));
  expect(tab.close).toHaveBeenCalled();
  expect(tab.location.href).toBe("");
  expect(q("settings-opencode-login-error")!.textContent).toContain("javascript:alert(1)");
  expect(calls.some((c) => c.type === "opencode.loginFinish")).toBe(false);
});

it("OAuth code: a wrong code shows an error under the field and can be retried", async () => {
  vi.spyOn(window, "open").mockReturnValue({ opener: {}, location: { href: "" }, close: vi.fn() } as never);
  let tries = 0;
  const { calls } = await render(async (m) => {
    if (m.type === "opencode.providers") return { providers: base };
    if (m.type === "opencode.login") return { url: "https://login.example/c", mode: "code", instructions: "Paste the code" };
    if (++tries === 1) throw Object.assign(new Error("Login was not completed. Try again."), { code: "login_failed" });
    return { providers: [P("fake", { connected: true, source: "custom" })] };
  });
  await click(row("fake"));
  await click(all("settings-opencode-method")[1]!);
  await click(q("settings-opencode-login-submit"));
  await type("settings-opencode-oauth-code", "bad");
  await click(q("settings-opencode-login-submit"));
  expect(calls.at(-1)).toEqual({ type: "opencode.loginFinish", provider: "fake", method: 1, code: "bad" });
  expect(q("settings-opencode-form-error")).toBeNull();
  expect(el.textContent).toContain("Login was not completed. Try again.");
  expect(q("settings-opencode-oauth-code")!.getAttribute("aria-invalid")).toBe("true");
  await type("settings-opencode-oauth-code", "good");
  await click(q("settings-opencode-login-submit"));
  expect(q("settings-opencode-providers-message")!.textContent).toBe("Connected to Fake");
});

it("Log out asks first: Cancel sends nothing, confirm sends opencode.logout and shows a status line", async () => {
  const onProviders = vi.fn();
  const { calls } = await render(async (m) => (m.type === "opencode.providers" ? { providers: [P("groq", { connected: true, source: "api" })] } : { providers: [P("groq")] }), undefined, onProviders);
  await click(q("settings-opencode-logout"));
  expect(document.body.textContent).toContain("Log out of Groq?");
  await click(document.querySelector<HTMLElement>('[data-testid="settings-opencode-logout-cancel"]'));
  expect(calls.map((c) => c.type)).toEqual(["opencode.providers"]);
  await click(q("settings-opencode-logout"));
  await click(document.querySelector<HTMLElement>('[data-testid="settings-opencode-logout-confirm"]'));
  expect(calls.at(-1)).toEqual({ type: "opencode.logout", provider: "groq" });
  expect(q("settings-opencode-providers-message")!.textContent).toBe("Logged out of Groq");
  expect(q("settings-opencode-providers-empty")).not.toBeNull();
  expect(document.activeElement).toBe(el.querySelector("h4"));
  expect(onProviders).toHaveBeenCalledTimes(1);
});

it("a slow first load shows a loading line with a spinner, then the list", async () => {
  let done!: (v: unknown) => void;
  await render(() => new Promise((r) => (done = r)), { state: "stopped", version: "1" });
  await click(q("settings-opencode-providers-load"));
  expect(q("settings-opencode-providers-loading")!.getAttribute("role")).toBe("status");
  expect(q("settings-opencode-providers-loading")!.querySelector("svg.animate-spin")).not.toBeNull();
  expect(q("settings-opencode-providers-load")).toBeNull();
  await act(async () => done({ providers: base }));
  expect(q("settings-opencode-providers-loading")).toBeNull();
  expect(q("settings-opencode-connect-search")).not.toBeNull();
});
