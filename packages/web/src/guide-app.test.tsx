// @vitest-environment jsdom
// App wiring of the guided tour (docs/spec.md "First-use guide"), with a fake daemon connection.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";
import { setFreshBrowser, GUIDE_KEY } from "./guide.ts";
import { adapt, STEPS, type GuideStep } from "./guide-steps.ts";

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
  connect: (opts: { onOpen?: () => void; onStatus?: (s: string) => void }) => {
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

describe("anchor drift guard: every step's anchors match an element of the rendered app", () => {
  const hits = (step: GuideStep, narrow: boolean) => {
    const r = adapt(step, narrow);
    return [...r.anchors, ...(r.alt?.anchors ?? [])].some((sel) => document.querySelector(sel));
  };
  for (const w of [1440, 390]) {
    it(`fresh app at ${w}px (Basics steps with an anchor)`, async () => {
      width = w;
      await mount();
      const withAnchor = STEPS.filter((s) => s.chapter === "basics" && adapt(s, w < 768).anchors.length);
      expect(withAnchor.length).toBeGreaterThan(0);
      for (const s of withAnchor) expect(hits(s, w < 768), `${s.id} at ${w}`).toBe(true);
    });
  }
});
