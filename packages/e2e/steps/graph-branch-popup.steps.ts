
import { When } from "./fixtures.ts";

When("I press {string} in the branch popup", async ({ page }, key: string) => {
  // A pointer left over a row re-opens that row's actions pane after Escape closes it; keep the keys the only input.
  await page.mouse.move(0, 0);
  await page.keyboard.press(key);
});
