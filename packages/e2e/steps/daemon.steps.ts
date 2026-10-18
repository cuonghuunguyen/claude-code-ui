import { expect } from "@playwright/test";
import { RECONNECT_MS, waitConnected } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

When("I restart the daemon", async ({ daemon, page }) => {
  // The app must notice the loss, not just still show the old state: watch for it while the daemon is down.
  const status = page.getByTestId("connection-status").first();
  const lost = expect(status).not.toHaveText(/^\s*connected\s*$/, { timeout: RECONNECT_MS });
  // Both settle before either rejection is reported: a failed restart must not leave `lost` as an unhandled rejection.
  const [restarted, seen] = await Promise.allSettled([daemon.restart(), lost]);
  if (restarted.status === "rejected") throw restarted.reason;
  if (seen.status === "rejected") throw seen.reason;
});

Then("the app is connected", async ({ page }) => {
  await waitConnected(page);
});
