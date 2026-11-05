// @vitest-environment jsdom
import { expect, it } from "vitest";
import { announcement, faviconHref, setAppleTouchIcon, setFavicon } from "./attention.ts";
import { tabTitle } from "./unread.ts";

it("the title carries the number of sessions that need input, none at 0", () => {
  expect([0, 1, 3].map(tabTitle)).toEqual(["Claude UI", "(1) Claude UI", "(3) Claude UI"]);
});

it("the favicon gets a marker with its own shape above 0 and is the plain icon at 0", () => {
  expect(faviconHref(0)).toBe("/icon.svg");
  const marked = decodeURIComponent(faviconHref(2).replace("data:image/svg+xml,", ""));
  expect(marked).toContain("<svg");
  // A diamond path (four straight sides), not only another color.
  expect(marked).toContain("M400 0l112 112-112 112-112-112z");
  expect(faviconHref(2)).toBe(faviconHref(5));
});

it("announces a full phrase, and nothing for a page that never had anything waiting", () => {
  expect(announcement(3, false)).toBe("3 sessions need input");
  expect(announcement(1, true)).toBe("1 session needs input");
  expect(announcement(0, true)).toBe("No session needs input");
  expect(announcement(0, false)).toBe("");
});

it("setFavicon changes the page icon link", () => {
  document.head.innerHTML = '<link rel="icon" href="/icon.svg" />';
  setFavicon(faviconHref(1));
  expect(document.querySelector("link[rel=icon]")!.getAttribute("href")).toMatch(/^data:image\/svg\+xml,/);
  setFavicon(faviconHref(0));
  expect(document.querySelector("link[rel=icon]")!.getAttribute("href")).toBe("/icon.svg");
});

const svgOf = (href: string) => decodeURIComponent(href.replace("data:image/svg+xml,", ""));
const WEBP = "data:image/webp;base64,UklGRg==";

it("a custom image is the favicon itself at 0 and sits under the diamond above 0", () => {
  expect(faviconHref(0, WEBP)).toBe(WEBP);
  const marked = svgOf(faviconHref(3, WEBP));
  expect(marked).toContain(`<image href="${WEBP}" width="512" height="512"/>`);
  expect(marked).toContain("M400 0l112 112-112 112-112-112z");
  expect(marked).not.toContain("#d97757");
});

it("a custom emoji is an SVG text, escaped, with the diamond above 0", () => {
  const plain = svgOf(faviconHref(0, "🚀"));
  expect(plain).toContain('<text x="256" y="256" font-size="400" text-anchor="middle" dominant-baseline="central">🚀</text>');
  expect(plain).not.toContain("M400 0");
  expect(svgOf(faviconHref(1, "🚀"))).toContain("M400 0l112 112-112 112-112-112z");
  const evil = svgOf(faviconHref(0, '<&">'));
  expect(evil).toContain(">&#60;&#38;&#34;&#62;</text>");
  expect(evil).not.toContain("<&");
});

it("an empty custom icon keeps the built-in favicon", () => {
  expect(faviconHref(0, "")).toBe("/icon.svg");
});

it("setAppleTouchIcon points at /app-icon for a custom icon and back at the built-in one", () => {
  document.head.innerHTML = '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />';
  setAppleTouchIcon("🚀");
  expect(document.querySelector("link[rel=apple-touch-icon]")!.getAttribute("href")).toBe("/app-icon");
  setAppleTouchIcon("");
  expect(document.querySelector("link[rel=apple-touch-icon]")!.getAttribute("href")).toBe("/apple-touch-icon.png");
});
