// @vitest-environment jsdom
// App wiring of the guided tour (docs/spec.md "First-use guide"), with a fake daemon connection.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";
import { setFreshBrowser, GUIDE_KEY } from "./guide.ts";
import { adapt, STEPS, type GuideStep } from "./guide-steps.ts";
import { bind, resetAll } from "./keymap.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};
let width = 1440;
window.matchMedia = ((query: string) => ({
  matches: /min-width: (\d+)px/.test(query) ? width >= +/min-width: (\d+)px/.exec(query)![1]! : /max-width: (\d+)px/.test(query) ? width <= +/max-width: (\d+)px/.exec(query)![1]! : false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})) as never;

const ID = "11111111-2222-3333-4444-555555555555";
const session: SessionListItem = { id: ID, cwd: "/p/demo", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"], title: "Demo", lastActivity: 0, archived: false, transcript: true };
const replies: Record<string, unknown> = {};
let emit: (e: unknown) => void = () => {};
const reset = () => {
  for (const k of Object.keys(replies)) delete replies[k];
  Object.assign(replies, {
    "session.list": { sessions: [], projects: [] },
    "session.subscribe": { logEpoch: "e1", session },
    "models.list": { models: [] },
    "fs.list": { entries: [] },
    "fs.search": { paths: [] },
    "git.status": { status: null },
    "terminal.list": { terminals: [] },
    "settings.get": { settings: { orchestration: { enabled: false, workerCap: 4, coordinatorPermissions: true, workerMode: "coordinator" }, usageLimit: { autoContinue: false } } },
  });
};
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    focus() {}
    write() {}
    reset() {}
    onData() {}
    onResize() {}
    attachCustomKeyEventHandler() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("./client.ts", async (orig) => ({
  ...(await orig<typeof import("./client.ts")>()),
  connect: (opts: { onEvent: (e: unknown) => void; onOpen?: () => void; onStatus?: (s: string) => void }) => {
    emit = opts.onEvent;
    queueMicrotask(() => (opts.onStatus?.("connected"), opts.onOpen?.()));
    return { request: async (m: { type: string }) => replies[m.type] ?? {}, onFsChanged: () => () => {}, onTerminal: () => () => {}, close() {} };
  },
}));
const { App } = await import("./App.tsx");

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function mount() {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
}
const unmount = () => (act(() => root.unmount()), el.remove());
beforeEach(() => {
  width = 1440;
  localStorage.clear();
  location.hash = "";
  reset();
});
afterEach(() => {
  unmount();
  resetAll();
  setFreshBrowser(false);
  document.body.innerHTML = "";
});

const tour = () => document.querySelector<HTMLElement>('[data-testid="guide-popover"]');
const saved = () => JSON.parse(localStorage.getItem(GUIDE_KEY) ?? "null");
const press = (init: KeyboardEventInit) => act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));

describe("first use", () => {
  it("a fresh browser on a daemon with no projects gets the welcome card", async () => {
    setFreshBrowser(true);
    await mount();
    expect(tour()?.textContent).toContain("Welcome to Claude UI");
    expect(tour()!.textContent).toContain("Step 1 of 6");
    expect(saved()).toMatchObject({ origin: "new", basics: "pending", session: "pending" });
  });

  it("Start tour moves on to the Add project step; Back returns", async () => {
    setFreshBrowser(true);
    await mount();
    await act(async () => [...tour()!.querySelectorAll("button")].find((b) => b.textContent === "Start tour")!.click());
    expect(tour()!.dataset.step).toBe("project");
    expect(tour()!.textContent).toContain("Step 2 of 6");
    await press({ key: "ArrowLeft" });
    expect(tour()!.dataset.step).toBe("welcome");
  });

  it("a browser that has used the app (not fresh) gets no tour and is marked existing", async () => {
    localStorage.setItem("claude-ui.tabs", "[]");
    await mount();
    expect(tour()).toBeNull();
    expect(saved()).toEqual({ v: 1, origin: "existing", basics: "offered", session: "offered" });
  });

  it("a fresh browser on a daemon that already has projects gets no tour", async () => {
    setFreshBrowser(true);
    replies["session.list"] = { sessions: [session], projects: ["/p/demo"] };
    await mount();
    expect(tour()).toBeNull();
    expect(saved()).toMatchObject({ origin: "existing", basics: "offered" });
  });

  it("an existing state never auto-starts, on any later load", async () => {
    localStorage.setItem(GUIDE_KEY, JSON.stringify({ v: 1, origin: "existing", basics: "offered", session: "offered" }));
    setFreshBrowser(true);
    await mount();
    expect(tour()).toBeNull();
  });

  it("Esc skips for good with a toast; the next load shows no tour", async () => {
    setFreshBrowser(true);
    await mount();
    await press({ key: "Escape" });
    expect(tour()).toBeNull();
    expect(document.querySelector('[data-testid="toast"]')!.textContent).toBe("Tour closed. Restart it from Settings › Guide.");
    expect(saved()).toMatchObject({ basics: "skipped", session: "skipped" });
    unmount();
    await mount();
    expect(tour()).toBeNull();
  });

  it("a reload in the middle resumes at the saved step", async () => {
    setFreshBrowser(true);
    await mount();
    await press({ key: "ArrowRight" });
    await press({ key: "ArrowRight" });
    expect(tour()!.dataset.step).toBe("new-session");
    unmount();
    await mount();
    expect(tour()!.dataset.step).toBe("new-session");
    expect(tour()!.textContent).toContain("Step 3 of 6");
  });

  it("Ctrl+K opens no palette while the tour shows, and the app is inert", async () => {
    setFreshBrowser(true);
    await mount();
    await press({ key: "k", ctrlKey: true });
    expect(document.querySelector('[data-testid="palette"]')).toBeNull();
    expect(el.hasAttribute("inert")).toBe(true);
  });

  it("the end card's Add project opens the Open project dialog and finishes Basics", async () => {
    setFreshBrowser(true);
    await mount();
    for (let i = 0; i < 5; i++) await press({ key: "ArrowRight" });
    expect(tour()!.dataset.step).toBe("basics-end");
    await act(async () => [...tour()!.querySelectorAll("button")].find((b) => b.textContent === "Add project")!.click());
    await act(async () => {});
    expect(tour()).toBeNull();
    expect(document.querySelector('[data-testid="open-project-dialog"]')).not.toBeNull();
    expect(saved()).toMatchObject({ basics: "done" });
  });
});

describe("restart", () => {
  const skipped = { v: 1, origin: "new", basics: "skipped", session: "skipped" };
  it("Settings > Guide > Restart guide closes Settings and starts Basics at step 1", async () => {
    localStorage.setItem(GUIDE_KEY, JSON.stringify(skipped));
    await mount();
    expect(tour()).toBeNull();
    await act(async () => document.querySelector<HTMLElement>('[data-testid="open-settings"]')!.click());
    await act(async () => {});
    expect(document.querySelector('[data-testid="settings-dialog"]')).not.toBeNull();
    await act(async () => document.querySelector<HTMLElement>('[data-testid="settings-group-guide"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[data-testid="settings-guide-restart"]')!.click());
    await act(async () => {});
    expect(document.querySelector('[data-testid="settings-dialog"]')).toBeNull();
    expect(tour()!.dataset.step).toBe("welcome");
    expect(tour()!.textContent).toContain("Step 1 of 6");
    expect(saved()).toMatchObject({ basics: "pending", session: "pending" });
  });
  it("an existing user restarts it from the palette's Show guide", async () => {
    localStorage.setItem("claude-ui.tabs", "[]");
    await mount();
    expect(tour()).toBeNull();
    await press({ key: "k", code: "KeyK", ctrlKey: true });
    const row = [...document.querySelectorAll<HTMLElement>('[data-testid="palette"] [role="option"]')].find((o) => o.textContent?.startsWith("Show guide"))!;
    expect(row).toBeDefined();
    await act(async () => row.click());
    await act(async () => {});
    expect(tour()!.dataset.step).toBe("welcome");
  });
  it("Esc after a restart skips again and the focus returns to the Settings button", async () => {
    localStorage.setItem(GUIDE_KEY, JSON.stringify(skipped));
    await mount();
    const btn = document.querySelector<HTMLElement>('[data-testid="open-settings"]')!;
    Object.defineProperty(btn, "getClientRects", { value: () => [{}] });
    btn.getBoundingClientRect = () => ({ left: 0, top: 0, width: 50, height: 20, right: 50, bottom: 20, x: 0, y: 0, toJSON() {} });
    await act(async () => btn.click());
    await act(async () => document.querySelector<HTMLElement>('[data-testid="settings-group-guide"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[data-testid="settings-guide-restart"]')!.click());
    await act(async () => {});
    await press({ key: "Escape" });
    expect(tour()).toBeNull();
    expect(document.activeElement).toBe(btn);
  });
});

describe("chapter Your session", () => {
  const inSession = (git: boolean, state: object = { v: 1, origin: "new", basics: "done", session: "pending" }) => {
    localStorage.setItem(GUIDE_KEY, JSON.stringify(state));
    location.hash = `#${ID}`;
    replies["session.list"] = { sessions: [session], projects: ["/p/demo"] };
    replies["git.status"] = { status: git ? { branch: "main" } : null };
  };
  it("starts when a session shows and is idle: Tabs first, seven steps in a git work tree", async () => {
    inSession(true);
    await mount();
    expect(tour()!.dataset.step).toBe("tabs");
    expect(tour()!.textContent).toContain("Step 1 of 7");
  });
  it("waits for the git status, so a slow answer does not drop the Git graph step", async () => {
    inSession(true);
    let answer: (v: unknown) => void = () => {};
    replies["git.status"] = new Promise((r) => (answer = r));
    await mount();
    await act(async () => new Promise((r) => setTimeout(r, 3500)));
    expect(tour()).toBeNull();
    await act(async () => answer({ status: { branch: "main" } }));
    expect(tour()!.textContent).toContain("Step 1 of 7");
  });
  it("outside git the Git graph step is absent and the count is one less", async () => {
    inSession(false);
    await mount();
    expect(tour()!.textContent).toContain("Step 1 of 6");
    for (let i = 0; i < 2; i++) await press({ key: "ArrowRight" });
    expect(tour()!.dataset.step).toBe("changes");
    await press({ key: "ArrowRight" });
    expect(tour()!.dataset.step).toBe("terminal");
  });
  it("finishing it marks the chapter done and it does not start again", async () => {
    inSession(true);
    await mount();
    for (let i = 0; i < 6; i++) await press({ key: "ArrowRight" });
    expect(tour()!.dataset.step).toBe("shortcuts");
    await act(async () => [...tour()!.querySelectorAll("button")].find((b) => b.textContent === "Done")!.click());
    expect(tour()).toBeNull();
    expect(saved()).toMatchObject({ basics: "done", session: "done" });
  });
  it("does not start while the turn runs, and starts once it is idle", async () => {
    inSession(true);
    const head = { type: "event", sessionId: ID, seq: 1, part: { type: "session_state", id: "st", state: "running" } };
    replies["session.subscribe"] = { logEpoch: "e1", seq: 1, session: { ...session, state: "running" }, title: "Demo", snapshot: { heads: [head], attentionSeq: 0, page: { parts: [] }, aux: [] } };
    await mount();
    expect(tour()).toBeNull();
    await act(async () => emit({ ...head, seq: 2, part: { ...head.part, state: "idle" } }));
    expect(tour()!.dataset.step).toBe("tabs");
  });
  it("a state that was offered or skipped never starts it", async () => {
    inSession(true, { v: 1, origin: "existing", basics: "offered", session: "offered" });
    await mount();
    expect(tour()).toBeNull();
  });
  it("a fresh Basics run with a session already shown chains into it (no end card)", async () => {
    inSession(true, { v: 1, origin: "new", basics: "pending", session: "pending" });
    await mount();
    expect(tour()!.textContent).toContain("Step 1 of 12");
  });
});

describe("anchor drift guard: every step's anchors match an element of the rendered app", () => {
  const hits = (step: GuideStep, narrow: boolean) => {
    const r = adapt(step, narrow);
    return [...r.anchors, ...(r.alt?.anchors ?? [])].some((sel) => document.querySelector(sel));
  };
  for (const w of [1440, 390]) {
    it(`app with a session in a git work tree at ${w}px (every step with an anchor)`, async () => {
      width = w;
      location.hash = `#${ID}`;
      replies["session.list"] = { sessions: [session], projects: ["/p/demo"] };
      replies["git.status"] = { status: { branch: "main" } };
      replies["terminal.list"] = { terminals: [{ id: "t1", title: "Terminal 1" }] };
      localStorage.setItem(GUIDE_KEY, JSON.stringify({ v: 1, origin: "existing", basics: "offered", session: "offered" }));
      await mount();
      const withAnchor = STEPS.filter((s) => s.chapter === "session" && adapt(s, w < 768).anchors.length);
      for (const s of withAnchor) expect(hits(s, w < 768), `${s.id} at ${w}`).toBe(true);
      for (const id of ["session.new", "sidebar.toggle", "file.open", "settings.open"]) expect(document.querySelector(`[data-command="${id}"]`) !== null || w < 768, id).toBe(true);
    });
    it(`fresh app at ${w}px (Basics steps with an anchor)`, async () => {
      width = w;
      await mount();
      const withAnchor = STEPS.filter((s) => s.chapter === "basics" && adapt(s, w < 768).anchors.length);
      expect(withAnchor.length).toBeGreaterThan(0);
      for (const s of withAnchor) expect(hits(s, w < 768), `${s.id} at ${w}`).toBe(true);
    });
  }
});

const chips = () => [...tour()!.querySelectorAll('[data-testid="guide-keys"] kbd span')].map((s) => s.textContent);
const stepTo = async (id: string) => {
  for (let i = 0; i < 20 && tour()!.dataset.step !== id; i++) await press({ key: "ArrowRight" });
  expect(tour()!.dataset.step).toBe(id);
};

describe("keys follow the user's keymap", () => {
  const inSession = () => {
    localStorage.setItem(GUIDE_KEY, JSON.stringify({ v: 1, origin: "new", basics: "done", session: "pending" }));
    location.hash = `#${ID}`;
    replies["session.list"] = { sessions: [session], projects: ["/p/demo"] };
    replies["git.status"] = { status: { branch: "main" } };
  };
  it("a rebound Show files shows the new chips on the Files step", async () => {
    inSession();
    bind("pane.files", "mod+alt+j");
    await mount();
    await stepTo("files");
    expect(chips()).toEqual(["Ctrl", "Alt", "J"]);
  });
  it("rebinding while the tour shows updates the chips, and removing the key hides the line", async () => {
    inSession();
    await mount();
    await stepTo("files");
    expect(chips()).toEqual(["Ctrl", "Shift", "E"]);
    await act(async () => bind("pane.files", "mod+alt+j"));
    expect(chips()).toEqual(["Ctrl", "Alt", "J"]);
    await act(async () => bind("pane.files", null));
    expect(tour()!.querySelector('[data-testid="guide-keys"]')).toBeNull();
  });
  it("the last step shows the Keyboard shortcuts key; Show all shortcuts opens the dialog and finishes the chapter", async () => {
    inSession();
    bind("shortcuts.open", "mod+alt+k");
    await mount();
    await stepTo("shortcuts");
    expect(chips()).toEqual(["Ctrl", "Alt", "K"]);
    await act(async () => [...tour()!.querySelectorAll("button")].find((b) => b.textContent === "Show all shortcuts")!.click());
    await act(async () => {});
    expect(tour()).toBeNull();
    expect(document.querySelector('[data-testid="shortcuts-filter"]')).not.toBeNull();
    expect(saved()).toMatchObject({ basics: "done", session: "done" });
  });
});

describe("a tour that ends where nothing was focused", () => {
  it("palette Show guide with no session: the control the palette was opened from has the focus after Esc (the tour's own return)", async () => {
    localStorage.setItem("claude-ui.tabs", "[]");
    await mount();
    const from = document.querySelector<HTMLElement>('[data-testid="tab-new"]')!;
    Object.defineProperty(from, "getClientRects", { value: () => [{}] });
    from.focus();
    await press({ key: "k", code: "KeyK", ctrlKey: true });
    const row = [...document.querySelectorAll<HTMLElement>('[data-testid="palette"] [role="option"]')].find((o) => o.textContent?.startsWith("Show guide"))!;
    await act(async () => row.click());
    await act(async () => {});
    expect(tour()!.dataset.step).toBe("welcome");
    await press({ key: "Escape" });
    expect(tour()).toBeNull();
    expect(document.activeElement).toBe(from);
  });
});

describe("a palette-started tour that ends with nothing to return to", () => {
  it("opened with nothing focused and no session shown: Esc lands on the New session button, not on the page", async () => {
    localStorage.setItem("claude-ui.tabs", "[]");
    await mount();
    const plus = document.querySelector<HTMLElement>('[data-testid="tab-new"]')!;
    Object.defineProperty(plus, "getClientRects", { value: () => [{}] });
    plus.getBoundingClientRect = () => ({ left: 100, top: 4, width: 32, height: 32, right: 132, bottom: 36, x: 100, y: 4, toJSON() {} });
    (document.activeElement as HTMLElement).blur();
    // In a real browser body is "visible" (it has a size): the remembered opener must still be rejected.
    Object.defineProperty(document.body, "getClientRects", { value: () => [{}], configurable: true });
    const bodyRect = vi.spyOn(document.body, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} });
    await press({ key: "k", code: "KeyK", ctrlKey: true });
    const row = [...document.querySelectorAll<HTMLElement>('[data-testid="palette"] [role="option"]')].find((o) => o.textContent?.startsWith("Show guide"))!;
    await act(async () => row.click());
    await act(async () => {});
    expect(tour()).not.toBeNull();
    await press({ key: "Escape" });
    expect(tour()).toBeNull();
    expect(document.activeElement).toBe(plus);
    bodyRect.mockRestore();
    delete (document.body as { getClientRects?: unknown }).getClientRects;
  });
});

describe("the side panel hidden (crash regression, whole App)", () => {
  it("walking the whole run with the side panel toggled off ends cleanly, Files to Git graph point at the toggle", async () => {
    localStorage.setItem(GUIDE_KEY, JSON.stringify({ v: 1, origin: "existing", basics: "offered", session: "offered" }));
    location.hash = `#${ID}`;
    replies["session.list"] = { sessions: [session], projects: ["/p/demo"] };
    replies["git.status"] = { status: { branch: "main" } };
    await mount();
    const toggle = document.querySelector<HTMLElement>('[data-testid="panel-toggle"]')!;
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // jsdom lays nothing out: only the toggle is "on screen", as in a browser with the panel hidden.
    Object.defineProperty(toggle, "getClientRects", { value: () => [{}] });
    toggle.getBoundingClientRect = () => ({ left: 900, top: 4, width: 32, height: 32, right: 932, bottom: 36, x: 900, y: 4, toJSON() {} });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => document.querySelector<HTMLElement>('[data-testid="open-settings"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[data-testid="settings-group-guide"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[data-testid="settings-guide-restart"]')!.click());
    await act(async () => {});
    expect(tour()!.textContent).toContain("Step 1 of 12");
    for (const id of ["files", "changes", "graph"]) {
      await stepTo(id);
      expect(tour()!.textContent).toContain("Show the side panel");
      expect(document.querySelector('[data-testid="guide-spotlight"]')).not.toBeNull();
    }
    await stepTo("terminal");
    expect(tour()!.textContent).toContain("A shell in the project folder");
    await stepTo("shortcuts");
    await act(async () => [...tour()!.querySelectorAll("button")].find((b) => b.textContent === "Done")!.click());
    expect(tour()).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
