
import { When } from "./fixtures.ts";

When("I open the tab switcher", async ({ page }) => {
  await page.getByTestId("tab-switcher").click();
});
