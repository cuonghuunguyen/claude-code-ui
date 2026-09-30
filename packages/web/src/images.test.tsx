import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImageStrip } from "./images.tsx";

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
});
