// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Part } from "@claude-ui/protocol";
import { ArtifactsPane, selectArtifact } from "./artifacts-pane.tsx";
import type { ArtifactPreviewLoader } from "./artifact-preview.tsx";
import { emptySession, type SessionView } from "./store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let width = 0; // 0: the observer never reports (jsdom, wide)
globalThis.ResizeObserver = class {
  constructor(private cb: (e: { contentRect: { width: number } }[]) => void) {}
  observe() {
    if (width) this.cb([{ contentRect: { width } }]);
  }
  unobserve() {}
  disconnect() {}
} as never;

const pub = (id: string, input: Record<string, unknown>, endedAt: number): Part => ({ type: "tool_call", id, toolUseId: id, tool: "Artifact", input, status: "done", endedAt });
const res = (id: string, output: string): Part => ({ type: "tool_result", id: `${id}:result`, toolUseId: id, output, isError: false });
const view = (parts: Part[], over: Partial<SessionView> = {}): SessionView => ({ ...emptySession(), order: parts.map((p) => p.id), parts: new Map(parts.map((p) => [p.id, p])), ...over });
const PARTS = [pub("p1", { file_path: "/w/report.html", title: "Report" }, Date.now() - 3 * 3_600_000), pub("p2", { file_path: "/w/notes.md" }, Date.now() - 60_000), res("p2", "https://claude.ai/artifact/abc"), pub("p3", { file_path: "/w/chart.html" }, Date.now())];

let n = 0; // a fresh owner per mount: the selection outlives a mount
const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
const loader = () => vi.fn<ArtifactPreviewLoader>(async (partId) => ({ url: `/artifact/${"a".repeat(32)}/${partId}.html`, size: 1, mtime: 1 }));
const mount = async (v: SessionView | undefined, o: Partial<React.ComponentProps<typeof ArtifactsPane>> = {}) => {
  const p = { view: v, owner: `s${++n}`, label: "Artifacts", load: loader(), connected: true, onOpenTab: vi.fn(), requestOlder: vi.fn(), ...o };
  await act(async () => root.render(<ArtifactsPane {...p} />));
  return p;
};
const options = () => [...el.querySelectorAll<HTMLElement>('[role="option"]')];
const click = async (t: HTMLElement) => void (await act(async () => t.click()));
afterEach(async () => {
  width = 0;
  await act(async () => root.render(null));
});

describe("ArtifactsPane", () => {
  it("lists the publishes newest first with title, file name and age; the newest is selected and previewed", async () => {
    const p = await mount(view(PARTS));
    expect(options().map((o) => o.querySelector("[data-testid=artifact-row-title]")!.textContent)).toEqual(["chart.html", "notes.md", "Report"]);
    expect(options()[2]!.textContent).toContain("report.html");
    expect(options()[2]!.textContent).toContain("3h");
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(p.load).toHaveBeenCalledWith("p3");
    expect(el.querySelector("iframe")).not.toBeNull();
  });

  it("selecting a previewable row loads its page; a row without a local file shows No local preview and its claude.ai link", async () => {
    const p = await mount(view(PARTS));
    await click(options()[2]!);
    expect(p.load).toHaveBeenCalledWith("p1");
    await click(options()[1]!);
    expect(el.querySelector("iframe")).toBeNull();
    expect(el.textContent).toContain("No local preview");
    expect(el.querySelector<HTMLAnchorElement>('a[href="https://claude.ai/artifact/abc"]')).not.toBeNull();
  });

  it("arrow keys move the selection", async () => {
    await mount(view(PARTS));
    await act(async () => options()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    await act(async () => options()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("Open in tab acts on the selected previewable row and is absent for the others", async () => {
    const p = await mount(view(PARTS));
    const btn = () => [...el.querySelectorAll("button")].find((b) => b.textContent === "Open in tab");
    await click(options()[2]!);
    await click(btn()!);
    expect(p.onOpenTab).toHaveBeenCalledWith("p1");
    await click(options()[1]!);
    expect(btn()).toBeUndefined();
  });

  it("selectArtifact preselects a row of that owner", async () => {
    const p = await mount(view(PARTS));
    await act(async () => selectArtifact(p.owner, "p1"));
    expect(options()[2]!.getAttribute("aria-selected")).toBe("true");
  });

  it("asks for older parts while the view has an unloaded region and no artifacts list yet, then stops", async () => {
    const older = { before: "u9", pos: 90 };
    const p = await mount(view(PARTS, { older }));
    expect(p.requestOlder).toHaveBeenCalled();
    const q = await mount(view(PARTS, { older, auxArtifacts: true }));
    expect(q.requestOlder).not.toHaveBeenCalled();
  });

  it("an empty list says No artifacts in this session yet.; no view shows loading; a failed one an error", async () => {
    await mount(view([]));
    expect(el.textContent).toContain("No artifacts in this session yet.");
    await mount(undefined);
    expect(el.textContent).toContain("Loading");
    await mount(undefined, { failed: true });
    expect(el.textContent).toContain("Could not load this session.");
  });

  it("below 720 px: the list alone; selecting shows the preview with an All artifacts back button", async () => {
    width = 400;
    await mount(view(PARTS));
    expect(el.querySelector("iframe")).toBeNull();
    await click(options()[0]!);
    expect(el.querySelector("iframe")).not.toBeNull();
    expect(options()).toHaveLength(0);
    await click([...el.querySelectorAll("button")].find((b) => b.textContent === "All artifacts")!);
    expect(options()).toHaveLength(3);
  });
});
