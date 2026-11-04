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
async function render(o: { sides?: SideInfo[]; ssh?: boolean; onAddSshHost?: (c: string, a?: string) => Promise<unknown> } = {}) {
  localStorage.clear();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<OpenProjectDialog open onOpenChange={() => {}} list={async () => []} onPick={async () => {}} sides={o.sides ?? [local]} ssh={o.ssh ?? true} onAddSshHost={o.onAddSshHost ?? (async () => {})} />));
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
  return { q, click, typeIn, submit, sshChip };
}

describe("Add SSH host in Open project", () => {
  it("the SSH kind shows with no host in the config when the hub has ssh; its list offers Add SSH host", async () => {
    const { q, click, sshChip } = await render();
    expect(sshChip()).toBeDefined();
    await click(sshChip()!);
    expect(q("container-row")).toBeNull();
    expect(q("add-ssh-host")).not.toBeNull();
  });
  it("a hub without ssh: no SSH kind", async () => {
    const { sshChip } = await render({ ssh: false, sides: [local, { id: "wsl:U", label: "WSL: U", state: "off" }] });
    expect(sshChip()).toBeUndefined();
  });
  it("the command and alias go to the hub; the form closes on success", async () => {
    const onAdd = vi.fn(async () => "ssh:box");
    const { q, click, typeIn, submit, sshChip } = await render({ onAddSshHost: onAdd });
    await click(sshChip()!);
    await click(q("add-ssh-host"));
    expect(q<HTMLButtonElement>("add-ssh-host-submit")!.disabled).toBe(true);
    await typeIn("add-ssh-host-command", "  ssh dev@example.com -p 2222  ");
    await typeIn("add-ssh-host-alias", " box ");
    await submit();
    expect(onAdd.mock.calls).toEqual([["ssh dev@example.com -p 2222", "box"]]);
    expect(q("add-ssh-host-form")).toBeNull();
    expect(q("add-ssh-host")).not.toBeNull();
  });
  it("without an alias none is sent; a refusal shows its reason and keeps the form for a retry", async () => {
    const onAdd = vi.fn(async (_c: string, _a?: string): Promise<unknown> => {
      throw new Error('The host "box" already exists in the ssh config. Pick another alias.');
    });
    const { q, click, typeIn, submit, sshChip } = await render({ onAddSshHost: onAdd });
    await click(sshChip()!);
    await click(q("add-ssh-host"));
    await typeIn("add-ssh-host-command", "ssh box");
    await submit();
    expect(onAdd.mock.calls).toEqual([["ssh box", undefined]]);
    expect(q("add-ssh-host-error")!.textContent).toContain("already exists");
    expect(q("add-ssh-host-error")!.getAttribute("role")).toBe("alert");
    expect(q<HTMLInputElement>("add-ssh-host-command")!.value).toBe("ssh box");
    await click([...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Cancel")!);
    expect(q("add-ssh-host-form")).toBeNull();
  });
});
