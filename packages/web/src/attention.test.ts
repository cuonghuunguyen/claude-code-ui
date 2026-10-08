// @vitest-environment jsdom
import { expect, it } from "vitest";
import { announcement, faviconHref, setFavicon } from "./attention.ts";
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
