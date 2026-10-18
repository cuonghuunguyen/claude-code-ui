import { expect } from "@playwright/test";
import { RECONNECT_MS, waitConnected } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

When("I restart the daemon", async ({ daemon, page }) => {
  // The app must notice the loss, not just still show the old state: watch for it while the daemon is down.
  const status = page.getByTestId("connection-status").first();
  const lost = expect(status).not.toHaveText(/^\s*connected\s*$/, { timeout: RECONNECT_MS });
  await daemon.restart();
  await lost;
});

Then("the app is connected", async ({ page }) => {
  await waitConnected(page);
});
