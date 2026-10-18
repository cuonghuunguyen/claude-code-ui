import { expect } from "@playwright/test";
import { Then } from "./fixtures.ts";

Then("the tab switcher is inside the titlebar and above the pane", async ({ page }) => {
  const box = async (id: string) => {
    const b = await page.getByTestId(id).first().boundingBox();
    expect(b, `${id} has a box`).not.toBeNull();
    return b!;
  };
  const [switcher, titlebar, pane] = [await box("tab-switcher"), await box("titlebar"), await box("pane-session")];
  expect(switcher.y).toBeGreaterThanOrEqual(titlebar.y - 0.5);
  expect(switcher.y + switcher.height).toBeLessThanOrEqual(titlebar.y + titlebar.height + 0.5);
  expect(switcher.y + switcher.height).toBeLessThanOrEqual(pane.y + 0.5);
});

Then("the page has no horizontal scroll", async ({ page }) => {
  const m = await page.evaluate(() => ({ inner: window.innerWidth, root: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(m.root).toBe(m.inner);
  expect(m.body).toBeLessThanOrEqual(m.inner);
});
