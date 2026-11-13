import { expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { Given, Then, When } from "./fixtures.ts";
import { cssStr } from "../support/css.ts";

// GH-515: names and icons of projects and machines.
const row = (page: Page, path: string) => page.locator(`[data-testid="group-toggle"][title="${cssStr(path)}"]`).locator("xpath=ancestor::h3");
const second = new WeakMap<Page, Page>();
const dialog = (page: Page) => page.getByTestId("label-dialog");

When("I open the name and icon dialog of the scratch project", async ({ page, project }) => {
  const phone = await page.getByTestId("open-drawer").isVisible();
  if (phone) {
    // The phone's sidebar is a drawer (Open project ends in a new-session tab that closes it); the kebab opens the same entries.
    await expect(page.getByTestId("new-session-tab")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("open-drawer").click();
    const r = row(page, project.path);
    await r.getByTestId("project-menu").scrollIntoViewIfNeeded({ timeout: 60_000 });
    await r.getByTestId("project-menu").click();
    await page.getByTestId("project-menu-rename").click();
  } else {
    await row(page, project.path).getByTestId("group-toggle").click({ button: "right", timeout: 60_000 });
    await page.getByTestId("group-menu-rename").click();
  }
  await expect(dialog(page)).toBeVisible();
});

When("I set the label name to {string}", async ({ page }, name: string) => {
  await page.getByTestId("label-name").fill(name);
});

When("I choose the emoji icon {string}", async ({ page }, emoji: string) => {
  await page.getByTestId("label-icon-emoji").click();
  await page.getByTestId("label-emoji").fill(emoji);
});

When("I save the label", async ({ page }) => {
  await page.getByTestId("label-save").click();
  await expect(dialog(page)).toBeHidden();
});

When("I reset the label", async ({ page }) => {
  await page.getByTestId("label-reset").click();
  await expect(dialog(page)).toBeHidden();
});

When("I open the sidebar drawer", async ({ page }) => {
  await expect(page.getByTestId("open-drawer")).toBeVisible();
  await page.getByTestId("open-drawer").click();
});

When("I choose the image icon {string}", async ({ page }, file: string) => {
  await page.getByTestId("label-icon-image").click();
  await page.getByTestId("label-file").setInputFiles(join(import.meta.dirname, "..", "fixtures", file));
  await expect(page.getByTestId("label-crop")).toBeVisible();
});

When("I choose the image icon from a text file", async ({ page }) => {
  await page.getByTestId("label-icon-image").click();
  await page.getByTestId("label-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") });
});

When("I zoom and move the crop", async ({ page }) => {
  await page.getByTestId("label-zoom").fill("2");
  const box = (await page.getByTestId("label-crop").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2 + 10, { steps: 5 });
  await page.mouse.up();
});

When("I filter the sidebar by {string}", async ({ page }, text: string) => {
  await page.getByTestId("session-search").fill(text);
});

When("I filter the sidebar by the folder name of the scratch project", async ({ page, project }) => {
  await page.getByTestId("session-search").fill(project.name);
});

Given("a second page is open on the same daemon", async ({ page, daemon }) => {
  const other = await page.context().newPage();
  await other.setViewportSize({ width: 1440, height: 900 });
  await other.addInitScript(() => {
    try {
      localStorage.setItem("claude-ui.guide", JSON.stringify({ v: 1, origin: "existing", basics: "offered", session: "offered" }));
    } catch {}
  });
  await other.goto(`${daemon.origin}/#token=${daemon.token}`);
  second.set(page, other);
});

Then("the sidebar shows the scratch project as {string}", async ({ page, project }, name: string) => {
  await expect(row(page, project.path).getByTestId("group-toggle")).toContainText(name);
});

Then("the sidebar shows the folder name of the scratch project", async ({ page, project }) => {
  await expect(row(page, project.path).getByTestId("group-toggle")).toContainText(project.name);
});

Then("the sidebar still lists the scratch project", async ({ page, project }) => {
  await expect(row(page, project.path)).toBeVisible();
});

Then("the sidebar avatar of the scratch project shows the emoji {string}", async ({ page, project }, emoji: string) => {
  await expect(row(page, project.path).getByTestId("label-glyph-emoji")).toHaveText(emoji);
});

Then("the sidebar avatar of the scratch project shows no icon", async ({ page, project }) => {
  await expect(row(page, project.path).locator('[data-testid^="label-glyph-"]')).toHaveCount(0);
});

Then("the sidebar avatar of the scratch project is a 64x64 image", async ({ page, project }) => {
  const img = row(page, project.path).getByTestId("label-glyph-img");
  await expect(img).toHaveAttribute("src", /^data:image\/(webp|png);base64,/);
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight])).toEqual([64, 64]);
});

Then("the label dialog shows an error", async ({ page }) => {
  await expect(page.getByTestId("label-error")).toBeVisible();
  await expect(page.getByTestId("label-error")).toHaveAttribute("role", "alert");
});

Then("the second page shows the scratch project as {string}", async ({ page, project }, name: string) => {
  await expect(row(second.get(page)!, project.path).getByTestId("group-toggle")).toContainText(name);
});

Then("Settings lists this machine", async ({ page }) => {
  await expect(page.getByTestId("settings-side-local")).toBeVisible();
});

When("I rename this machine to {string} with the emoji {string}", async ({ page }, name: string, emoji: string) => {
  await page.getByTestId("settings-side-edit-local").click();
  await page.getByTestId("label-name").fill(name);
  await page.getByTestId("label-icon-emoji").click();
  await page.getByTestId("label-emoji").fill(emoji);
  await page.getByTestId("label-save").click();
  await expect(dialog(page)).toBeHidden();
});

Then("Settings lists this machine as {string}", async ({ page }, name: string) => {
  await expect(page.getByTestId("settings-side-local").getByTestId("settings-side-name")).toHaveText(name);
});
