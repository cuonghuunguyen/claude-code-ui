// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelInfo, Settings } from "@claude-ui/protocol";
import type { Request } from "./client.ts";
import { ProjectSettingsDialog } from "./project-settings-dialog.tsx";
import { jiraOf, jiraOriginOf } from "./project-settings.ts";

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

const MODELS: ModelInfo[] = [
  { value: "default", displayName: "Default (recommended)", description: "" },
  { value: "opus", displayName: "Opus", description: "" },
];

async function render({ side = "local", overrides = {}, refuse, tokens }: { side?: string; overrides?: Settings["projects"]["overrides"]; refuse?: string; tokens?: string[] } = {}) {
  let saved = tokens;
  let settings = { jira: { url: "https://acme.atlassian.net", email: "ann@example.com", template: "{type}/{key}", jql: "" }, sessions: { defaultMode: "plan", engine: "claude" }, inlineTask: { model: "haiku", openCodeModel: "" }, history: { enabled: true, exclude: [] }, claude: { account: "" }, projects: { overrides } } as unknown as Settings;
  const calls: Request[] = [];
  const request = vi.fn(async (msg: Request) => {
    calls.push(msg);
    if (msg.type === "settings.set") {
      if (refuse) throw new Error(refuse);
      settings = { ...settings, projects: { overrides: (msg.patch as { projects: Settings["projects"] }).projects.overrides } };
    }
    if (msg.type === "jira.token") {
      if (refuse) throw new Error(refuse);
      const origin = jiraOriginOf(jiraOf(settings.projects.overrides, side, "/p", settings.jira).url);
      saved = msg.token === null ? saved?.filter((o) => o !== origin) : [...new Set([...(saved ?? []), origin])];
    }
    if (msg.type === "jira.test") return { user: "Dana Center" };
    return { settings, daemon: { claudeEnvToken: false }, claudeAccounts: [{ id: "a1", name: "Work" }], ...(saved && { jiraTokens: saved }) };
  });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const loadModels = vi.fn();
  await act(async () => {
    root!.render(<ProjectSettingsDialog open cwd="/p" name="proj" side={side} engines={["claude", "opencode"]} modelsOf={() => MODELS} loadModels={loadModels} request={request as never} onClose={() => {}} />);
  });
  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const requests = (type: string) => calls.filter((c) => c.type === type);
  const patches = () => calls.filter((c) => c.type === "settings.set").map((c) => (c as { patch: { projects: Settings["projects"] } }).patch.projects.overrides);
  return { q, patches, loadModels, requests };
}
const click = (el: HTMLElement | null | undefined) => act(async () => el!.click());

it("an unset field shows Global (<value>) and no reset", async () => {
  const { q } = await render();
  expect(q("project-mode-select")!.textContent).toContain("Global (Plan mode)");
  expect(q("project-engine-select")!.textContent).toContain("Global (Claude)");
  expect(q("project-history-select")!.textContent).toContain("Global (On)");
  expect(q("project-model-select")!.textContent).toContain("Global (Default)");
  expect(q("project-mode-status")!.textContent).toBe("Global");
  expect((q("project-mode-reset") as HTMLButtonElement).disabled).toBe(true);
});

it("setting a field saves the whole map, shows Project and a reset that unsets it", async () => {
  const { q, patches } = await render();
  await click(q("project-effort-select"));
  await click(q("project-effort-high"));
  expect(patches()).toEqual([{ local: { "/p": { effort: "high", engine: "claude" } } }]);
  expect(q("project-effort-status")!.textContent).toBe("Project");
  expect(q("project-effort-select")!.textContent).toContain("High");
  await click(q("project-effort-reset"));
  expect(patches()[1]).toEqual({ local: { "/p": { engine: "claude" } } });
  expect(q("project-effort-status")!.textContent).toBe("Global");
});

it("each select field can be set: mode, model, history off, account", async () => {
  const { q, patches } = await render();
  await click(q("project-mode-select"));
  await click(q("project-mode-acceptEdits"));
  await click(q("project-model-select"));
  await click(q("project-model-opus"));
  await click(q("project-history-select"));
  await click(q("project-history-off"));
  await click(q("project-account-select"));
  await click(q("project-account-a1"));
  expect(patches().at(-1)).toEqual({ local: { "/p": { mode: "acceptEdits", model: "opus", engine: "claude", history: { enabled: false }, account: "a1" } } });
});

it("setting a model or effort also saves the Engine the Project uses now; with an Engine override it stays", async () => {
  const { q, patches } = await render();
  await click(q("project-model-select"));
  await click(q("project-model-opus"));
  expect(patches()).toEqual([{ local: { "/p": { model: "opus", engine: "claude" } } }]);
  await click(q("project-effort-select"));
  await click(q("project-effort-low"));
  expect(patches()[1]).toEqual({ local: { "/p": { model: "opus", engine: "claude", effort: "low" } } });
});

it("changing the Engine clears the model and effort of the Project", async () => {
  const { q, patches } = await render({ overrides: { local: { "/p": { model: "opus", effort: "high", mode: "plan" } } } });
  await click(q("project-engine-select"));
  await click(q("project-engine-opencode"));
  expect(patches()).toEqual([{ local: { "/p": { engine: "opencode", mode: "plan" } } }]);
});

it("a text field saves on Enter, empty unsets it, the placeholder is the global value", async () => {
  const { q, patches } = await render();
  const input = q("project-inline-model-input") as HTMLInputElement;
  expect(input.placeholder).toBe("Global (haiku)");
  const set = (v: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  await act(async () => set("sonnet"));
  await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(patches()).toEqual([{ local: { "/p": { inlineTask: { model: "sonnet" } } } }]);
  expect(q("project-inline-model-status")!.textContent).toBe("Project");
  await act(async () => set(""));
  await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(patches()[1]).toEqual({});
});

it("a Project on another Side keys its entry by the Side and has no account row", async () => {
  const { q, patches } = await render({ side: "wsl:Ubuntu" });
  expect(q("project-account")).toBeNull();
  expect(q("project-account-side")).not.toBeNull();
  await click(q("project-effort-select"));
  await click(q("project-effort-low"));
  expect(patches()).toEqual([{ "wsl:Ubuntu": { "/p": { effort: "low", engine: "claude" } } }]);
});

it("the daemon's refusal shows under the field", async () => {
  const { q } = await render({ refuse: "Jira URL must be https" });
  await click(q("project-mode-select"));
  await click(q("project-mode-plan"));
  expect(q("project-mode-error")!.textContent).toBe("Jira URL must be https");
  expect(q("project-mode-status")!.textContent).toBe("Global");
});

it("asks for the model list of the Project's Engine", async () => {
  const { loadModels } = await render({ overrides: { local: { "/p": { engine: "opencode" } } } });
  expect(loadModels).toHaveBeenCalledWith("opencode");
});

const GLOBAL_ORIGIN = "https://acme.atlassian.net";
const typeInto = (id: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
  return act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const enter = (id: string) => act(async () => void document.querySelector(`[data-testid="${id}"]`)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

it("Jira: a daemon without Jira per Project (no jiraTokens) shows no Jira group", async () => {
  const { q } = await render();
  expect(q("project-settings-jira")).toBeNull();
});

it("Jira: URL, ticket filter and template are overrides with the global value as placeholder; the Cloud email shows for a Cloud URL", async () => {
  const { q, patches } = await render({ tokens: [GLOBAL_ORIGIN] });
  expect((q("project-jira-url-input") as HTMLInputElement).placeholder).toBe(`Global (${GLOBAL_ORIGIN})`);
  expect((q("project-jira-email-input") as HTMLInputElement).placeholder).toBe("Global (ann@example.com)");
  expect((q("project-jira-template-input") as HTMLInputElement).placeholder).toBe("Global ({type}/{key})");
  await typeInto("project-jira-jql-input", "project = PRJ");
  await enter("project-jira-jql-input");
  await typeInto("project-jira-url-input", "https://jira.example.com");
  await enter("project-jira-url-input");
  expect(patches().at(-1)).toEqual({ local: { "/p": { jira: { jql: "project = PRJ", url: "https://jira.example.com" } } } });
  expect(q("project-jira-url-status")!.textContent).toBe("Project");
  // A non-Cloud URL needs no email.
  expect(q("project-jira-email")).toBeNull();
  await click(q("project-jira-url-reset"));
  expect(patches().at(-1)).toEqual({ local: { "/p": { jira: { jql: "project = PRJ" } } } });
  expect(q("project-jira-email")).not.toBeNull();
});

it("Jira: without its own URL the Project uses the global token and cannot change it", async () => {
  const { q, requests } = await render({ tokens: [GLOBAL_ORIGIN] });
  expect(q("project-jira-token-global")).not.toBeNull();
  expect(q("project-jira-token")).toBeNull();
  expect(requests("jira.token")).toEqual([]);
});

it("Jira: the token of a Project's own URL is saved, tested and cleared for that Project, never as the global one", async () => {
  const { q, requests } = await render({ overrides: { local: { "/p": { jira: { url: "https://jira.example.com" } } } }, tokens: [GLOBAL_ORIGIN] });
  expect(q("project-jira-token-status")!.textContent).toBe("No token for https://jira.example.com");
  expect((q("project-jira-test") as HTMLButtonElement).disabled).toBe(true);
  await typeInto("project-jira-token", "  tok-123 ");
  await click(q("project-jira-token-save"));
  expect(requests("jira.token")).toEqual([{ type: "jira.token", token: "tok-123", project: { side: "local", cwd: "/p" } }]);
  expect(q("project-jira-token-status")!.textContent).toBe("Token saved for https://jira.example.com");
  expect(document.body.innerHTML).not.toContain("tok-123");
  await click(q("project-jira-test"));
  expect(requests("jira.test")).toEqual([{ type: "jira.test", project: { side: "local", cwd: "/p" } }]);
  expect(q("project-jira-test-result")!.textContent).toBe("Connected as Dana Center");
  await click(q("project-jira-token-clear"));
  expect(requests("jira.token").at(-1)).toEqual({ type: "jira.token", token: null, project: { side: "local", cwd: "/p" } });
  expect(q("project-jira-token-status")!.textContent).toBe("No token for https://jira.example.com");
});

it("Jira: a Project on a Side sends its Side id; a token shared with the global settings or other Projects says so", async () => {
  const overrides = { "ssh:box": { "/p": { jira: { url: "https://jira.example.com/a" } } }, local: { "/x": { jira: { url: "https://jira.example.com/b" } } }, "wsl:U": { "/y": { jira: { url: GLOBAL_ORIGIN } }, "/z": { jira: { url: "https://other.example.com" } } } };
  const { q, requests } = await render({ side: "ssh:box", overrides, tokens: [] });
  expect(q("project-jira-token-shared")!.textContent).toContain("1 other");
  await typeInto("project-jira-token", "tok");
  await click(q("project-jira-token-save"));
  expect(requests("jira.token")[0]).toMatchObject({ project: { side: "ssh:box", cwd: "/p" } });
  act(() => root?.unmount());
  document.body.innerHTML = "";
  const second = await render({ side: "ssh:box", overrides: { ...overrides, "ssh:box": { "/p": { jira: { url: GLOBAL_ORIGIN } } } }, tokens: [] });
  expect(second.q("project-jira-token-shared")!.textContent).toContain("global");
});

it("Jira: a refused token shows under the token", async () => {
  const { q } = await render({ overrides: { local: { "/p": { jira: { url: "https://jira.example.com" } } } }, tokens: [], refuse: "The token must be 1 to 2000 printable characters without spaces" });
  await typeInto("project-jira-token", "tok");
  await click(q("project-jira-token-save"));
  expect(q("project-jira-token-error")!.textContent).toContain("printable");
});
