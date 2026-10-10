// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { ICON_BUTTON } from "./tabs-bar.tsx";

const css = readFileSync(resolve(process.cwd(), "packages/web/src/index.css"), "utf8");
const token = (block: string, name: string) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)![1]!;
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

it("pressed icon button draws the 2px foreground bar like expanded (not the fill alone)", () => {
  expect(ICON_BUTTON).toContain("aria-pressed:shadow-[inset_0_-2px_0_var(--foreground)]");
});

it("pressed bar (--foreground) is >= 3:1 against the header (--card) in both themes", () => {
  const dark = css.indexOf("--background: #080808");
  const light = css.slice(css.indexOf("--background: #fafafa"), dark);
  const darkBlock = css.slice(dark);
  for (const [name, block] of [["light", light], ["dark", darkBlock]] as const) {
    const r = ratio(token(block, "foreground"), token(block, "card"));
    console.log(`${name}: bar vs card ${r.toFixed(2)}:1, fill vs card ${ratio(token(block, "secondary"), token(block, "card")).toFixed(2)}:1`);
    expect(r).toBeGreaterThanOrEqual(3);
  }
});
