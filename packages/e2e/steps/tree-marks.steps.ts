import { expect, type Locator, type Page } from "@playwright/test";
import { When } from "./fixtures.ts";
import { endsWithPath } from "../support/css.ts";

const side = (page: Page) => page.getByTestId("side-panel");
const entry = (page: Page, rel: string): Locator => page.locator(`[data-testid="tree-entry"]${endsWithPath("data-path", rel)}`).first();

/** Desktop: a tab of the side panel. Phone: the Panes tab list. */
async function openPane(page: Page, name: RegExp): Promise<void> {
  const desktopTab = side(page).getByRole("tab", { name });
  const phoneTab = page.getByRole("tablist", { name: "Panes" }).getByRole("tab", { name });
  // After a reload the panel renders late: wait for either before choosing.
  await desktopTab.or(phoneTab).first().waitFor({ timeout: 15_000 });
  if (await desktopTab.isVisible()) return void (await desktopTab.click());
  await page.getByRole("tablist", { name: "Panes" }).getByRole("tab", { name }).click();
}

When("I open the Files tab of the side panel", async ({ page }) => {
  await openPane(page, /^files/i);
  await expect(page.getByTestId("files-panel")).toBeVisible();
  // Narrow layouts keep the tree in a drawer.
  if (!(await page.getByTestId("file-tree").isVisible())) await page.getByTestId("toggle-tree").click();
  await expect(page.getByTestId("file-tree")).toBeVisible();
  await expect(page.getByTestId("tree-entry").first()).toBeVisible({ timeout: 30_000 });
});

When("I expand the tree folder {string}", async ({ page }, rel: string) => {
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const row = entry(page, parts.slice(0, i).join("/"));
    await expect(row).toBeVisible({ timeout: 30_000 });
    if ((await row.getAttribute("aria-expanded")) === "false") await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
  }
});
