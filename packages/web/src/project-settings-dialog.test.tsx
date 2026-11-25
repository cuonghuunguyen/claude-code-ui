// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelInfo, ProjectOverrides, Settings } from "@claude-ui/protocol";
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

async function render({ side = "local", overrides = {}, refuse, tokens, hold, refuseWhen, projectPatch }: { projectPatch?: boolean; side?: string; overrides?: Settings["projects"]["overrides"]; refuse?: string; tokens?: string[]; hold?: string; refuseWhen?: string } = {}) {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let saved = tokens;
  let settings = { jira: { url: "https://acme.atlassian.net", email: "ann@example.com", template: "{type}/{key}", jql: "" }, sessions: { defaultMode: "plan", engine: "claude" }, inlineTask: { model: "haiku", openCodeModel: "" }, history: { enabled: true, exclude: [] }, claude: { account: "" }, git: { commitMessageInstruction: "Global rule", commitMessageInstructions: { "/other": "Other rule" } }, labels: { projects: { "/other": { name: "Other" } }, sides: {} }, projects: { overrides } } as unknown as Settings;
  const calls: Request[] = [];
  const request = vi.fn(async (msg: Request) => {
    calls.push(msg);
    if (msg.type === hold) await held;
    if (msg.type === "settings.set") {
      if (refuse && (!refuseWhen || JSON.stringify(msg).includes(refuseWhen))) throw new Error(refuse);
      const patch = msg.patch as { projects?: Settings["projects"]; git?: Partial<Settings["git"]>; labels?: Partial<Settings["labels"]> };
      settings = { ...settings, ...(patch.projects && { projects: { overrides: patch.projects.overrides } }), ...(patch.git && { git: { ...settings.git, ...patch.git } }), ...(patch.labels && { labels: { ...settings.labels, ...patch.labels } }) };
    }
    if (msg.type === "settings.project") {
      if (refuse) throw new Error(refuse);
      const { side: sd, cwd: c, overrides: o } = msg as unknown as { side: string; cwd: string; overrides: ProjectOverrides | null };
      const { [c]: _, ...rest } = settings.projects.overrides[sd] ?? {};
      const side2 = o ? { ...rest, [c]: o } : rest;
      const { [sd]: __, ...others } = settings.projects.overrides;
      settings = { ...settings, projects: { overrides: { ...others, ...(Object.keys(side2).length && { [sd]: side2 }) } } };
    }
    if (msg.type === "jira.token") {
      if (refuse) throw new Error(refuse);
      const origin = jiraOriginOf(jiraOf(settings.projects.overrides, side, "/p", settings.jira).url);
      saved = msg.token === null ? saved?.filter((o) => o !== origin) : [...new Set([...(saved ?? []), origin])];
    }
    if (msg.type === "jira.test") return { user: "Dana Center" };
    return { settings, ...(projectPatch && { projectPatch: true }), daemon: { claudeEnvToken: false }, claudeAccounts: [{ id: "a1", name: "Work" }], ...(saved && { jiraTokens: saved }) };
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
  const patches = () => calls.filter((c) => c.type === "settings.set" && (c as { patch: { projects?: unknown } }).patch.projects).map((c) => (c as { patch: { projects: Settings["projects"] } }).patch.projects.overrides);
  const sets = () => calls.filter((c) => c.type === "settings.set").map((c) => (c as { patch: unknown }).patch);
  return { sets, q, patches, loadModels, requests, release: () => act(async () => release()) };
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

it("a daemon with the per-Project patch gets only this Project's entry (null when it empties) and never the whole map (GH-903)", async () => {
  const { q, requests, sets } = await render({ projectPatch: true, overrides: { local: { "/other": { mode: "auto" } }, "ssh:x": { "/p": { effort: "low" } } } });
  await click(q("project-effort-select"));
  await click(q("project-effort-high"));
  expect(requests("settings.project")[0]).toMatchObject({ side: "local", cwd: "/p", overrides: { effort: "high", engine: "claude" } });
  await click(q("project-effort-reset"));
  await click(q("project-engine-reset"));
  expect(requests("settings.project").at(-1)).toMatchObject({ side: "local", cwd: "/p", overrides: null });
  expect(sets()).toEqual([]);
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

it("commit message generator rows save under commitMessage and keep the other fields; the engine placeholder is the global one", async () => {
  const { q, patches } = await render();
  await click(q("project-commit-engine-select"));
  await click(q("project-commit-engine-opencode"));
  expect(patches()).toEqual([{ local: { "/p": { commitMessage: { engine: "opencode" } } } }]);
  const input = q("project-commit-opencode-input") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "deepseek/flash-1");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(patches()[1]).toEqual({ local: { "/p": { commitMessage: { engine: "opencode", openCodeModel: "deepseek/flash-1" } } } });
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
  expect(q("project-jira-token-shared")!.textContent).toContain("1 other project.");
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

it("Jira: the refused URL stays in the input and the message names the field", async () => {
  const { q } = await render({ tokens: [], refuse: "Jira URL must be an https address (http only for localhost or 127.0.0.1)" });
  await typeInto("project-jira-url-input", "http://jira.example.com");
  await enter("project-jira-url-input");
  expect(q("project-jira-url-error")!.textContent).toContain("Jira URL must be an https address");
  expect((q("project-jira-url-input") as HTMLInputElement).value).toBe("http://jira.example.com");
});

it("Jira: a refused URL does not stay in the input once another field's save took the message away", async () => {
  const { q } = await render({ tokens: [], refuse: "Jira URL must be an https address", refuseWhen: "http://jira.example.com" });
  await typeInto("project-jira-url-input", "http://jira.example.com");
  await enter("project-jira-url-input");
  expect(q("project-jira-url-error")).not.toBeNull();
  await click(q("project-mode-select"));
  await click(q("project-mode-plan"));
  expect(q("project-jira-url-error")).toBeNull();
  expect((q("project-jira-url-input") as HTMLInputElement).value).toBe("");
});

it("Jira: clearing a token that others use asks first and names who loses it; an unshared token clears at once", async () => {
  const overrides = { local: { "/p": { jira: { url: "https://jira.example.com" } }, "/x": { jira: { url: "https://jira.example.com" } } } };
  const { q, requests } = await render({ overrides, tokens: ["https://jira.example.com"] });
  await click(q("project-jira-token-clear"));
  expect(requests("jira.token")).toEqual([]);
  const dialog = document.querySelector('[data-testid="project-jira-clear-dialog"]')!;
  expect(dialog.textContent).toContain("1 other project");
  await click(document.querySelector('[data-testid="project-jira-clear-cancel"]'));
  expect(requests("jira.token")).toEqual([]);
  await click(q("project-jira-token-clear"));
  await click(document.querySelector('[data-testid="project-jira-clear-confirm"]'));
  expect(requests("jira.token")).toEqual([{ type: "jira.token", token: null, project: { side: "local", cwd: "/p" } }]);
});

it("Jira: the spinner is only on the button that runs (Test connection while testing, not while Save or Clear runs)", async () => {
  const overrides = { local: { "/p": { jira: { url: "https://jira.example.com" } } } };
  const spinner = (q: (id: string) => HTMLElement | null) => q("project-jira-test")!.querySelector("svg.animate-spin");
  const saving = await render({ overrides, tokens: [], hold: "jira.token" });
  await typeInto("project-jira-token", "tok");
  await click(saving.q("project-jira-token-save"));
  expect(spinner(saving.q)).toBeNull();
  await saving.release();
  act(() => root?.unmount());
  document.body.innerHTML = "";
  const testing = await render({ overrides, tokens: ["https://jira.example.com"], hold: "jira.test" });
  await click(testing.q("project-jira-test"));
  expect(spinner(testing.q)).not.toBeNull();
  await testing.release();
  expect(spinner(testing.q)).toBeNull();
});

const fill = async (el: HTMLTextAreaElement | HTMLInputElement, v: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => void el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
};

it("the commit message instruction row saves this project's key in the map and keeps the other projects' keys; blank removes only its key (GH-902)", async () => {
  const { q, sets } = await render();
  const ta = q("project-commit-instruction-input") as HTMLTextAreaElement;
  expect(ta.placeholder).toBe("Global rule");
  await fill(ta, "  Use Vietnamese.  ");
  expect(sets().at(-1)).toEqual({ git: { commitMessageInstructions: { "/other": "Other rule", "/p": "Use Vietnamese." } } });
  expect((q("project-commit-instruction-input") as HTMLTextAreaElement).value).toBe("Use Vietnamese.");
  await fill(q("project-commit-instruction-input") as HTMLTextAreaElement, "   ");
  expect(sets().at(-1)).toEqual({ git: { commitMessageInstructions: { "/other": "Other rule" } } });
});

it("the Label row opens the name and icon dialog, saves into labels.projects with the other keys kept, and Reset removes only this key (GH-902)", async () => {
  const { q, sets } = await render();
  expect(q("project-label-name")!.textContent).toBe("proj");
  await click(q("project-label-edit"));
  const name = document.querySelector<HTMLInputElement>('[data-testid="label-name"]')!;
  await fill(name, "  Shop  ");
  await click(document.querySelector<HTMLElement>('[data-testid="label-save"]'));
  expect(sets().at(-1)).toEqual({ labels: { projects: { "/other": { name: "Other" }, "/p": { name: "Shop" } } } });
  expect(document.querySelector('[data-testid="label-dialog"]')).toBeNull();
  expect(q("project-label-name")!.textContent).toBe("Shop");
  await click(q("project-label-edit"));
  await click(document.querySelector<HTMLElement>('[data-testid="label-reset"]'));
  expect(sets().at(-1)).toEqual({ labels: { projects: { "/other": { name: "Other" } } } });
});

it("a refused label stays in the label dialog with the daemon's message", async () => {
  const { q } = await render({ refuse: "Label name too long", refuseWhen: "labels" });
  await click(q("project-label-edit"));
  await fill(document.querySelector<HTMLInputElement>('[data-testid="label-name"]')!, "x");
  await click(document.querySelector<HTMLElement>('[data-testid="label-save"]'));
  expect(document.querySelector('[data-testid="label-error"]')!.textContent).toBe("Label name too long");
});

it("a refused commit message instruction shows under the row and keeps the typed text; the label dialog returns focus to its button", async () => {
  const { q } = await render({ refuse: "Instruction too long", refuseWhen: "commitMessageInstructions" });
  await fill(q("project-commit-instruction-input") as HTMLTextAreaElement, "x");
  expect(q("project-commit-instruction-error")!.textContent).toBe("Instruction too long");
  const edit = q("project-label-edit")!;
  await click(edit);
  await click(document.querySelector<HTMLElement>('[data-testid="label-cancel"]'));
  expect(document.activeElement).toBe(edit);
});
