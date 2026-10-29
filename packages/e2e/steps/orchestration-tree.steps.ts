import { expect, type Locator, type Page } from "@playwright/test";
import { TURN_MS, toolCard as anyToolCard } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

const input = (page: Page, label: string): Locator => {
  const key = label === "Maximum tree depth" ? "maxDepth" : label === "Maximum workers per coordinator" ? "maxChildren" : label === "Maximum workers per tree" ? "workerCap" : label === "Maximum workers in total" ? "workerCapTotal" : "";
  if (!key) throw new Error(`unknown Orchestration setting "${label}"`);
  return page.getByTestId(`settings-orchestration-${key}`);
};

/** Worker rows of the sidebar by their displayed name; a phone shows the sidebar in a drawer. */
async function openSidebar(page: Page): Promise<void> {
  const list = page.getByRole("navigation", { name: "Sessions" });
  const drawer = page.getByTestId("open-drawer");
  // A closed phone drawer still counts as visible (it sits off screen): look at where the list is.
  const onScreen = async () => {
    const box = await list.boundingBox();
    return !!box && box.x + box.width > 1 && box.x < (page.viewportSize()?.width ?? 0) - 1;
  };
  if (!(await onScreen()) && (await drawer.isVisible())) await drawer.click();
  await expect.poll(onScreen).toBe(true);
}
// One daemon serves every scenario: only workers whose folder is in this scratch project (the row title holds the folder).
const row = (page: Page, project: string, name: string): Locator => page.locator(`[data-testid="session-item"][data-worker="${name}"][title*="${project}"]`);
async function revealWorkers(page: Page, project: string, name: string): Promise<void> {
  await openSidebar(page);
  if ((await row(page, project, name).count()) > 0) return;
  const toggles = page.getByTestId("worker-group-toggle");
  // Worker groups start collapsed: expand every toggle once.
  for (let i = 0; i < (await toggles.count()); i++) if ((await toggles.nth(i).getAttribute("aria-expanded")) !== "true") await toggles.nth(i).click();
}

When("I open Settings › Orchestration", async ({ page }) => {
  await page.locator('[data-testid="open-settings"]:visible').first().click();
  await page.getByTestId("settings-group-orchestration").click();
  await expect(page.getByTestId("settings-orchestration")).toBeVisible();
});

When("I type {string} into the Orchestration setting {string}", async ({ page }, text: string, label: string) => {
  const box = input(page, label);
  await box.fill("");
  await box.pressSequentially(text);
  await box.blur();
});

Then("the hint of the Orchestration setting {string} mentions {string}", async ({ page }, label: string, text: string) => {
  await expect(page.locator(`#${await input(page, label).getAttribute("id")}-hint`)).toContainText(text);
});

When("I set the Orchestration setting {string} to {int}", async ({ page }, label: string, value: number) => {
  const box = input(page, label);
  await box.fill(String(value));
  await box.blur();
  // A person needs longer than a millisecond for the next field; a refetch after the save clears a draft typed meanwhile.
  await page.waitForTimeout(400);
});

Then("the Orchestration setting {string} is {int}", async ({ page }, label: string, value: number) => {
  await expect(input(page, label)).toHaveValue(String(value));
});

Then("the Settings error mentions {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("banner-error")).toContainText(text);
});

Then("I see a permission request whose title contains {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("permission-panel")).toContainText(text, { timeout: TURN_MS });
});

Then("no permission request is shown", async ({ page }) => {
  await expect(page.getByTestId("permission-panel")).toHaveCount(0);
});

Then("the sidebar lists the worker {string}", async ({ page, project: { name: project } }, name: string) => {
  await expect(async () => {
    await revealWorkers(page, project, name);
    await expect(row(page, project, name)).toHaveCount(1);
    await expect(row(page, project, name)).toBeVisible();
  }).toPass({ timeout: 90_000 });
});

Then("the sidebar does not list the worker {string}", async ({ page, project: { name: project } }, name: string) => {
  await revealWorkers(page, project, name);
  await expect(row(page, project, name)).toHaveCount(0);
});

When("I open the worker {string}", async ({ page, project: { name: project } }, name: string) => {
  // The row re-renders while the worker runs: retry the click.
  await expect(async () => {
    await revealWorkers(page, project, name);
    await row(page, project, name).click({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
});

Then("the {string} tool card shows an error that names the depth limit", async ({ page }, text: string) => {
  const card = anyToolCard(page, text).filter({ hasNotText: "ToolSearch" }).first();
  const open = card.locator("button[aria-expanded='false']").first();
  if (await open.count()) await open.click();
  await expect(card).toContainText(/depth limit/i, { timeout: 15_000 });
});

When("I show the sidebar", async ({ page }) => {
  await openSidebar(page);
});
