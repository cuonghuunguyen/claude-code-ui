// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactConnectedContext, ArtifactFrame, ArtifactOpenedContext, ArtifactPreview, ArtifactPreviewContext, ArtifactTabContext, type ArtifactPreviewLoader } from "./artifact-preview.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
let n = 0;
const ok = () => vi.fn<ArtifactPreviewLoader>(async () => ({ url: `/artifact/${"a".repeat(32)}/p.html?v=${++n}`, size: 1, mtime: n }));
const mount = async (loader: ArtifactPreviewLoader | undefined, _unused = 0, partId = `toolu_${n++}`, connected = true) => {
  await act(async () =>
    root.render(
      <ArtifactConnectedContext value={connected}>
        <ArtifactPreviewContext value={loader}>
          <ArtifactPreview partId={partId} title="T" />
        </ArtifactPreviewContext>
      </ArtifactConnectedContext>,
    ),
  );
};
const button = (label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const click = async (label: string) => void (await act(async () => button(label)!.click()));
afterEach(async () => await act(async () => root.render(null)));

describe("ArtifactPreview", () => {
  it("collapsed by default: a Show preview button, no request", async () => {
    const loader = ok();
    await mount(loader);
    expect(button("Show preview")).toBeDefined();
    expect(loader).not.toHaveBeenCalled();
    expect(el.querySelector("iframe")).toBeNull();
  });

  it("Show preview loads the URL into a sandboxed iframe without same-origin", async () => {
    const loader = ok();
    await mount(loader, 0, "toolu_a");
    await click("Show preview");
    expect(loader).toHaveBeenCalledWith("toolu_a");
    const f = el.querySelector("iframe")!;
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
    expect(f.getAttribute("src")).toMatch(/\/p\.html\?v=\d+$/);
    expect(f.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(f.hasAttribute("allow")).toBe(false);
    expect(f.getAttribute("title")).toBe("Preview: T");
  });

  it('a gone file shows "Preview not available: file is gone"', async () => {
    await mount(vi.fn(async () => Promise.reject(Object.assign(new Error("x"), { code: "not_found" }))));
    await click("Show preview");
    expect(el.textContent).toContain("Preview not available: file is gone");
    expect(el.querySelector("iframe")).toBeNull();
  });

  it("another failure shows its message", async () => {
    await mount(vi.fn(async () => Promise.reject(Object.assign(new Error("larger than 16 MiB: /t/a.html"), { code: "too_large" }))));
    await click("Show preview");
    expect(el.textContent).toContain("Preview not available: larger than 16 MiB: /t/a.html");
  });

  it("Hide preview removes the frame; Reload asks again", async () => {
    const loader = ok();
    await mount(loader);
    await click("Show preview");
    await click("Reload");
    expect(loader).toHaveBeenCalledTimes(2);
    await click("Hide preview");
    expect(el.querySelector("iframe")).toBeNull();
    expect(button("Show preview")).toBeDefined();
  });

  it("names the supporting files the preview cannot load", async () => {
    await mount(vi.fn<ArtifactPreviewLoader>(async () => ({ url: "/artifact/n/p.html", size: 1, mtime: 1, unavailable: ["a.css", "img/b.png"] })));
    await click("Show preview");
    expect(el.textContent).toContain("2 supporting files not loaded: a.css, img/b.png");
    expect(el.textContent).toContain("Local file, shown offline");
  });

  it("names one file in the singular and shortens a long list to three names", async () => {
    await mount(vi.fn<ArtifactPreviewLoader>(async () => ({ url: "/artifact/n/p.html", size: 1, mtime: 1, unavailable: ["only.css"] })));
    await click("Show preview");
    expect(el.textContent).toContain("1 supporting file not loaded: only.css");
    await click("Hide preview");
    await mount(vi.fn<ArtifactPreviewLoader>(async () => ({ url: "/artifact/n/p.html", size: 1, mtime: 1, unavailable: ["a", "b", "c", "d", "e"] })));
    await click("Show preview");
    expect(el.textContent).toContain("5 supporting files not loaded: a, b, c, …");
  });

  it("no note when every supporting file loads", async () => {
    await mount(ok());
    await click("Show preview");
    expect(el.textContent).not.toContain("not loaded");
  });

  it("without the context nothing renders", async () => {
    await mount(undefined);
    expect(el.innerHTML).toBe("");
  });

  it("buttons are 44 px below md", async () => {
    await mount(ok());
    expect(button("Show preview")!.className).toMatch(/min-h-11/);
    expect(button("Show preview")!.className).toMatch(/md:min-h-0/);
    await click("Show preview");
    for (const l of ["Hide preview", "Reload"]) {
      expect(button(l)!.className).toMatch(/min-h-11/);
      expect(button(l)!.className).toMatch(/md:min-h-0/);
    }
  });

  it("Reload remounts the frame even when the URL is unchanged", async () => {
    const loader = vi.fn<ArtifactPreviewLoader>(async () => ({ url: "/artifact/same/p.html?v=1", size: 1, mtime: 1 }));
    await mount(loader);
    await click("Show preview");
    const before = el.querySelector("iframe");
    await click("Reload");
    expect(el.querySelector("iframe")).not.toBe(before);
  });

  it("a reconnect while open asks for a fresh URL", async () => {
    const loader = ok();
    await mount(loader, 0, "toolu_rc");
    await click("Show preview");
    const first = el.querySelector("iframe")!.getAttribute("src");
    await mount(loader, 0, "toolu_rc", false);
    expect(loader).toHaveBeenCalledTimes(1);
    await mount(loader, 0, "toolu_rc", true);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(el.querySelector("iframe")!.getAttribute("src")).not.toBe(first);
  });

  it("a reconnect while collapsed asks for nothing", async () => {
    const loader = ok();
    await mount(loader, 0, "toolu_rc2");
    await mount(loader, 0, "toolu_rc2", false);
    await mount(loader, 0, "toolu_rc2", true);
    expect(loader).not.toHaveBeenCalled();
  });

  it("a request cut by a dropped connection is asked again on reconnect", async () => {
    const loader = vi
      .fn<ArtifactPreviewLoader>()
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockResolvedValue({ url: "/artifact/n/p.html?v=9", size: 1, mtime: 9 });
    await mount(loader, 0, "toolu_pd");
    await click("Show preview");
    expect(el.textContent).toContain("disconnected");
    await mount(loader, 0, "toolu_pd", false);
    await mount(loader, 0, "toolu_pd", true);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(el.querySelector("iframe")!.getAttribute("src")).toContain("v=9");
  });

  it("another failure is not asked again on reconnect", async () => {
    const loader = vi.fn(async () => Promise.reject(Object.assign(new Error("larger"), { code: "too_large" })));
    await mount(loader, 0, "toolu_pe");
    await click("Show preview");
    await mount(loader, 0, "toolu_pe", false);
    await mount(loader, 0, "toolu_pe", true);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("the offline note names what is blocked", async () => {
    await mount(ok());
    await click("Show preview");
    expect(el.textContent).toContain("Local file, shown offline: network requests, remote scripts, images, fonts and links are blocked.");
  });
});

const frameOf = (loader: ArtifactPreviewLoader | undefined, partId: string, o: { connected?: boolean; fill?: boolean; onTitle?: (t: string) => void } = {}) => (
  <ArtifactConnectedContext value={o.connected ?? true}>
    <ArtifactPreviewContext value={loader}>
      <ArtifactFrame partId={partId} title="T" fill={o.fill} onTitle={o.onTitle} />
    </ArtifactPreviewContext>
  </ArtifactConnectedContext>
);
const mountFrame = (...a: Parameters<typeof frameOf>) => act(async () => root.render(frameOf(...a)));

describe("ArtifactFrame (GH-400)", () => {
  it("requests on mount, shows the sandboxed iframe; fill drops the 60vh cap", async () => {
    const loader = ok();
    await mountFrame(loader, "toolu_f1", { fill: true });
    expect(loader).toHaveBeenCalledWith("toolu_f1");
    const f = el.querySelector("iframe")!;
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
    expect(f.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(f.hasAttribute("allow")).toBe(false);
    expect(f.className).not.toMatch(/h-\[60vh\]/);
    expect(f.className).toMatch(/flex-1/);
    await mountFrame(loader, "toolu_f1b");
    expect(el.querySelector("iframe")!.className).toMatch(/h-\[60vh\]/);
  });

  it("Reload requests again and remounts the iframe; a reconnect requests again", async () => {
    const loader = ok();
    await mountFrame(loader, "toolu_f2");
    const before = el.querySelector("iframe");
    await click("Reload");
    expect(loader).toHaveBeenCalledTimes(2);
    expect(el.querySelector("iframe")).not.toBe(before);
    await mountFrame(loader, "toolu_f2", { connected: false });
    expect(loader).toHaveBeenCalledTimes(2);
    await mountFrame(loader, "toolu_f2", { connected: true });
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("not_found and a daemon error show their text", async () => {
    await mountFrame(vi.fn(async () => Promise.reject(Object.assign(new Error("x"), { code: "not_found" }))), "toolu_f3");
    expect(el.querySelector('[role="alert"]')!.textContent).toBe("Preview not available: file is gone");
    await mountFrame(vi.fn(async () => Promise.reject(Object.assign(new Error("A side session has no local files"), { code: "side_unsupported" }))), "toolu_f4");
    expect(el.querySelector('[role="alert"]')!.textContent).toBe("Preview not available: A side session has no local files");
    expect(el.querySelector("iframe")).toBeNull();
  });

  it("onTitle gets the title of the reply", async () => {
    const onTitle = vi.fn();
    await mountFrame(vi.fn<ArtifactPreviewLoader>(async () => ({ url: "/artifact/n/p.html", size: 1, mtime: 1, title: "Sales" })), "toolu_f5", { onTitle });
    expect(onTitle).toHaveBeenCalledWith("Sales");
  });

  it("card and frame of one part request on their own; hiding the card keeps the frame; a frame does not open the card", async () => {
    const loader = ok();
    const both = (card: boolean) => (
      <ArtifactOpenedContext value={opened}>
        <ArtifactConnectedContext value={true}>
          <ArtifactPreviewContext value={loader}>
            {card && <ArtifactPreview partId="toolu_f6" title="T" />}
            <div id="tab">
              <ArtifactFrame partId="toolu_f6" title="T" fill />
            </div>
          </ArtifactPreviewContext>
        </ArtifactConnectedContext>
      </ArtifactOpenedContext>
    );
    const opened = new Set<string>();
    await act(async () => root.render(both(true)));
    expect(loader).toHaveBeenCalledTimes(1); // the frame only: the card is collapsed
    expect(button("Show preview")).toBeDefined();
    expect(opened.has("toolu_f6")).toBe(false);
    await click("Show preview");
    expect(loader).toHaveBeenCalledTimes(2);
    expect(el.querySelectorAll("iframe")).toHaveLength(2);
    await click("Hide preview");
    expect(loader).toHaveBeenCalledTimes(2);
    expect(el.querySelectorAll("iframe")).toHaveLength(1);
    expect(el.querySelector("#tab iframe")).not.toBeNull();
  });

  it("a card remount in the same ArtifactOpenedContext stays open; a fresh one is collapsed", async () => {
    const loader = ok();
    const card = (set: Set<string>) => (
      <ArtifactOpenedContext value={set}>
        <ArtifactPreviewContext value={loader}>
          <ArtifactPreview partId="toolu_f7" title="T" />
        </ArtifactPreviewContext>
      </ArtifactOpenedContext>
    );
    const set = new Set<string>();
    await act(async () => root.render(card(set)));
    await click("Show preview");
    await act(async () => root.render(null));
    await act(async () => root.render(card(set)));
    expect(el.querySelector("iframe")).not.toBeNull();
    await act(async () => root.render(null));
    await act(async () => root.render(card(new Set())));
    expect(button("Show preview")).toBeDefined();
  });

  it("Open in tab shows only with ArtifactTabContext, in both card states, 44 px, and passes the part id", async () => {
    const loader = ok();
    const onTab = vi.fn();
    const card = (tab?: (p: string) => void) => (
      <ArtifactTabContext value={tab}>
        <ArtifactPreviewContext value={loader}>
          <ArtifactPreview partId="toolu_f8" title="T" />
        </ArtifactPreviewContext>
      </ArtifactTabContext>
    );
    await act(async () => root.render(card()));
    expect(button("Open in tab")).toBeUndefined();
    await act(async () => root.render(card(onTab)));
    expect(button("Open in tab")!.className).toMatch(/min-h-11/);
    expect(button("Open in tab")!.className).toMatch(/md:min-h-0/);
    await click("Open in tab");
    expect(onTab).toHaveBeenCalledWith("toolu_f8");
    expect(loader).not.toHaveBeenCalled();
    await click("Show preview");
    expect(button("Open in tab")).toBeDefined();
    await click("Open in tab");
    expect(onTab).toHaveBeenCalledTimes(2);
  });
});
