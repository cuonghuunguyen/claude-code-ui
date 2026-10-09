// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ImageStrip } from "./images.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const png = "data:image/png;base64,iVBORw0KGgo=";

describe("ImageStrip", () => {
  it("shows each image as a preview", () => {
    const html = renderToStaticMarkup(<ImageStrip images={[png, png]} />);
    expect(html.match(new RegExp(`<img[^>]*src="${png}"`, "g"))).toHaveLength(2);
    expect(html).not.toContain("Remove image");
  });

  it("has a remove button per image when removable", () => {
    const html = renderToStaticMarkup(<ImageStrip images={[png, png]} onRemove={() => {}} />);
    expect(html.match(/aria-label="Remove image \d"/g)).toHaveLength(2);
  });

  it("renders nothing without images", () => {
    expect(renderToStaticMarkup(<ImageStrip images={[]} />)).toBe("");
  });

  it("shows images uncropped in their own ratio, inside a max box", () => {
    const html = renderToStaticMarkup(<ImageStrip images={[png]} />);
    expect(html).toContain("object-contain");
    expect(html).toContain("max-h-40");
    expect(html).not.toContain("object-cover");
    expect(html).not.toContain("size-16");
  });
});

describe("image lightbox", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = "";
  });

  async function mount() {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<ImageStrip images={[png, png]} />));
    const thumb = (n: number) => document.querySelector<HTMLButtonElement>(`button[aria-label="View image ${n}"]`)!;
    const box = () => document.querySelector<HTMLElement>('[data-testid="image-lightbox"]');
    return { thumb, box };
  }

  it("opens the full image from the thumbnail button, closes with Close and Esc, and returns focus", { timeout: 20_000 }, async () => {
    const { thumb, box } = await mount();
    expect(thumb(1).tagName).toBe("BUTTON");
    expect(thumb(1).querySelector("img")!.getAttribute("alt")).toBe("Image 1");
    expect(box()).toBeNull();

    thumb(2).focus();
    await act(async () => thumb(2).click());
    expect(box()).not.toBeNull();
    expect(box()!.querySelector("img")!.className).toContain("max-w-[90vw]");
    expect(box()!.querySelector("img")!.getAttribute("alt")).toBe("Image 2");
    expect(box()!.contains(document.activeElement)).toBe(true);

    await act(async () => document.querySelector<HTMLElement>('[aria-label="Close image"]')!.click());
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(box()).toBeNull();
    expect(document.activeElement).toBe(thumb(2));

    await act(async () => thumb(1).click());
    expect(box()).not.toBeNull();
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(box()).toBeNull();
    expect(document.activeElement).toBe(thumb(1));
  });
});
