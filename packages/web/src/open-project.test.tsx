// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FsEntry, RecentProject, SideCheck, SideInfo } from "@claude-ui/protocol";
import { OpenProjectDialog } from "./open-project.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tree: Record<string, string[]> = { "/home/u": ["claude-ui", "api", ".git", "notes.txt"], "/home/u/claude-ui": ["packages", "docs"] };
const list = vi.fn(async (path?: string): Promise<FsEntry[]> => {
  if (!path) return [{ name: "/home/u", path: "/home/u", isDir: true }];
  const names = tree[path];
  if (!names) throw new Error("ENOENT");
  return names.map((name) => ({ name, path: `${path}/${name}`, isDir: !name.includes(".txt") }));
});

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => root?.unmount());

async function render(onPick = vi.fn(async () => {}), recent?: RecentProject[]) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<OpenProjectDialog open onOpenChange={() => {}} list={list} onPick={onPick} recent={recent} />));
  const input = () => document.querySelector<HTMLInputElement>('[data-testid="folder-input"]')!;
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="folder-row"]')].map((r) => r.textContent);
  const type = async (v: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(input(), v);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const key = (k: string) => act(async () => void input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
  const recents = () => [...document.querySelectorAll<HTMLElement>('[data-testid="recent-row"]')];
  return { input, rows, type, key, onPick, recents };
}

// The first dialog render loads Base UI cold (~2 s alone); under the full parallel suite it took over the 5 s default.
it("starts inside the only root and lists its folders, no dot folders, no files", { timeout: 20_000 }, async () => {
  const { input, rows } = await render();
  expect(input().value).toBe("/home/u/");
  expect(rows()).toEqual(["claude-ui/", "api/"]);
});

it("type-ahead filters, Tab lists the highlighted folder's subfolders, Enter picks the listed folder", async () => {
  const { rows, type, key, input, onPick } = await render();
  await type("/home/u/cl");
  expect(rows()).toEqual(["claude-ui/"]);
  await key("Tab");
  expect(input().value).toBe("/home/u/claude-ui/");
  expect(rows()).toEqual(["packages/", "docs/"]);
  await key("Enter");
  expect(onPick).toHaveBeenCalledWith("/home/u/claude-ui");
});

it("Enter with a filter picks the best match; clicking a row lists its subfolders, Open picks the listed folder", async () => {
  const { rows, type, key, onPick } = await render();
  await type("/home/u/a");
  await key("Enter");
  expect(onPick).toHaveBeenLastCalledWith("/home/u/api");
  await type("/home/u/");
  await act(async () => document.querySelectorAll<HTMLElement>('[data-testid="folder-row"]')[0]!.click());
  expect(rows()).toEqual(["packages/", "docs/"]);
  await act(async () => document.querySelector<HTMLElement>('[data-testid="open-folder"]')!.click());
  expect(onPick).toHaveBeenLastCalledWith("/home/u/claude-ui");
});

it("shows the daemon's refusal and an empty match", async () => {
  const { type, key } = await render(vi.fn(async () => Promise.reject(new Error("outside the allowlisted roots"))));
  await type("/home/u/zzz");
  expect(document.body.textContent).toContain('No folder matches "zzz"');
  await type("/home/u/");
  await key("Enter");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("outside the allowlisted roots");
});

it("Tab and Shift+Tab wrap inside the dialog: focus never reaches the page behind it", async () => {
  const { input } = await render();
  const close = document.querySelector<HTMLElement>('[aria-label="Close"]')!;
  const openButton = document.querySelector<HTMLElement>('[data-testid="open-folder"]')!;
  const tab = (from: HTMLElement, shiftKey = false) =>
    act(async () => void from.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true })));
  input().focus();
  await tab(input(), true);
  expect(document.activeElement).toBe(close);
  await tab(close, true);
  expect(document.activeElement).toBe(openButton);
  await tab(openButton);
  expect(document.activeElement).toBe(close);
  await tab(close);
  expect(document.activeElement).toBe(input());
});

it("closing without a pick gives the focus back to the opener; after a pick the focus goes to finalFocus", async () => {
  const trigger = document.createElement("button");
  const prompt = document.createElement("textarea");
  document.body.append(trigger, prompt);
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const show = (open: boolean, onPick = async () => {}) =>
    act(async () => root!.render(<OpenProjectDialog open={open} onOpenChange={() => {}} list={list} onPick={onPick} finalFocus={{ current: prompt }} />));
  trigger.focus();
  await show(true);
  await show(false);
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  expect(document.activeElement).toBe(trigger);
  trigger.focus();
  await show(true);
  await act(async () => document.querySelector<HTMLElement>('[data-testid="open-folder"]')!.click());
  await show(false);
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  expect(document.activeElement).toBe(prompt);
  trigger.remove(), prompt.remove();
});

const now = Date.now();
const recent: RecentProject[] = [
  { cwd: "/home/u/api", sessionCount: 3, lastActivity: now - 5 * 60_000 },
  { cwd: "/home/u/old-one", sessionCount: 1, lastActivity: now - 3 * 3_600_000 },
  ...["a", "b", "c", "d"].map((n, i) => ({ cwd: `/home/u/${n}-proj`, sessionCount: 2, lastActivity: now - (i + 5) * 86_400_000 })),
];

it("suggests the first 5 recent projects with session count and age; one click adds one", async () => {
  const { recents, onPick } = await render(undefined, recent);
  expect(document.body.textContent).toContain("Recent projects");
  expect(recents().map((r) => r.textContent)).toEqual([
    expect.stringMatching(/^api\/home\/u\/api3 sessions · 5m ago$/),
    expect.stringMatching(/^old-one\/home\/u\/old-one1 session · 3h ago$/),
    expect.stringContaining("a-proj"),
    expect.stringContaining("b-proj"),
    expect.stringContaining("c-proj"),
  ]);
  await act(async () => recents()[1]!.click());
  expect(onPick).toHaveBeenCalledWith("/home/u/old-one");
});

it("typing filters the recent projects by name; Tab and Enter still act on the typed folder, never on a recent", async () => {
  const withMatch = [{ cwd: "/home/u/old-api-2", sessionCount: 1, lastActivity: now }, ...recent];
  const { recents, rows, type, key, input, onPick } = await render(undefined, withMatch);
  await type("/home/u/api");
  expect(recents().map((r) => r.textContent)).toEqual([expect.stringContaining("old-api-2"), expect.stringContaining("api/home/u/api")]);
  expect(rows()).toEqual(["api/"]);
  await key("Tab");
  expect(input().value).toBe("/home/u/api/");
  await type("/home/u/api");
  await key("Enter");
  expect(onPick).toHaveBeenCalledWith("/home/u/api");
  await type("/home/u/old");
  expect(recents().map((r) => r.textContent)).toEqual([expect.stringContaining("old-api-2"), expect.stringContaining("old-one")]);
  await key("Enter");
  expect(onPick).toHaveBeenLastCalledWith("/home/u");
  await type("/home/u/zzz");
  expect(recents()).toHaveLength(0);
});

it("recent projects show only at the start level, not in a browsed directory", async () => {
  const { recents, type, rows } = await render(undefined, recent);
  expect(recents().length).toBeGreaterThan(0);
  await type("/home/u/claude-ui/");
  expect(rows()).toEqual(["packages/", "docs/"]);
  expect(recents()).toHaveLength(0);
  expect(document.body.textContent).not.toContain("Recent projects");
  await type("/home/u/");
  expect(recents().length).toBeGreaterThan(0);
});

it("in the start state Tab descends into the first folder, not a recent project", async () => {
  const { input, key } = await render(undefined, recent);
  await key("Tab");
  expect(input().value).toBe("/home/u/claude-ui/");
});

it("a recent project is picked with Enter only after ArrowDown selects it", async () => {
  const { key, onPick } = await render(undefined, recent);
  await key("Enter");
  expect(onPick).toHaveBeenLastCalledWith("/home/u");
  await key("ArrowDown");
  await key("Enter");
  expect(onPick).toHaveBeenLastCalledWith("/home/u/api");
});

it("recent-row path and meta text use the muted token (4.5:1), not the icon-only faint one", async () => {
  const { recents } = await render(undefined, recent);
  const text = [...recents()[0]!.querySelectorAll("span")].slice(1);
  expect(text).toHaveLength(2);
  for (const s of text) expect(s.className).toContain("text-muted-foreground");
});

it("without recent projects the dialog shows no recent section", async () => {
  await render(undefined, []);
  expect(document.body.textContent).not.toContain("Recent projects");
});

describe("side chooser", () => {
  const S = (id: string, label: string, state: SideInfo["state"] = "ready", message?: string): SideInfo => ({ id, label, state, ...(message && { message }) });
  const sides = (wsl: SideInfo["state"] = "off", message?: string): SideInfo[] => [S("local", "Windows"), S("wsl:Ubuntu", "WSL: Ubuntu", wsl, message)];
  const docker = (...names: string[]): SideInfo[] => names.map((n) => S(`docker:${n}`, `Docker: ${n}`));
  const winTree: Record<string, string[]> = { "C:\\Users\\me": ["proj"], "C:\\Users\\me\\proj": [] };
  const sideList = vi.fn(async (path?: string, side?: string): Promise<FsEntry[]> => {
    if (side && side !== "local") return list(path);
    if (!path) return [{ name: "C:\\Users\\me", path: "C:\\Users\\me", isDir: true }];
    return (winTree[path] ?? []).map((name) => ({ name, path: `${path}\\${name}`, isDir: true }));
  });
  const sideOf = (c: string) => (c.startsWith("/") ? "wsl:Ubuntu" : "local");
  const chk = (verdict: SideCheck["verdict"], more: Partial<SideCheck> = {}, facts: Partial<SideCheck["facts"]> = {}): SideCheck => ({
    verdict,
    key: "0.5.0-1",
    facts: { reachable: true, node: "v22.1.0", nodeOk: true, buildTools: { make: true, python3: true, cxx: true }, credentialsFile: true, installed: verdict === "install" ? "none" : verdict === "update" ? "other" : "current", ...facts },
    ...more,
  });
  async function renderSides(s: SideInfo[], onStartSide = vi.fn(async (_id: string, _setup?: string) => {}), keepStorage = false, onCheckSide = vi.fn(async (_id: string) => chk("install"))) {
    if (!keepStorage) localStorage.clear();
    const onPick = vi.fn(async (_cwd: string, _side?: string) => {});
    const recent: RecentProject[] = [{ cwd: "/home/u/api", sessionCount: 2, lastActivity: Date.now() }];
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    const show = (sides: SideInfo[]) =>
      act(async () => root!.render(<OpenProjectDialog open onOpenChange={() => {}} list={sideList} onPick={onPick} sides={sides} onStartSide={onStartSide} onCheckSide={onCheckSide} recent={recent} sideOf={sideOf} />));
    await show(s);
    const input = () => document.querySelector<HTMLInputElement>('[data-testid="folder-input"]');
    const kinds = () => [...document.querySelectorAll<HTMLElement>('[data-testid="side-kind"]')];
    const checked = () => kinds().filter((o) => o.getAttribute("aria-checked") === "true").map((o) => o.textContent);
    const status = () => document.querySelector('[data-testid="side-status"]')?.textContent;
    // The label inside the trigger (its chevron is part of the button text).
    const target = () => document.querySelector<HTMLElement>('[data-testid="side-target"] > span');
    const rowEls = () => [...document.querySelectorAll<HTMLElement>('[data-testid="container-row"]')];
    const containers = () => rowEls().map((r) => r.textContent);
    const filter = () => document.querySelector<HTMLInputElement>('[data-testid="container-filter"]')!;
    const typeIn = async (el: () => HTMLInputElement | null, v: string) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        set.call(el(), v);
        el()!.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const type = (v: string) => typeIn(input, v);
    const press = (el: HTMLElement, k: string) => act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));
    const click = (el: HTMLElement) => act(async () => el.click());
    const kind = (name: string) => kinds().find((k) => k.textContent === name)!;
    const items = () => [...document.querySelectorAll<HTMLElement>('[data-testid="side-target-item"]')];
    const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    return { input, kinds, checked, status, target, containers, rowEls, filter, type, typeIn, press, click, kind, items, show, onPick, onStartSide, onCheckSide, byId };
  }

  it("shows one chip per kind: Windows and WSL; choosing WSL only checks the distro, Install sets it up, then it browses its home folder and picks on that side", async () => {
    let done!: () => void;
    const { input, checked, kind, click, byId, target, onPick, onStartSide, onCheckSide, kinds } = await renderSides(sides(), vi.fn(() => new Promise<void>((r) => (done = r))));
    expect(kinds().map((o) => o.textContent)).toEqual(["Windows", "WSL"]);
    expect(checked()).toEqual(["Windows"]);
    expect(target()).toBeNull();
    expect(input()!.value).toBe("C:\\Users\\me\\");
    await click(kind("WSL"));
    expect(onCheckSide).toHaveBeenCalledWith("wsl:Ubuntu");
    expect(onStartSide).not.toHaveBeenCalled();
    expect(byId("side-install")!.textContent).toBe("Install");
    expect(target()!.textContent).toBe("Ubuntu");
    await click(byId("side-install")!);
    expect(onStartSide).toHaveBeenCalledWith("wsl:Ubuntu", "needed");
    expect(byId("side-status")!.textContent).toContain("Installing");
    await act(async () => done());
    expect(input()!.value).toBe("/home/u/");
    await click(document.querySelector<HTMLElement>('[data-testid="open-folder"]')!);
    expect(onPick).toHaveBeenCalledWith("/home/u", "wsl:Ubuntu");
    // The last used side comes back next time.
    expect(localStorage.getItem("claude-ui.side")).toBe("wsl:Ubuntu");
    expect(localStorage.getItem("claude-ui.side.wsl")).toBe("wsl:Ubuntu");
  });

  it("a failed install says what to do; Retry installs again", async () => {
    const msg = "Node.js 22 or newer is not installed in WSL: Ubuntu. Install it there (e.g. nvm install 22), then retry.";
    const onStartSide = vi.fn(async (_id: string) => {}).mockRejectedValueOnce(new Error(msg));
    const { kind, click, status, input, byId } = await renderSides(sides(), onStartSide);
    await click(kind("WSL"));
    await click(byId("side-install")!);
    expect(status()).toContain(msg);
    expect(status()).toContain("Retry");
    expect(document.activeElement).toBe(byId("side-retry"));
    await click(document.querySelector<HTMLElement>('[data-testid="side-retry"]')!);
    expect(onStartSide).toHaveBeenCalledTimes(2);
    expect(input()!.value).toBe("/home/u/");
  });

  it("a very long error with unbreakable paths stays inside the dialog: wraps anywhere, scrolls on its own, Retry stays outside the scrolled text and below the controls", async () => {
    const msg = `npm pack failed: ${"C:/Users/someone/AppData/Local/Temp/claude-ui-pack/node_modules/daemon/".repeat(10)}`;
    expect(msg.length).toBeGreaterThan(600);
    const onStartSide = vi.fn(async (_id: string) => {}).mockRejectedValueOnce(new Error(msg));
    const { kind, click, status, byId } = await renderSides(sides(), onStartSide);
    await click(kind("WSL"));
    await click(byId("side-install")!);
    expect(status()).toContain(msg);
    const box = document.querySelector<HTMLElement>('[data-testid="side-status"]')!;
    const text = box.querySelector<HTMLElement>('[data-testid="side-error"]')!;
    const retry = document.querySelector<HTMLElement>('[data-testid="side-retry"]')!;
    // The text breaks inside words, is height-capped with its own scroll, and stays selectable.
    expect(text.className).toContain("[overflow-wrap:anywhere]");
    expect(text.className).toContain("max-h-");
    expect(text.className).toContain("overflow-y-auto");
    expect(text.className).not.toContain("select-none");
    // Retry is not inside the scrolling text; the block is in normal flow (never absolute) and may shrink and scroll in the dialog.
    expect(text.contains(retry)).toBe(false);
    expect(box.className).toContain("min-h-0");
    expect(box.className).toContain("overflow-y-auto");
    expect(box.className.split(" ")).not.toEqual(expect.arrayContaining(["absolute"]));
    expect(retry.className).toContain("max-md:h-11");
    // The controls come first in the document, so the error sits below them.
    const row = document.querySelector<HTMLElement>('[data-testid="side-kind"]')!;
    expect(row.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the browser's refusal line wraps and scrolls instead of being cut off or overlapping", { timeout: 20_000 }, async () => {
    const msg = `outside the allowlisted roots: ${"C:/very/long/path/".repeat(40)}`;
    const { type, key } = await render(vi.fn(async () => Promise.reject(new Error(msg))));
    await type("/home/u/");
    await key("Enter");
    const alert = document.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toBe(msg);
    expect(alert.className).toContain("[overflow-wrap:anywhere]");
    expect(alert.className).toContain("max-h-");
    expect(alert.className).toContain("overflow-y-auto");
    expect(alert.className).not.toContain("truncate");
  });

  it("a typed path picks its side: /home goes to WSL, C:\\ back to Windows, \\\\wsl.localhost\\Ubuntu to that distro", async () => {
    const { input, checked, target, type } = await renderSides(sides("ready"));
    await type("/home/u/cl");
    expect(checked()).toEqual(["WSL"]);
    expect(target()!.textContent).toBe("Ubuntu");
    expect(input()!.value).toBe("/home/u/cl");
    await type("C:\\Users\\me\\p");
    expect(checked()).toEqual(["Windows"]);
    expect(input()!.value).toBe("C:\\Users\\me\\p");
    await type("\\\\wsl.localhost\\Ubuntu\\home\\u\\");
    expect(checked()).toEqual(["WSL"]);
    expect(input()!.value).toBe("/home/u/");
  });

  it("a typed POSIX path on Windows goes to a WSL distro before a container", async () => {
    const { checked, target, type } = await renderSides([S("local", "Windows"), ...docker("dev"), S("wsl:Ubuntu", "WSL: Ubuntu")]);
    await type("/home/u/cl");
    expect(checked()).toEqual(["WSL"]);
    expect(target()!.textContent).toBe("Ubuntu");
  });

  it("recent projects of every side show their side; a /mnt/c folder offers to open it on Windows", async () => {
    const { type, kind, click, input, checked } = await renderSides(sides("ready"));
    await click(kind("WSL"));
    expect(document.querySelector('[data-testid="recent-row"]')!.textContent).toContain("api");
    await type("/mnt/c/Users/me/proj/");
    const hint = document.querySelector<HTMLElement>('[data-testid="open-as-windows"]')!;
    expect(hint.textContent).toBe("Open C:\\Users\\me\\proj on Windows");
    await click(hint);
    expect(checked()).toEqual(["Windows"]);
    expect(input()!.value).toBe("C:\\Users\\me\\proj");
  });

  it("two WSL distros: the dropdown picks the distro and shows which are not set up", async () => {
    const { kind, click, target, items, input, byId, onStartSide, onCheckSide } = await renderSides([S("local", "Windows"), S("wsl:Ubuntu", "WSL: Ubuntu"), S("wsl:Debian", "WSL: Debian", "off")]);
    await click(kind("WSL"));
    expect(target()!.textContent).toBe("Ubuntu");
    expect(input()!.value).toBe("/home/u/");
    await click(target()!);
    expect(items().map((i) => i.textContent)).toEqual(["Ubuntu", "DebianNot set up"]);
    let done!: () => void;
    onStartSide.mockImplementationOnce(() => new Promise<void>((r) => (done = r)));
    await click(items()[1]!);
    expect(onCheckSide).toHaveBeenCalledWith("wsl:Debian");
    expect(onStartSide).not.toHaveBeenCalled();
    await click(byId("side-install")!);
    expect(onStartSide).toHaveBeenCalledWith("wsl:Debian", "needed");
    await act(async () => done());
    expect(target()!.textContent).toBe("Debian");
    expect(input()!.value).toBe("/home/u/");
    expect(sideList).toHaveBeenLastCalledWith("/home/u", "wsl:Debian");
  });

  it("the arrow keys move the focus between the kinds without choosing one", async () => {
    const { kinds, press, checked, onStartSide } = await renderSides(sides());
    kinds()[0]!.focus();
    await press(kinds()[0]!, "ArrowRight");
    expect(document.activeElement).toBe(kinds()[1]);
    expect(checked()).toEqual(["Windows"]);
    expect(onStartSide).not.toHaveBeenCalled();
    await press(kinds()[1]!, "ArrowRight");
    expect(document.activeElement).toBe(kinds()[0]);
    await press(kinds()[0]!, "ArrowLeft");
    expect(document.activeElement).toBe(kinds()[1]);
    expect(kinds().map((k) => k.tabIndex)).toEqual([0, -1]);
  });

  it("Tab treats the kind row as one stop: it skips the unchecked kinds (roving tabindex)", async () => {
    const { kinds, press, input } = await renderSides(sides());
    kinds()[0]!.focus();
    await press(kinds()[0]!, "Tab");
    expect(document.activeElement).toBe(input());
  });

  it("Tab from a kind reached with an arrow key leaves the row: forward to the next control, back to the one before it, never to Close", async () => {
    const { kinds, press, input } = await renderSides(sides());
    const close = document.querySelector<HTMLElement>('[aria-label="Close"]')!;
    kinds()[0]!.focus();
    await press(kinds()[0]!, "ArrowRight");
    expect(document.activeElement).toBe(kinds()[1]);
    await press(kinds()[1]!, "Tab");
    expect(document.activeElement).toBe(input());
    kinds()[0]!.focus();
    await press(kinds()[0]!, "ArrowRight");
    await act(async () => void kinds()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(close);
  });

  it("Tab in the open distro dropdown (a portal outside the dialog) closes it and returns the focus to its trigger, never to Close", async () => {
    const { kind, click, target, items } = await renderSides([S("local", "Windows"), S("wsl:Ubuntu", "WSL: Ubuntu"), S("wsl:Debian", "WSL: Debian")]);
    await click(kind("WSL"));
    const trigger = document.querySelector<HTMLElement>('[data-testid="side-target"]')!;
    await click(trigger);
    const dialog = document.querySelector('[data-testid="open-project-dialog"]')!;
    const option = items()[0]!;
    expect(dialog.contains(option)).toBe(false);
    option.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => void option.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(true);
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(target()!.textContent).toBe("Ubuntu");
  });

  it("a distro whose setup failed shows Error in the dropdown, not Setting up", async () => {
    const onStartSide = vi.fn(async (_id: string) => {}).mockRejectedValueOnce(new Error("no node"));
    const { kind, click, target, items } = await renderSides([S("local", "Windows"), S("wsl:Ubuntu", "WSL: Ubuntu"), S("wsl:Debian", "WSL: Debian", "off")], onStartSide);
    await click(kind("WSL"));
    await click(target()!);
    await click(items()[1]!);
    await click(document.querySelector<HTMLElement>('[data-testid="side-install"]')!);
    await click(target()!);
    expect(items().map((i) => i.textContent)).toEqual(["Ubuntu", "DebianError"]);
  });

  it("per-kind memory starts from the side used before it existed", async () => {
    localStorage.clear();
    localStorage.setItem("claude-ui.side", "wsl:Debian");
    const { kind, click, target, checked } = await renderSides([S("local", "Windows"), S("wsl:Ubuntu", "WSL: Ubuntu"), S("wsl:Debian", "WSL: Debian")], undefined, true);
    expect(checked()).toEqual(["WSL"]);
    await click(kind("Windows"));
    await click(kind("WSL"));
    expect(target()!.textContent).toBe("Debian");
  });

  describe("check and install", () => {
    const withCheck = (c: SideCheck | Error, start = vi.fn(async (_id: string, _setup?: string) => {})) => renderSides(sides(), start, false, vi.fn(async (_id: string) => (c instanceof Error ? Promise.reject(c) : c)));

    it("picking a side that is not installed shows the check rows and an Install button and starts nothing", async () => {
      const { kind, click, byId, onStartSide, input } = await withCheck(chk("install"));
      await click(kind("WSL"));
      expect(byId("side-check")).not.toBeNull();
      const rows = [...document.querySelectorAll('[data-testid="side-check-row"]')].map((r) => r.textContent);
      expect(rows).toHaveLength(5);
      expect(rows.join("|")).toMatch(/Node\.js 22\+.*v22\.1\.0/);
      expect(rows.join("|")).toMatch(/claude-ui.*Not installed/);
      expect(byId("side-install")!.textContent).toBe("Install");
      expect(byId("side-check-again")!.textContent).toBe("Check again");
      expect(onStartSide).not.toHaveBeenCalled();
      expect(input()).toBeNull();
    });

    it("Install shows a busy button with progress, then the folder browser with the folder input focused", async () => {
      let done!: () => void;
      const { kind, click, byId, input } = await withCheck(chk("install"), vi.fn(() => new Promise<void>((r) => (done = r))));
      await click(kind("WSL"));
      await click(byId("side-install")!);
      const busy = byId("side-install")!;
      expect(busy.textContent).toBe("Installing…");
      expect(busy.getAttribute("aria-busy")).toBe("true");
      expect((busy as HTMLButtonElement).disabled).toBe(true);
      expect(byId("side-status")!.getAttribute("aria-live")).toBe("polite");
      await act(async () => done());
      expect(input()!.value).toBe("/home/u/");
      expect(document.activeElement).toBe(input());
    });

    it("an update shows Update", async () => {
      const { kind, click, byId, onStartSide } = await withCheck(chk("update"));
      await click(kind("WSL"));
      expect(byId("side-install")!.textContent).toBe("Update");
      await click(byId("side-install")!);
      expect(onStartSide).toHaveBeenCalledWith("wsl:Ubuntu", "needed");
    });

    it("a blocked side shows its reason and fix and Check again, and no Install; Check again checks again", async () => {
      const blocked = chk("blocked", { reason: "node_missing", message: "Install Node.js 22 in WSL: Ubuntu (for example nvm install 22), then check again." }, { node: undefined, nodeOk: false });
      const { kind, click, byId, status, onCheckSide } = await withCheck(blocked);
      await click(kind("WSL"));
      expect(status()).toContain("Install Node.js 22 in WSL: Ubuntu");
      expect(byId("side-install")).toBeNull();
      await click(byId("side-check-again")!);
      expect(onCheckSide).toHaveBeenCalledTimes(2);
    });

    it("a missing login is a soft block: the fix text and an Install anyway button that installs", async () => {
      const { kind, click, byId, status, onStartSide } = await withCheck(chk("blocked", { reason: "not_logged_in" }, { credentialsFile: false }));
      await click(kind("WSL"));
      expect(status()).toMatch(/log ?in/i);
      expect(byId("side-install")!.textContent).toBe("Install anyway");
      await click(byId("side-install")!);
      expect(onStartSide).toHaveBeenCalledWith("wsl:Ubuntu", "needed");
    });

    it("a running side opens the browser at once, nothing started", async () => {
      const { kind, click, input, onStartSide } = await withCheck(chk("running"));
      await click(kind("WSL"));
      expect(input()!.value).toBe("/home/u/");
      expect(onStartSide).not.toHaveBeenCalled();
    });

    it("a side the sides list says is ready opens the browser with no request at all", async () => {
      const { kind, click, input, onStartSide, onCheckSide } = await renderSides([S("local", "Windows"), S("wsl:Ubuntu", "WSL: Ubuntu", "ready")]);
      await click(kind("WSL"));
      expect(input()!.value).toBe("/home/u/");
      expect(onStartSide).not.toHaveBeenCalled();
      expect(onCheckSide).not.toHaveBeenCalled();
    });

    it("an installed side picked by hand is not started by itself: its panel offers Start (setup never)", async () => {
      const { kind, click, byId, onStartSide, input } = await withCheck(chk("installed"));
      await click(kind("WSL"));
      expect(onStartSide).not.toHaveBeenCalled();
      await click(byId("side-install")!);
      expect(onStartSide).toHaveBeenCalledWith("wsl:Ubuntu", "never");
      expect(input()!.value).toBe("/home/u/");
    });

    it("a remembered installed side starts with setup never when the dialog opens, then shows the browser", async () => {
      localStorage.setItem("claude-ui.side", "wsl:Ubuntu");
      const { input, onStartSide, onCheckSide } = await renderSides(sides(), undefined, true, vi.fn(async () => chk("installed")));
      expect(onCheckSide).toHaveBeenCalledWith("wsl:Ubuntu");
      expect(onStartSide).toHaveBeenCalledWith("wsl:Ubuntu", "never");
      expect(input()!.value).toBe("/home/u/");
    });

    it("a remembered side that needs an update shows the panel and starts nothing", async () => {
      localStorage.setItem("claude-ui.side", "wsl:Ubuntu");
      const { byId, input, onStartSide } = await renderSides(sides(), undefined, true, vi.fn(async () => chk("update")));
      expect(byId("side-install")!.textContent).toBe("Update");
      expect(onStartSide).not.toHaveBeenCalled();
      expect(input()).toBeNull();
    });

    it("a remembered container is checked and started like a distro; one never picked is not", async () => {
      localStorage.setItem("claude-ui.side", "docker:a");
      const sd = [S("local", "Linux"), S("docker:a", "Docker: a", "off"), S("docker:b", "Docker: b", "off")];
      const { onCheckSide, onStartSide, input } = await renderSides(sd, undefined, true, vi.fn(async () => chk("installed")));
      expect(onCheckSide.mock.calls).toEqual([["docker:a"]]);
      expect(onStartSide).toHaveBeenCalledWith("docker:a", "never");
      expect(input()).not.toBeNull();
    });

    it("switching the kind only checks; it never calls onStartSide", async () => {
      const { kind, click, onStartSide, onCheckSide } = await renderSides([S("local", "Windows"), S("wsl:Ubuntu", "WSL: Ubuntu", "off"), ...docker("a")]);
      await click(kind("WSL"));
      await click(kind("Windows"));
      await click(kind("WSL"));
      expect(onCheckSide).toHaveBeenCalledWith("wsl:Ubuntu");
      expect(onStartSide).not.toHaveBeenCalled();
    });

    it("a failed install shows the message with Retry and Check again; after a check the main button is Reinstall", async () => {
      const start = vi.fn(async (_id: string, _setup?: string) => {}).mockRejectedValueOnce(new Error("npm failed"));
      const { kind, click, byId, status } = await withCheck(chk("installed"), start);
      await click(kind("WSL"));
      expect(byId("side-install")!.textContent).not.toBe("Reinstall");
      await click(byId("side-install")!);
      expect(byId("side-error")!.getAttribute("role")).toBe("alert");
      expect(status()).toContain("npm failed");
      await click(byId("side-check-again")!);
      expect(byId("side-install")!.textContent).toBe("Reinstall");
      await click(byId("side-install")!);
      expect(start).toHaveBeenLastCalledWith("wsl:Ubuntu", "force");
    });

    it("an older daemon (unknown_type) cannot check: plain text and an Install button that sends side.start without a setup field", async () => {
      const old = Object.assign(new Error("unknown message type side.check"), { code: "unknown_type" });
      const { kind, click, byId, status, onStartSide } = await withCheck(old);
      await click(kind("WSL"));
      expect(status()).toContain("Can't check this side on this daemon version");
      expect(byId("side-check-row")).toBeNull();
      await click(byId("side-install")!);
      expect(onStartSide).toHaveBeenCalledWith("wsl:Ubuntu");
    });

    it("another check failure says so and offers Check again, no Install", async () => {
      const { kind, click, byId, status } = await withCheck(new Error("timed out"));
      await click(kind("WSL"));
      expect(status()).toContain("timed out");
      expect(byId("side-install")).toBeNull();
      expect(byId("side-check-again")).not.toBeNull();
    });

    it("the select sits below the kind row, inside the content, and stays while the panel shows", async () => {
      const { kind, click, byId } = await withCheck(chk("install"));
      await click(kind("WSL"));
      const row = byId("side-chooser")!;
      const select = byId("side-target")!;
      expect(row.contains(select)).toBe(false);
      expect(row.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(select.compareDocumentPosition(byId("side-check")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("the buttons are real buttons in Tab order (select, Check again, Install) and 44 px high below md", async () => {
      const { kind, click, byId } = await withCheck(chk("install"));
      await click(kind("WSL"));
      const order = [byId("side-target")!, byId("side-check-again")!, byId("side-install")!];
      for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      for (const b of order.slice(1)) {
        expect(b.tagName).toBe("BUTTON");
        expect(b.className).toContain("max-md:h-11");
      }
    });
  });

  describe("Docker", () => {
    const many = [S("local", "Linux"), ...docker("cui-alpine", "cui-nologin", "cui-node", "chat-solution-autoheal-1", "db1", "db2")];
    const names = ["cui-alpine", "cui-nologin", "cui-node", "chat-solution-autoheal-1", "db1", "db2"];

    it("many containers still show one Docker chip, not one chip per container", async () => {
      const { kinds, checked, target } = await renderSides(many);
      expect(kinds().map((o) => o.textContent)).toEqual(["Linux", "Docker"]);
      expect(checked()).toEqual(["Linux"]);
      expect(target()).toBeNull();
      expect(document.querySelector('[data-testid="side-chooser"]')!.textContent).not.toContain("Docker:");
    });

    it("Docker asks which container first and sets nothing up until one is picked; the filter narrows, Enter picks", async () => {
      const { kind, click, containers, filter, input, typeIn, press, onStartSide, onPick, target, checked } = await renderSides(many);
      await click(kind("Docker"));
      expect(checked()).toEqual(["Docker"]);
      expect(containers()).toEqual(names);
      expect(onStartSide).not.toHaveBeenCalled();
      expect(input()).toBeNull();
      expect(document.activeElement).toBe(filter());
      expect(target()).toBeNull();
      await typeIn(filter, "no");
      expect(containers()).toEqual(["cui-nologin", "cui-node"]);
      await typeIn(filter, "zzz");
      expect(document.body.textContent).toContain("No running container matches");
      await press(filter(), "Enter");
      expect(onStartSide).not.toHaveBeenCalled();
      await typeIn(filter, "NO");
      await press(filter(), "ArrowDown");
      await press(filter(), "Enter");
      // Running containers need no setup.
      expect(onStartSide).not.toHaveBeenCalled();
      expect(input()!.value).toBe("/home/u/");
      expect(target()!.textContent).toBe("cui-node");
      await click(document.querySelector<HTMLElement>('[data-testid="open-folder"]')!);
      expect(onPick).toHaveBeenCalledWith("/home/u", "docker:cui-node");
    });

    it("a container that is not set up is only checked when picked; Install sets it up, then it browses", async () => {
      const { kind, click, containers, rowEls, byId, input, onStartSide, onCheckSide } = await renderSides([S("local", "Linux"), S("docker:a", "Docker: a", "off"), S("docker:b", "Docker: b")]);
      await click(kind("Docker"));
      expect(containers()).toEqual(["b", "aNot set up"]);
      await click(rowEls()[1]!);
      expect(onCheckSide).toHaveBeenCalledWith("docker:a");
      expect(onStartSide).not.toHaveBeenCalled();
      expect(input()).toBeNull();
      await click(byId("side-install")!);
      expect(onStartSide).toHaveBeenCalledWith("docker:a", "needed");
      expect(input()!.value).toBe("/home/u/");
    });

    it("one container that is not set up is highlighted; Enter only checks it, it is never installed without the Install button", async () => {
      const { kind, click, containers, rowEls, press, filter, onStartSide, onCheckSide, input } = await renderSides([S("local", "Linux"), S("docker:solo", "Docker: solo", "off")]);
      expect(onStartSide).not.toHaveBeenCalled();
      await click(kind("Docker"));
      expect(containers()).toEqual(["soloNot set up"]);
      expect(rowEls()[0]!.getAttribute("aria-selected")).toBe("true");
      expect(onCheckSide).not.toHaveBeenCalled();
      await press(filter(), "Enter");
      expect(onCheckSide).toHaveBeenCalledWith("docker:solo");
      expect(onStartSide).not.toHaveBeenCalled();
      expect(input()).toBeNull();
    });

    it("the dropdown switches container; the last container comes back next time", async () => {
      const { kind, click, containers, rowEls, target, items, onStartSide } = await renderSides(many);
      await click(kind("Docker"));
      await click(rowEls()[0]!);
      expect(target()!.textContent).toBe("cui-alpine");
      await click(target()!);
      expect(items().map((i) => i.textContent)).toEqual(names);
      await click(items()[2]!);
      expect(target()!.textContent).toBe("cui-node");
      expect(containers()).toEqual([]);
      expect(onStartSide).not.toHaveBeenCalled();
      expect(localStorage.getItem("claude-ui.side.docker")).toBe("docker:cui-node");
      // A new dialog opens on the last used side: Docker with that container.
      root!.unmount();
      const again = await renderSides(many, undefined, true);
      expect(again.checked()).toEqual(["Docker"]);
      expect(again.target()!.textContent).toBe("cui-node");
      expect(again.input()!.value).toBe("/home/u/");
    });

    it("Docker again after another kind goes straight to the remembered container; one that is gone asks again", async () => {
      const { kind, click, target, containers, input } = await renderSides(many);
      localStorage.setItem("claude-ui.side.docker", "docker:db1");
      await click(kind("Docker"));
      expect(target()!.textContent).toBe("db1");
      expect(containers()).toEqual([]);
      expect(input()).not.toBeNull();
      await click(kind("Linux"));
      localStorage.setItem("claude-ui.side.docker", "docker:gone");
      await click(kind("Docker"));
      expect(containers()).toEqual(names);
      expect(input()).toBeNull();
    });

    it("a remembered side that is gone opens on the machine itself", async () => {
      localStorage.clear();
      localStorage.setItem("claude-ui.side", "docker:gone");
      const { checked, input } = await renderSides(many, undefined, true);
      expect(checked()).toEqual(["Linux"]);
      expect(input()).not.toBeNull();
    });

    it("a chosen container that stops falls back to the container list; the last one leaving removes the Docker chip", async () => {
      const withWsl = [S("local", "Windows"), S("wsl:Ubuntu", "WSL: Ubuntu"), ...docker("a", "b", "c")];
      const { kind, click, rowEls, show, kinds, input, onStartSide } = await renderSides(withWsl);
      await click(kind("Docker"));
      await click(rowEls()[1]!);
      expect(rowEls()).toHaveLength(0);
      await show(withWsl.filter((s) => s.id !== "docker:b"));
      expect(rowEls()).toHaveLength(2);
      expect(kinds().map((k) => k.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
      await show(withWsl.filter((s) => !s.id.startsWith("docker:")));
      expect(kinds().map((k) => [k.textContent, k.getAttribute("aria-checked")])).toEqual([["Windows", "true"], ["WSL", "false"]]);
      expect(input()).not.toBeNull();
      expect(onStartSide).not.toHaveBeenCalled();
    });

    it("a typed POSIX path stays on the chosen side; no Windows hint in a container", async () => {
      const { type, kind, click, rowEls, checked, onStartSide } = await renderSides([S("local", "Linux"), ...docker("dev")]);
      await type("/home/u/cl");
      expect(checked()).toEqual(["Linux"]);
      expect(onStartSide).not.toHaveBeenCalled();
      await click(kind("Docker"));
      await click(rowEls()[0]!);
      await type("/mnt/c/Users/x/");
      expect(document.querySelector('[data-testid="mnt-hint"]')).toBeNull();
    });

    it("on a Windows hub a typed POSIX path never sets up a container that is not running", async () => {
      const { type, checked, onStartSide } = await renderSides([S("local", "Windows"), S("docker:a", "Docker: a", "off")]);
      await type("/home/u/cl");
      expect(checked()).toEqual(["Windows"]);
      expect(onStartSide).not.toHaveBeenCalled();
    });
  });
});

it("Enter, Tab and arrows while an input method composes the folder name go to the IME", async () => {
  const { type, input, onPick, key } = await render();
  await type("/home/u/api");
  for (const k of ["Enter", "Tab", "ArrowDown"]) {
    const e = new KeyboardEvent("keydown", { key: k, keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
    await act(async () => void input().dispatchEvent(e));
  }
  expect(onPick).not.toHaveBeenCalled();
  expect(input().value).toBe("/home/u/api");
  await key("Enter");
  expect(onPick).toHaveBeenCalled();
});
