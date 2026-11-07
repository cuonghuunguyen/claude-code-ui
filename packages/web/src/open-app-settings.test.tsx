// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SettingsResult } from "@claude-ui/protocol";
import { OpenAppSection } from "./open-app-settings.tsx";
import { customEditor } from "./open-external-menu.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => (act(() => root?.unmount()), (document.body.innerHTML = "")));

const type = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
async function setup(fail?: { code: string; message: string }, hold?: Promise<void>) {
  const request = vi.fn(async (_m: unknown) => {
    await hold;
    if (fail) throw Object.assign(new Error(fail.message), { code: fail.code });
    return {} as SettingsResult;
  });
  const onResult = vi.fn();
  const onError = vi.fn();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<OpenAppSection editor={{ command: "", name: "" }} saving={false} request={request as never} onResult={onResult} onError={onError} />));
  const q = (id: string) => document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
  const edit = async (id: string, v: string, how: "blur" | "enter" = "blur") => {
    const input = q(id);
    await act(async () => (input.focus(), type(input, v)));
    await act(async () => (how === "blur" ? input.blur() : void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))));
  };
  return { q, edit, request, onResult, onError };
}

it("saves the trimmed command on blur and the name on Enter", async () => {
  const { edit, request, onResult } = await setup();
  await edit("settings-openapp-command", "  subl {path}  ");
  await edit("settings-openapp-name", "Sublime", "enter");
  expect(request.mock.calls.map((c) => c[0])).toEqual([
    { type: "settings.set", patch: { editor: { command: "subl {path}" } } },
    { type: "settings.set", patch: { editor: { name: "Sublime" } } },
  ]);
  expect(onResult).toHaveBeenCalledTimes(2);
});

it("sends nothing for an unchanged value", async () => {
  const { edit, request } = await setup();
  await edit("settings-openapp-command", "  ");
  expect(request).not.toHaveBeenCalled();
});

it("bad_settings keeps the draft and shows a linked alert; typing clears it", async () => {
  const { q, edit } = await setup({ code: "bad_settings", message: "Editor command must be one line" });
  await edit("settings-openapp-command", 'subl "x');
  const input = q("settings-openapp-command");
  const err = q("settings-openapp-command-error");
  expect(input.value).toBe('subl "x');
  expect(err.getAttribute("role")).toBe("alert");
  expect(err.textContent).toBe("Editor command must be one line");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")).toContain(err.id);
  await act(async () => type(input, 'subl "x"'));
  expect(q("settings-openapp-command-error")).toBeNull();
});

it("not_local shows the fixed copy; another failure goes to onError", async () => {
  const a = await setup({ code: "not_local", message: "x" });
  await a.edit("settings-openapp-command", "subl");
  expect(a.q("settings-openapp-command-error").textContent).toBe("Only a browser on the daemon machine can change the editor command.");
  act(() => root?.unmount());
  document.body.innerHTML = "";
  const b = await setup({ code: "disconnected", message: "gone" });
  await b.edit("settings-openapp-command", "subl");
  expect(b.onError).toHaveBeenCalledWith("gone");
});

it("customEditor labels by name, else program name; none without a command", () => {
  expect(customEditor({ command: 'subl {path}', name: "" })).toEqual([{ id: "custom", label: "subl" }]);
  expect(customEditor({ command: '"C:\\Program Files\\Sublime Text\\subl.exe" {path}', name: "" })).toEqual([{ id: "custom", label: "subl" }]);
  expect(customEditor({ command: "subl", name: "My Editor" })).toEqual([{ id: "custom", label: "My Editor" }]);
  expect(customEditor({ command: "", name: "X" })).toEqual([]);
});

it("inputs are disabled while the section's own save is pending", async () => {
  let release = () => {};
  const { q, edit } = await setup(undefined, new Promise<void>((r) => (release = r)));
  await edit("settings-openapp-command", "subl");
  expect(q("settings-openapp-command").disabled).toBe(true);
  expect(q("settings-openapp-name").disabled).toBe(true);
  await act(async () => release());
  expect(q("settings-openapp-command").disabled).toBe(false);
});
