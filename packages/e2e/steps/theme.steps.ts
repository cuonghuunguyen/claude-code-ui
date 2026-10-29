import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { Given, Then, When } from "./fixtures.ts";

// GH-468 theme picker. Written, not run (release rule): selectors for the diff and the terminal are unverified against a live page.
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const token = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

async function openSettings(page: Page): Promise<void> {
  const drawer = page.getByTestId("open-drawer");
  if (await drawer.isVisible()) await drawer.click();
  await page.locator('[data-testid="open-settings"]:visible').first().click();
}

/** Titlebar (or drawer) theme button cycles System, Light, Dark: click until its label names the mode. */
async function setMode(page: Page, mode: string): Promise<void> {
  const drawer = page.getByTestId("open-drawer");
  const button = (await drawer.isVisible()) ? page.getByTestId("drawer-theme") : page.getByTestId("theme-toggle");
  for (let i = 0; i < 3 && !(await button.getAttribute("aria-label"))?.startsWith(`Theme: ${mode} `); i++) await button.click();
  await expect(button).toHaveAttribute("aria-label", new RegExp(`^Theme: ${mode} `));
}

When("I open Settings › Appearance", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("settings-group-appearance").click();
  await expect(page.getByTestId("settings-appearance")).toBeVisible();
});

async function chooseTheme(page: Page, name: string): Promise<void> {
  if (!(await page.getByTestId("settings-appearance").isVisible())) {
    await openSettings(page);
    await page.getByTestId("settings-group-appearance").click();
  }
  await page.getByTestId("settings-theme").click();
  await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByTestId("settings-theme")).toContainText(name);
}

When("I choose the theme {string}", async ({ page }, name: string) => chooseTheme(page, name));

Given("the mode is {string}", async ({ page }, mode: string) => setMode(page, mode));
When("I set the mode to {string}", async ({ page }, mode: string) => setMode(page, mode));

Given("the theme is {string} and the mode is {string}", async ({ page }, name: string, mode: string) => {
  await chooseTheme(page, name);
  await page.keyboard.press("Escape");
  await setMode(page, mode);
});

Then("the theme list is {string}", async ({ page }, names: string) => {
  await page.getByTestId("settings-theme").click();
  const got = (await page.getByRole("option").allTextContents()).map((t) => t.replace(/dark only$/, ""));
  expect(got).toEqual(names.split(", "));
  await page.keyboard.press("Escape");
});

Then("the theme {string} is marked dark only", async ({ page }, name: string) => {
  await page.getByTestId("settings-theme").click();
  await expect(page.getByRole("option", { name: new RegExp(`^${name}`) })).toContainText("dark only");
  await page.keyboard.press("Escape");
});

Then("the app card colour is {string}", async ({ page }, hex: string) => {
  await expect.poll(() => token(page, "--card")).toBe(hex);
});

Then("the terminal background is {string}", async ({ page }, hex: string) => {
  await expect.poll(() => page.locator(".xterm-viewport").first().evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(rgb(hex));
});

Then("the diff background is the app card colour", async ({ page }) => {
  const card = rgb(await token(page, "--card"));
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.querySelector("diffs-container")!.shadowRoot!.querySelector("pre")!).backgroundColor))
    .toBe(card);
});

Then("the Graph ref chip uses the theme colour", async ({ page }) => {
  const local = rgb(await token(page, "--ref-local"));
  await expect.poll(() => page.locator('[data-ref^="refs/heads/"]').first().evaluate((e) => getComputedStyle(e).color)).toBe(local);
});

Then("the page did not navigate", async ({ page }) => {
  // The pick must not reload: a marker set on the window survives.
  expect(await page.evaluate(() => (window as unknown as { __themeMarker?: boolean }).__themeMarker)).toBe(true);
});
When("I mark the page", async ({ page }) => void (await page.evaluate(() => ((window as unknown as { __themeMarker?: boolean }).__themeMarker = true))));

When("the system colour scheme is {string}", async ({ page }, scheme: "light" | "dark") => {
  await page.emulateMedia({ colorScheme: scheme });
});

Then("the Dracula light warning shows", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("settings-group-appearance").click();
  await expect(page.getByTestId("settings-theme-dracula-warning")).toHaveText("Dracula has no light colors: light mode shows Default.");
  await page.keyboard.press("Escape");
});

Then("the Dracula light warning is gone", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("settings-group-appearance").click();
  await expect(page.getByTestId("settings-theme-dracula-warning")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

Then("data-theme was {string} before the app rendered", async ({ page }, id: string) => {
  expect(await page.evaluate(() => (window as unknown as { __themeAtStart?: string | null }).__themeAtStart)).toBe(id);
});

When("I record the theme before the app renders", async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => ((window as unknown as { __themeAtStart?: string | null }).__themeAtStart = document.documentElement.dataset.theme ?? null));
  });
});

Then("the theme select is at least 44px high", async ({ page }) => {
  const box = await page.getByTestId("settings-theme").boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

Then("the Settings dialog has a 1px border and the floating shadow", async ({ page }) => {
  await openSettings(page);
  const dialog = page.getByRole("dialog").first();
  const s = await dialog.evaluate((e) => { const c = getComputedStyle(e); return { width: c.borderTopWidth, shadow: c.boxShadow }; });
  expect(s.width).toBe("1px");
  expect(s.shadow).toContain("40px");
});

Then("the session pane has a 1px border", async ({ page }) => {
  await page.keyboard.press("Escape");
  const w = await page.getByTestId("pane-session").evaluate((e) => getComputedStyle(e).borderTopWidth);
  expect(w).toBe("1px");
});

When("I open Settings", async ({ page }) => openSettings(page));

Given("the scratch project has an uncommitted change", async ({ project }) => {
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...a], { cwd: project.path });
  writeFileSync(join(project.path, "theme.txt"), "one\n");
  git("add", "theme.txt");
  git("commit", "-m", "add theme.txt");
  writeFileSync(join(project.path, "theme.txt"), "two\n");
});
