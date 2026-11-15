
import { expect, type Locator, type Page } from "@playwright/test";
import { Then } from "./fixtures.ts";

const files = (page: Page): Locator => page.getByTestId("files-panel");

Then("the Files editor shows the line {string}", async ({ page }, text: string) => {
  await expect(files(page).getByText(text)).toBeVisible();
});
