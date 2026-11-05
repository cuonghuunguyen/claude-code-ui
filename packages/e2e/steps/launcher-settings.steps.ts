import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { runDir, shortcutDir } from "../support/paths.ts";
import { Given, Then, When } from "./fixtures.ts";

const sw = (page: Page) => page.getByTestId("settings-launcher-shortcut");
const entry = () => join(shortcutDir(runDir()), { darwin: "Claude UI.app", win32: "Claude UI.lnk" }[process.platform as string] ?? "claude-ui.desktop");

When("I open Settings › Launcher", async ({ page }) => {
  // A phone shows the sidebar, and its Settings button, in a drawer.
  const drawer = page.getByTestId("open-drawer");
  if (await drawer.isVisible()) await drawer.click();
  await page.getByTestId("open-settings").last().click();
  await page.getByTestId("settings-group-launcher").click();
  await expect(page.getByTestId("settings-launcher")).toBeVisible();
});

Then("the launcher shortcut switch is {word}", async ({ page }, state: string) => {
  await expect(sw(page)).toHaveAttribute("aria-checked", state === "on" ? "true" : "false");
});

When("I turn the launcher shortcut switch {word}", async ({ page }, state: string) => {
  const want = state === "on" ? "true" : "false";
  if ((await sw(page).getAttribute("aria-checked")) !== want) await sw(page).click();
  await expect(sw(page)).toHaveAttribute("aria-checked", want);
});

Then("the launcher shortcut entry exists", async () => {
  await expect.poll(() => existsSync(entry())).toBe(true);
  // The macOS app is only an entry when its executable is in it.
  if (process.platform === "darwin") expect(existsSync(join(entry(), "Contents/MacOS/claude-ui"))).toBe(true);
});

Then("the launcher shortcut entry is gone", async () => {
  await expect.poll(() => existsSync(entry())).toBe(false);
});

When("I set the Launcher port to {int}", async ({ page }, port: number) => {
  const input = page.getByTestId("settings-launcher-port");
  await input.fill(String(port));
  await input.press("Enter");
  await expect(input).toHaveValue(String(port));
});

When("I turn the Launcher {string} switch {word}", async ({ page }, label: string, state: string) => {
  const s = page.getByTestId("settings-launcher").getByRole("switch", { name: label });
  const want = state === "on" ? "true" : "false";
  if ((await s.getAttribute("aria-checked")) !== want) await s.click();
  await expect(s).toHaveAttribute("aria-checked", want);
});

Then("the Launcher URL says {string}", async ({ page }, url: string) => {
  await expect(page.getByTestId("settings-launcher-url")).toContainText(url);
});

Then("the permission mode picker offers {string}", async ({ page }, label: string) => {
  const settings = page.getByTestId("session-settings");
  const phone = await settings.isVisible();
  if (phone) await settings.click();
  await page.getByTestId("mode-select").click();
  await expect(page.getByRole("option", { name: label })).toBeVisible();
  await page.keyboard.press("Escape");
  if (phone) await page.keyboard.press("Escape");
});

Then("the launcher shortcut row is below the back button", async ({ page }) => {
  const back = await page.getByTestId("settings-back").boundingBox();
  const row = await page.getByTestId("settings-launcher-shortcut").boundingBox();
  const heading = await page.getByRole("heading", { name: "Launcher", exact: true }).boundingBox();
  const shortcutRow = await page.locator("#settings-launcher-shortcut-hint").boundingBox();
  expect(row!.y).toBeGreaterThanOrEqual(back!.y + back!.height - 1);
  // The section heading starts below the last line of the shortcut hint.
  expect(heading!.y).toBeGreaterThanOrEqual(shortcutRow!.y + shortcutRow!.height - 1);
});

// The file the guard reads: Info.plist inside the macOS bundle, else the entry itself.
const foreignFile = () => (process.platform === "darwin" ? join(entry(), "Contents/Info.plist") : entry());
const FOREIGN = "the user's own file";

Given("a foreign file sits at the launcher shortcut path", async () => {
  mkdirSync(join(foreignFile(), ".."), { recursive: true });
  writeFileSync(foreignFile(), FOREIGN);
});

When("I click the launcher shortcut switch", async ({ page }) => {
  await sw(page).click();
});

Then("the foreign launcher shortcut file is untouched", async () => {
  expect(readFileSync(foreignFile(), "utf8")).toBe(FOREIGN);
});

When("I remove the foreign launcher shortcut file", async () => {
  rmSync(entry(), { recursive: true, force: true });
});
