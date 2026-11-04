// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SideInfo } from "@claude-ui/protocol";
import { OpenProjectDialog } from "./open-project.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => (root?.unmount(), (document.body.innerHTML = "")));

const local: SideInfo = { id: "local", label: "Linux", state: "ready" };
const host = (alias: string): SideInfo => ({ id: `ssh:${alias}`, label: `SSH: ${alias}`, state: "off" });
async function render(o: { ssh?: boolean; onAddSshHost?: (c: string) => Promise<string> } = {}) {
  localStorage.clear();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const show = (sides: SideInfo[]) => act(async () => root!.render(<OpenProjectDialog open onOpenChange={() => {}} list={async () => []} onPick={async () => {}} sides={sides} ssh={o.ssh ?? true} onAddSshHost={o.onAddSshHost ?? (async () => "ssh:x")} />));
  await show([local]);
  const q = <T extends HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
  const click = (el: HTMLElement | null) => act(async () => el!.click());
  const typeIn = async (id: string, v: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(q(id), v);
      q(id)!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = () => act(async () => void q("add-ssh-host-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const sshChip = () => [...document.querySelectorAll<HTMLElement>('[data-testid="side-kind"]')].find((k) => k.textContent === "SSH");
  const openDialog = async () => (await click(sshChip()!), await click(q("add-ssh-host")));
  return { q, click, typeIn, submit, sshChip, show, openDialog };
}

describe("Add SSH host dialog in Open project", () => {
  it("the SSH kind shows with no host in the config when the hub has ssh; its list has the Add SSH host… button, no inline form", async () => {
    const { q, click, sshChip } = await render();
    expect(sshChip()).toBeDefined();
    await click(sshChip()!);
    expect(q("container-row")).toBeNull();
    expect(q("add-ssh-host")!.textContent).toBe("Add SSH host…");
    expect(q("add-ssh-host-dialog")).toBeNull();
  });
  it("a hub without ssh: no SSH kind", async () => {
    const { sshChip } = await render({ ssh: false });
    expect(sshChip()).toBeUndefined();
  });
  it("the button opens its own dialog: one input, nothing to add before a valid command, a preview of what was parsed", async () => {
    const { q, typeIn, openDialog } = await render();
    await openDialog();
    expect(q("add-ssh-host-dialog")!.getAttribute("aria-modal")).toBe("true");
    expect(document.querySelectorAll('[data-testid="add-ssh-host-dialog"] input')).toHaveLength(1);
    expect(q<HTMLButtonElement>("add-ssh-host-submit")!.disabled).toBe(true);
    expect(q("add-ssh-host-preview")).toBeNull();
    await typeIn("add-ssh-host-command", "ssh dev@build.example.com -p 2222 -i ~/.ssh/key -J jump");
    const text = (k: string) => q(`add-ssh-host-preview-${k}`)?.textContent;
    expect([text("alias"), text("host"), text("user"), text("port"), text("key"), text("jump")]).toEqual(["build.example.com", "build.example.com", "dev", "2222", "~/.ssh/key", "jump"]);
    expect(q<HTMLButtonElement>("add-ssh-host-submit")!.disabled).toBe(false);
    await typeIn("add-ssh-host-command", "ssh -X host");
    expect(q("add-ssh-host-invalid")!.textContent).toContain("-X is not supported");
    expect(q("add-ssh-host-preview")).toBeNull();
    expect(q<HTMLButtonElement>("add-ssh-host-submit")!.disabled).toBe(true);
  });
  it("targets are 44 px below md and the dialog is a full-height sheet below sm", async () => {
    const { q, openDialog } = await render();
    await openDialog();
    expect(q("add-ssh-host-dialog")!.className).toContain("max-sm:h-dvh");
    for (const id of ["add-ssh-host-submit", "add-ssh-host-cancel", "add-ssh-host-command"]) expect(q(id)!.className).toContain("max-md:h-11");
  });
  it("Add sends the trimmed command, closes the dialog and the new host is the highlighted row of the list", async () => {
    let r!: Awaited<ReturnType<typeof render>>;
    const onAdd = vi.fn(async (_c: string) => (await r.show([local, host("a"), host("build.example.com")]), "ssh:build.example.com"));
    r = await render({ onAddSshHost: onAdd });
    await r.show([local, host("a")]);
    await r.openDialog();
    await r.typeIn("add-ssh-host-command", "  ssh dev@build.example.com -p 2222  ");
    await r.submit();
    expect(onAdd.mock.calls).toEqual([["ssh dev@build.example.com -p 2222"]]);
    expect(r.q("add-ssh-host-dialog")).toBeNull();
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="container-row"]')];
    expect(rows.map((x) => [x.textContent, x.getAttribute("aria-selected")])).toEqual([["aNot set up", "false"], ["build.example.comNot set up", "true"]]);
    // The keys of the list (arrows, Enter) work at once: the focus is on the filter, not on the Add button.
    expect(document.activeElement).toBe(r.q("container-filter"));
  });
  it("a refusal shows its reason inside the dialog and keeps the command for a retry; Cancel closes it", async () => {
    const onAdd = vi.fn(async (_c: string): Promise<string> => {
      throw new Error('The host "box" already exists in the ssh config. Pick another alias.');
    });
    const { q, click, typeIn, submit, openDialog } = await render({ onAddSshHost: onAdd });
    await openDialog();
    await typeIn("add-ssh-host-command", "ssh box");
    await submit();
    const err = document.querySelector('[data-testid="add-ssh-host-dialog"] [role="alert"]')!;
    expect(err.textContent).toContain("already exists");
    expect(q<HTMLInputElement>("add-ssh-host-command")!.value).toBe("ssh box");
    await typeIn("add-ssh-host-command", "ssh box2");
    expect(document.querySelector('[data-testid="add-ssh-host-dialog"] [role="alert"]')).toBeNull();
    await click(q("add-ssh-host-cancel"));
    expect(q("add-ssh-host-dialog")).toBeNull();
    expect(q("add-ssh-host")).not.toBeNull();
  });
  it("Esc closes only the Add SSH host dialog and returns the focus to its button", async () => {
    const { q, openDialog } = await render();
    await openDialog();
    await act(async () => void q("add-ssh-host-command")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(q("add-ssh-host-dialog")).toBeNull();
    expect(q("open-project-dialog")).not.toBeNull();
    expect(document.activeElement).toBe(q("add-ssh-host"));
  });
});
