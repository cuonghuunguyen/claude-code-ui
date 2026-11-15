import { expect, type Page } from "@playwright/test";
import { Then } from "./fixtures.ts";

const graph = (page: Page) => page.getByTestId("graph-panel");

Then("the Graph result line says {string}", async ({ page }, text: string) => {
  await expect(graph(page).locator('[data-testid="graph-remote-result"] [role=status]')).toContainText(text, { timeout: 60_000 });
});
