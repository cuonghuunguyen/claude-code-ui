
import { When } from "./fixtures.ts";

When("I toggle the terminal from the titlebar", async ({ page }) => {
  await page.getByTestId("terminal-toggle-titlebar").click();
});
