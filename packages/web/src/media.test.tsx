// @vitest-environment jsdom
import { omittedImage } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageStrip } from "./images.tsx";
import { loadMedia, MEDIA_CACHE_CHARS, MediaContext, restoreImages, useMediaSrc } from "./media.ts";
import { ToolBody } from "./tool-card.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const png = "data:image/png;base64,AAA";

describe("tool_result image left out of a snapshot", () => {
  const read = (loader?: (id: string, i: number) => Promise<string>) => (
    <MediaContext value={loader}>
      <ToolBody
        call={{ type: "tool_call", id: "t1", toolUseId: "t1", tool: "Read", input: { file_path: "/w/a.png" }, status: "done" } as never}
        result={{ type: "tool_result", id: "t1:result", toolUseId: "t1", isError: false, output: [{ type: "text", text: "x" }, { type: "image", source: { type: "omitted", media_type: "image/png", bytes: 1600 } }] } as never}
      />
    </MediaContext>
  );

  it("shows its type and size and loads through MediaContext", async () => {
    const loader = vi.fn(async () => png);
    await act(async () => root.render(read(loader)));
    await flush();
    expect(el.textContent).toContain("image/png, 1.6 KB");
    expect(el.querySelector("img")?.getAttribute("src")).toBe(png);
    expect(loader).toHaveBeenCalledExactlyOnceWith("t1:result", 1);
  });

  it("without a loader shows only its caption", async () => {
    await act(async () => root.render(read()));
    expect(el.textContent).toContain("image/png, 1.6 KB");
    expect(el.querySelector("img")).toBeNull();
  });
});

describe("ImageStrip with an omitted image", () => {
  it("shows a sized placeholder while loading, then the image; inline images need no load", async () => {
    let done!: (u: string) => void;
    const loader = vi.fn(() => new Promise<string>((r) => (done = r)));
    await act(async () => root.render(<MediaContext value={loader}><ImageStrip images={[omittedImage("image/png", 1000), png]} partId="u-strip" /></MediaContext>));
    expect(el.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(el.querySelectorAll("img")).toHaveLength(1);
    await act(async () => done("data:image/png;base64,BBB"));
    expect(el.querySelectorAll("img")).toHaveLength(2);
    expect(loader).toHaveBeenCalledExactlyOnceWith("u-strip", 0);
  });
});

describe("failed and loading states", () => {
  it("a Read image shows a fixed-size Loading image box, then a notice with Retry that requests it again", async () => {
    let fail = true;
    const loader = vi.fn(async () => { if (fail) throw new Error("no"); return png; });
    await act(async () => root.render(
      <MediaContext value={loader}>
        <ToolBody
          call={{ type: "tool_call", id: "t9", toolUseId: "t9", tool: "Read", input: { file_path: "/w/b.png" }, status: "done" } as never}
          result={{ type: "tool_result", id: "t9:result", toolUseId: "t9", isError: false, output: [{ type: "image", source: { type: "omitted", media_type: "image/png", bytes: 1600 } }] } as never}
        />
      </MediaContext>,
    ));
    const box = el.querySelector<HTMLElement>('[data-testid="media-placeholder"]')!;
    expect(box.className).toMatch(/\bh-52\b/);
    await flush();
    expect(el.textContent).toContain("Image could not be loaded");
    const retry = [...el.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
    expect(retry.className).toContain("min-h-11");
    expect(retry.getAttribute("aria-label")).toBe("Retry loading /w/b.png");
    expect(box.getAttribute("role")).toBe("group");
    fail = false;
    await act(async () => retry.click());
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(el.querySelector("img")?.getAttribute("src")).toBe(png);
  });

  it("a prompt thumbnail that failed shows the notice and loads after Retry", async () => {
    let fail = true;
    const loader = vi.fn(async () => { if (fail) throw new Error("no"); return png; });
    await act(async () => root.render(<MediaContext value={loader}><ImageStrip images={[omittedImage("image/png", 1000)]} partId="u-fail" /></MediaContext>));
    await flush();
    expect(el.textContent).toContain("Image could not be loaded");
    expect(el.querySelector("img")).toBeNull();
    fail = false;
    await act(async () => [...el.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click());
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(el.querySelectorAll("img").length).toBeGreaterThan(0);
  });
});

describe("useMediaSrc", () => {
  function Probe({ id }: { id: string }) {
    return <i data-src={useMediaSrc(id, 0, true).src ?? ""} />;
  }
  it("loads each part payload once and retries after a failure", async () => {
    const loader = vi.fn(async () => png);
    await act(async () => root.render(<MediaContext value={loader}><Probe id="same" /><Probe id="same" /></MediaContext>));
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    expect([...el.querySelectorAll("i")].map((i) => i.dataset.src)).toEqual([png, png]);

    const bad = vi.fn(async () => { throw new Error("no"); });
    await act(async () => root.render(<MediaContext value={bad}><Probe id="flaky" /></MediaContext>));
    await flush();
    await act(async () => root.render(<></>));
    await act(async () => root.render(<MediaContext value={bad}><Probe id="flaky" /></MediaContext>));
    await flush();
    expect(bad).toHaveBeenCalledTimes(2);
  });
});

describe("media cache by size, restoreImages", () => {
  it("evicts the least recently used payloads once the cache holds more than MEDIA_CACHE_CHARS", async () => {
    const big = "A".repeat(Math.floor(MEDIA_CACHE_CHARS * 0.4));
    const loader = vi.fn(async () => big);
    await loadMedia(loader, "ev", 0);
    await loadMedia(loader, "ev", 1);
    await loadMedia(loader, "ev", 0); // 0 is now the most recent
    await loadMedia(loader, "ev", 2); // over the limit: 1 goes
    await new Promise((r) => setTimeout(r, 0));
    expect(loader).toHaveBeenCalledTimes(3);
    await loadMedia(loader, "ev", 0);
    expect(loader).toHaveBeenCalledTimes(3);
    await loadMedia(loader, "ev", 1);
    expect(loader).toHaveBeenCalledTimes(4);
  });

  it("restoreImages reads a loaded image from the cache, and rejects naming the image that failed", async () => {
    const loader = vi.fn(async () => png);
    await loadMedia(loader, "rw", 1);
    const images = [png, omittedImage("image/png", 5)];
    expect(await restoreImages(images, "rw", loader)).toEqual([png, png]);
    expect(loader).toHaveBeenCalledTimes(1);
    await expect(restoreImages([omittedImage("image/png", 5)], "rw-bad", vi.fn(async () => { throw new Error("x"); }))).rejects.toThrow(/Image 1 could not be loaded/);
    await expect(restoreImages([omittedImage("image/png", 5)], "rw-none", undefined)).rejects.toThrow(/Image 1/);
  });
});
