// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AddonInfo } from "@claude-ui/protocol";
import { AddonsContext } from "./addons.ts";
import { Backdrop } from "./backdrop.tsx";
import { applyAddonThemes, applyColorTheme, applyTheme } from "./theme.ts";
import { addonThemes, themeCss } from "./themes.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const root = document.documentElement;
const palette = Object.fromEntries(["bg", "card", "side", "fg", "muted", "border", "primary", "pfg", "kw", "str", "fn", "type", "num", "cmt", "varc", "err", "warn", "ok", "info"].map((k) => [k, "#101010"]));
const BASE = `/addon/${"a".repeat(32)}/acme/`;
const addon = (present: Record<string, boolean>, bg: object = { dark: { image: "bg-dark", mobile: "bg-phone" }, veil: 0.35, panelAlpha: 0.6 }): AddonInfo =>
  ({
    name: "acme",
    source: { kind: "local", path: "/x" },
    approved: [],
    state: "enabled",
    base: BASE,
    assets: Object.fromEntries(Object.entries(present).map(([k, p]) => [k, { present: p }])),
    manifest: {
      name: "acme", version: "1", description: "", capabilities: [], views: [], commands: [], renderers: [],
      assets: { "bg-dark": { path: "art/dark one.png" }, "bg-phone": { path: "art/phone.webp" }, "bg-light": { path: "art/light.jpg" } },
      themes: [{ id: "void", name: "Void", dark: palette, light: palette, background: bg }],
    },
  }) as AddonInfo;

let host: HTMLDivElement;
let r: Root;
const show = async (a: AddonInfo) => {
  applyAddonThemes(addonThemes([a]));
  await act(async () => r.render(<AddonsContext value={{ addons: [a], picks: {} }}><Backdrop /></AddonsContext>));
};
beforeEach(() => {
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
  host = document.createElement("div");
  document.body.append(host);
  r = createRoot(host);
  root.classList.add("dark");
  applyColorTheme("addon:acme:void");
});
afterEach(async () => {
  await act(async () => r.unmount());
  host.remove();
  root.classList.remove("dark");
  root.removeAttribute("data-theme");
  applyAddonThemes([]);
});

it("shows the backdrop and data-backdrop only while the asset file of the current mode exists", async () => {
  await show(addon({ "bg-dark": true, "bg-phone": false }));
  expect(host.querySelector('[data-part="backdrop"]')).not.toBeNull();
  expect(root.hasAttribute("data-backdrop")).toBe(true);
  // The file of the dark image is gone (list read again): the theme still applies, no background.
  await show(addon({ "bg-dark": false, "bg-phone": true }));
  expect(host.querySelector('[data-part="backdrop"]')).toBeNull();
  expect(root.hasAttribute("data-backdrop")).toBe(false);
  expect(document.getElementById("claude-ui-addon-themes")!.textContent).toContain('[data-theme="addon:acme:void"].dark');
  expect(document.getElementById("claude-ui-addon-themes")!.textContent).not.toContain("--backdrop-image");
});

it("a mode without an image has no backdrop (light has none here)", async () => {
  root.classList.remove("dark");
  await show(addon({ "bg-dark": true }));
  expect(host.querySelector('[data-part="backdrop"]')).toBeNull();
});

it("the theme rule carries the image (encoded same-origin URL), the mobile image, the veil and the panel alpha", async () => {
  await show(addon({ "bg-dark": true, "bg-phone": true }));
  const css = themeCss(addonThemes([addon({ "bg-dark": true, "bg-phone": true })]));
  expect(css).toContain(`--backdrop-image: url("${BASE}art/dark%20one.png");`);
  expect(css).toContain(`--backdrop-image-mobile: url("${BASE}art/phone.webp");`);
  expect(css).toContain("--backdrop-veil: 0.35;");
  expect(css).toContain("--panel-alpha: 0.6;");
});

it("a Dev mode addon (rev is a millisecond timestamp) keeps its background: the URL gets ?v=<rev>", () => {
  const a = { ...addon({ "bg-dark": true }, { dark: { image: "bg-dark" } }), dev: true, rev: 1790000000000 };
  expect(themeCss(addonThemes([a]))).toContain(`url("${BASE}art/dark%20one.png?v=1790000000000")`);
});

it("a tampered veil, panel alpha or file path never reaches the style text", () => {
  const a = addon({ "bg-dark": true }, { dark: { image: "bg-dark" }, veil: "1;}body{display:none" as never, panelAlpha: 7 });
  a.manifest!.assets!["bg-dark"]!.path = 'x");}*{display:none}/*.png';
  const css = themeCss(addonThemes([a]));
  expect(css).not.toContain("display:none");
  expect(css).toContain("x%22%29%3B%7D%2A%7Bdisplay%3Anone%7D"); // the path is percent-encoded, so it cannot leave url("...")
  expect(css).not.toContain("--backdrop-veil");
  expect(css).not.toContain("--panel-alpha");
});

it("system dark mode switch follows: backdrop appears when the dark image exists", async () => {
  root.classList.remove("dark");
  await show(addon({ "bg-dark": true }));
  expect(host.querySelector('[data-part="backdrop"]')).toBeNull();
  applyTheme("dark");
  await act(async () => {});
  expect(host.querySelector('[data-part="backdrop"]')).not.toBeNull();
});
