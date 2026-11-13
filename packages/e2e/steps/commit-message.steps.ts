import { expect } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

const box = (page: import("@playwright/test").Page) => page.getByTestId("commit-message");
const generate = (page: import("@playwright/test").Page) => page.getByTestId("commit-generate");

When("I click Generate in the commit box", async ({ page }) => {
  await expect(generate(page)).toHaveAttribute("aria-label", "Generate commit message");
  await generate(page).click();
});

// The box is read-only while Claude writes, so only a reply could change it; Stop is clicked at once.
When("I click Stop in the commit box", async ({ page }) => {
  await expect(generate(page)).toHaveAttribute("aria-label", "Stop generating");
  await generate(page).click();
});

Then("the commit message box holds a message from Claude", async ({ page }) => {
  await expect(generate(page)).toHaveAttribute("aria-label", "Generate commit message", { timeout: 90_000 });
  await expect(box(page)).not.toHaveValue("");
  expect((await box(page).inputValue()).split("\n")[0]!.trim()).not.toBe("");
});

Then("Commit is enabled", async ({ page }) => {
  await expect(page.getByTestId("commit-button")).toBeEnabled();
});

Then("no error shows in the commit box", async ({ page }) => {
  await expect(page.getByTestId("commit-box").locator('[role="alert"]')).toHaveCount(0);
});

Then("the commit message box holds exactly {string}", async ({ page }, text: string) => {
  await expect(box(page)).toHaveValue(text);
});

Then("Generate is available again", async ({ page }) => {
  await expect(generate(page)).toHaveAttribute("aria-label", "Generate commit message");
  await expect(generate(page)).toBeEnabled();
  await expect(box(page)).toBeEditable();
});

const area = (page: import("@playwright/test").Page, project: boolean) => page.getByTestId(project ? "settings-git-projectInstruction-input" : "settings-git-commitMessageInstruction-input");

When("I set the commit message instruction to {string}", async ({ page }, text: string) => {
  await area(page, false).fill(text);
  await area(page, false).blur();
});

When("I set the commit message instruction of the project to {string}", async ({ page }, text: string) => {
  await area(page, true).fill(text);
  await area(page, true).blur();
  // Saved: the daemon's value came back and re-keyed the box.
  await expect(area(page, true)).toHaveValue(text);
});

Then("the commit message instruction is {string}", async ({ page }, text: string) => {
  await expect(area(page, false)).toHaveValue(text);
});

Then("the commit message instruction of the project is {string}", async ({ page }, text: string) => {
  await expect(area(page, true)).toHaveValue(text);
});

Then("the Generate button is inside the viewport and 44 px high", async ({ page }) => {
  const b = await generate(page).boundingBox();
  expect(b).not.toBeNull();
  expect(b!.x).toBeGreaterThanOrEqual(0);
  expect(b!.x + b!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
  expect(b!.height).toBeGreaterThanOrEqual(44);
});

When("I switch {string} {word} in Settings Git", async ({ page }, _label: string, state: string) => {
  const sw = page.getByTestId("settings-git-commitMessageWarm");
  const want = state === "on" ? "true" : "false";
  if ((await sw.getAttribute("aria-checked")) !== want) await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", want);
});
