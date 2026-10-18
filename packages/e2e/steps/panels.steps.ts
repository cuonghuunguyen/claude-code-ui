import { expect, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

const side = (page: Page) => page.getByTestId("side-panel");
const bottom = (page: Page) => page.getByTestId("bottom-panel");
const shells = (page: Page) => page.getByTestId("terminal-tab");

// terminal.create requests the page sends, counted from the websocket frames (structure, not wording).
export async function watchTerminalCreates(page: Page): Promise<() => number> {
  let n = 0;
  page.on("websocket", (ws) =>
    ws.on("framesent", (f) => {
      if (typeof f.payload === "string" && f.payload.includes('"terminal.create"')) n++;
    }),
  );
  return () => n;
}

/** Selected pane tab names and boxes of both panels, plus the number of shells: what "nothing jumps" compares. */
async function layoutOf(page: Page) {
  const box = async (id: string) => {
    const b = await page.getByTestId(id).boundingBox();
    return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null;
  };
  const selected = async (id: string) => page.getByTestId(id).locator('[role="tab"][aria-selected="true"]').allInnerTexts();
  return {
    side: await box("side-panel"),
    bottom: await box("bottom-panel"),
    sideSelected: await selected("side-panel"),
    bottomSelected: await selected("bottom-panel"),
    shells: await shells(page).count(),
  };
}

When("I toggle the terminal from the titlebar", async ({ page }) => {
  await page.getByTestId("terminal-toggle-titlebar").click();
});

Then("the side panel shows", async ({ page }) => {
  await expect(side(page)).toBeVisible();
});

Then("a terminal shows in the bottom panel", async ({ page }) => {
  await expect(bottom(page)).toBeVisible();
  await expect(bottom(page).getByTestId("terminal-panel")).toBeVisible();
  await expect(shells(page)).toHaveCount(1);
});

Then("the bottom panel is hidden", async ({ page }) => {
  await expect(bottom(page)).toBeHidden();
});

Then("no shell is open", async ({ page }) => {
  await expect(shells(page)).toHaveCount(0);
});

Then("no side or bottom panel shows", async ({ page }) => {
  await expect(side(page)).toBeHidden();
  await expect(bottom(page)).toBeHidden();
  await expect(page.getByTestId("terminal-toggle-titlebar")).toBeHidden();
  await expect(page.getByTestId("panel-toggle")).toBeHidden();
});

Then("the Changes tab shows its empty state", async ({ page }) => {
  await side(page).getByRole("tab", { name: /^changes/i }).click();
  await expect(side(page).getByTestId("changes-empty")).toBeVisible();
});

When("I note the panel layout", async ({ page, memo }) => {
  memo.layout = await layoutOf(page);
});

Then("the panel layout is unchanged", async ({ page, memo }) => {
  expect(memo.layout, "a layout was noted").toBeDefined();
  expect(await layoutOf(page)).toEqual(memo.layout);
});

When("I remember to count terminal requests", async ({ page, memo }) => {
  const count = await watchTerminalCreates(page);
  (memo as Record<string, unknown>).creates = count;
});

Then("the page sent no terminal request since the reload", async ({ memo }) => {
  const count = (memo as Record<string, unknown>).creates as () => number;
  expect(count()).toBe(0);
});

Then("the page sent one terminal request", async ({ memo }) => {
  const count = (memo as Record<string, unknown>).creates as () => number;
  expect(count()).toBe(1);
});
