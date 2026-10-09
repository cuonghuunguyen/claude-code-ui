import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = (name: string) => join(root, "public", name.replace(/^\//, ""));
const read = (name: string) => readFileSync(pub(name), "utf8");
const pngSize = (name: string) => {
  const b = readFileSync(pub(name));
  expect(b.subarray(1, 4).toString("ascii"), `${name} is a PNG`).toBe("PNG");
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
};

type Icon = { src: string; sizes: string; type: string; purpose?: string };
const manifest = JSON.parse(read("manifest.webmanifest")) as Record<string, unknown> & { icons: Icon[] };

describe("web app manifest", () => {
  it("pins identity and scope and starts standalone", () => {
    expect(manifest).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone" });
    expect(manifest.name).toBe("Claude UI");
  });

  it("matches the page's theme color", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    const theme = /<meta name="theme-color" content="([^"]+)"/.exec(html)?.[1];
    expect(manifest.theme_color).toBe(theme);
    expect(manifest.background_color).toBe(theme);
  });

  it("has PNG icons of 192 and 512 for purpose any and a maskable one", () => {
    const has = (purpose: string, sizes: string) => manifest.icons.some((i) => i.type === "image/png" && i.sizes === sizes && (i.purpose ?? "any") === purpose);
    expect(has("any", "192x192")).toBe(true);
    expect(has("any", "512x512")).toBe(true);
    expect(has("maskable", "512x512")).toBe(true);
  });

  it("lists only icons that exist, and PNGs of the size they claim", () => {
    for (const icon of manifest.icons) {
      expect(existsSync(pub(icon.src)), icon.src).toBe(true);
      if (icon.type === "image/png") expect(pngSize(icon.src), icon.src).toBe(icon.sizes);
    }
  });
});

describe("page head", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");

  it("has a 180x180 apple-touch-icon and the iOS standalone meta tags", () => {
    const href = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(html)?.[1];
    expect(href).toBeDefined();
    expect(pngSize(href!)).toBe("180x180");
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="Claude UI"');
  });

  it("links a PNG favicon next to the SVG one", () => {
    expect(pngSize(/<link rel="icon" href="([^"]+\.png)"/.exec(html)![1]!)).toBe("32x32");
  });
});

describe("service worker notifications", () => {
  it("use a PNG icon and a monochrome badge that exist", () => {
    const sw = read("sw.js");
    const icon = /icon: "([^"]+)"/.exec(sw)![1]!;
    const badge = /badge: "([^"]+)"/.exec(sw)![1]!;
    expect(icon).toMatch(/\.png$/);
    expect(pngSize(icon)).toBe("192x192");
    expect(pngSize(badge)).toBe("96x96");
  });

  it("has no fetch handler (installable without an offline cache)", () => {
    expect(read("sw.js")).not.toMatch(/addEventListener\("fetch"/);
  });
});
