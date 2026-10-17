import { waitConnected } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

When("I restart the daemon", async ({ daemon }) => {
  await daemon.restart();
});

Then("the app is connected", async ({ page }) => {
  await waitConnected(page);
});
