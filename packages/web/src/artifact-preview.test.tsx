// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactConnectedContext, ArtifactPreview, ArtifactPreviewContext, type ArtifactPreviewLoader } from "./artifact-preview.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
let n = 0;
const ok = () => vi.fn<ArtifactPreviewLoader>(async () => ({ url: `/artifact/${"a".repeat(32)}/p.html?v=${++n}`, size: 1, mtime: n }));
const mount = async (loader: ArtifactPreviewLoader | undefined, files = 0, partId = `toolu_${n++}`, connected = true) => {
  await act(async () =>
    root.render(
      <ArtifactConnectedContext value={connected}>
        <ArtifactPreviewContext value={loader}>
          <ArtifactPreview partId={partId} title="T" files={files} />
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

  it("a multi-file publish says only the main page is shown", async () => {
    await mount(ok(), 2);
    await click("Show preview");
    expect(el.textContent).toContain("Main page only: 2 supporting files not loaded.");
    expect(el.textContent).toContain("Local file, shown offline");
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
