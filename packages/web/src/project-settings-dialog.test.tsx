// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelInfo, Settings } from "@claude-ui/protocol";
import type { Request } from "./client.ts";
import { ProjectSettingsDialog } from "./project-settings-dialog.tsx";

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

const MODELS: ModelInfo[] = [
  { value: "default", displayName: "Default (recommended)", description: "" },
  { value: "opus", displayName: "Opus", description: "" },
];

async function render({ side = "local", overrides = {}, refuse }: { side?: string; overrides?: Settings["projects"]["overrides"]; refuse?: string } = {}) {
  let settings = { sessions: { defaultMode: "plan", engine: "claude" }, inlineTask: { model: "haiku", openCodeModel: "" }, history: { enabled: true, exclude: [] }, claude: { account: "" }, projects: { overrides } } as unknown as Settings;
  const calls: Request[] = [];
  const request = vi.fn(async (msg: Request) => {
    calls.push(msg);
    if (msg.type === "settings.set") {
      if (refuse) throw new Error(refuse);
      settings = { ...settings, projects: { overrides: (msg.patch as { projects: Settings["projects"] }).projects.overrides } };
    }
    return { settings, daemon: { claudeEnvToken: false }, claudeAccounts: [{ id: "a1", name: "Work" }] };
  });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const loadModels = vi.fn();
  await act(async () => {
    root!.render(<ProjectSettingsDialog open cwd="/p" name="proj" side={side} engines={["claude", "opencode"]} modelsOf={() => MODELS} loadModels={loadModels} request={request as never} onClose={() => {}} />);
  });
  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const patches = () => calls.filter((c) => c.type === "settings.set").map((c) => (c as { patch: { projects: Settings["projects"] } }).patch.projects.overrides);
  return { q, patches, loadModels };
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
  expect(patches()).toEqual([{ local: { "/p": { effort: "high" } } }]);
  expect(q("project-effort-status")!.textContent).toBe("Project");
  expect(q("project-effort-select")!.textContent).toContain("High");
  await click(q("project-effort-reset"));
  expect(patches()[1]).toEqual({});
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
  expect(patches().at(-1)).toEqual({ local: { "/p": { mode: "acceptEdits", model: "opus", history: { enabled: false }, account: "a1" } } });
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
  expect(patches()).toEqual([{ "wsl:Ubuntu": { "/p": { effort: "low" } } }]);
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
