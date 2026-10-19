import { expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir, runDir, slug, testSlugs } from "../support/paths.ts";
import { Then, When } from "./fixtures.ts";

When("I switch to the {word} theme", async ({ page }, theme: string) => {
  const toggle = page.getByTestId("theme-toggle");
  for (let i = 0; i < 3 && !(await toggle.getAttribute("aria-label"))?.startsWith(`Theme: ${theme}`); i++) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", new RegExp(`^Theme: ${theme}`));
  await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^((?!\bdark\b).)*$/);
});

Then("the side panel terminal toggle is pressed", async ({ page }) => {
  await expect(page.getByTestId("terminal-toggle")).toHaveAttribute("aria-pressed", "true");
});

const style = (el: Element) => {
  const s = getComputedStyle(el);
  return { bg: s.backgroundColor, shadow: s.boxShadow };
};

Then("the side panel terminal toggle is quiet like the titlebar one", async ({ page }) => {
  await page.mouse.move(700, 450); // off the titlebar toggle just clicked, so no hover tint
  const panel = await page.getByTestId("terminal-toggle").evaluate(style);
  const title = await page.getByTestId("terminal-toggle-titlebar").evaluate(style);
  expect(panel.bg, "transparent background").toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
  // Tailwind's ring/shadow stack stays in the computed value with transparent colors: no visible shadow means only those.
  const visible = (v: string) => v !== "none" && v.replace(/rgba\(0, 0, 0, 0\)/g, "").replace(/[\s,0px]/g, "") !== "";
  expect(visible(panel.shadow), `no visible shadow: ${panel.shadow}`).toBe(false);
  expect(visible(title.shadow), "titlebar toggle is the reference").toBe(false);
});

Then("I capture the side panel header as {string}", async ({ page, evidence, $testInfo }, name: string) => {
  const dir = evidenceDir(runDir());
  mkdirSync(dir, { recursive: true });
  const { feature, scenario } = testSlugs($testInfo);
  const nn = String(evidence.next()).padStart(2, "0");
  const file = join(dir, `${feature}--${scenario}--${nn}-${slug(name, 30)}--1440x900.png`);
  const box = (await page.getByTestId("side-panel").boundingBox())!;
  await page.screenshot({ path: file, clip: { x: box.x, y: box.y, width: box.width, height: 80 } });
  await $testInfo.attach(name, { path: file, contentType: "image/png" });
});
