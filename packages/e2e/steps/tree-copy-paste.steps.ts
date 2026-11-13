import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";
import { endsWithPath } from "../support/css.ts";

const row = (page: Page, rel: string): Locator => page.locator(`[data-testid="tree-entry"]${endsWithPath("data-path", rel)}`).first();
const clash = (page: Page) => page.getByTestId("paste-clash-dialog");
const drop = (page: Page) => page.getByTestId("tree-drop-dialog");

When("I press {string} on the tree row {string}", async ({ page }, keys: string, rel: string) => {
  await row(page, rel).focus();
  await page.keyboard.press(keys);
});

Then("the tree lists the row {string}", async ({ page }, rel: string) => {
  await expect(row(page, rel)).toBeVisible({ timeout: 30_000 });
});

// Exact: "other/moveme" must not count as "moveme".
Then("the tree lists no row {string}", async ({ page, project }, rel: string) => {
  const tail = `/${project.name}/${rel}`;
  await expect
    .poll(() => page.locator('[data-testid="tree-entry"]').evaluateAll((els, t) => els.filter((e) => (e as HTMLElement).dataset.path?.replaceAll("\\", "/").endsWith(t)).length, tail), { timeout: 30_000 })
    .toBe(0);
});

Then("the project has {string} on disk with the text {string}", async ({ project }, rel: string, text: string) => {
  await expect.poll(() => (existsSync(join(project.path, rel)) ? readFileSync(join(project.path, rel), "utf8") : undefined), { timeout: 30_000 }).toBe(text);
});

Then("the project has no {string} on disk", async ({ project }, rel: string) => {
  await expect.poll(() => existsSync(join(project.path, rel)), { timeout: 30_000 }).toBe(false);
});

Then("the paste clash dialog is shown", async ({ page }) => {
  await expect(clash(page)).toBeVisible();
});

When("I answer the paste clash with {string}", async ({ page }, label: string) => {
  await clash(page).getByRole("button", { name: label, exact: true }).click();
  await expect(clash(page)).toBeHidden();
});

Then("the tree error line says {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("tree-op-error")).toContainText(text);
});

/** A DataTransfer built in the page: it has the shape the OS gives (Files). */
const MAKE_DT = (names: string[]) => {
  const d = new DataTransfer();
  for (const n of names) d.items.add(new File([`content of ${n}`], n, { type: "text/plain" }));
  return d;
};

When("I drop the OS files {string} on the tree row {string}", async ({ page }, names: string, rel: string) => {
  const list = names.split(",").map((n) => n.trim());
  await row(page, rel).evaluate(
    (el, { list, make }) => {
      const d = new Function(`return (${make})`)()(list) as DataTransfer;
      for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: d }));
    },
    { list, make: MAKE_DT.toString() },
  );
});

When("I paste the OS file {string} on the tree row {string}", async ({ page }, name: string, rel: string) => {
  await row(page, rel).evaluate(
    (el, { list, make }) => {
      const d = new Function(`return (${make})`)()(list) as DataTransfer;
      (el as HTMLElement).focus();
      el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: d }));
    },
    { list: [name], make: MAKE_DT.toString() },
  );
});

When("I drag the tree row {string} onto the tree row {string}", async ({ page }, from: string, to: string) => {
  await row(page, from).dragTo(row(page, to));
});

Then("the drop confirm dialog says {string}", async ({ page }, text: string) => {
  await expect(drop(page)).toContainText(text);
});

When("I confirm the drop", async ({ page }) => {
  await page.getByTestId("tree-drop-confirm").click();
  await expect(drop(page)).toBeHidden();
});

Then("no drop confirm dialog is shown", async ({ page }) => {
  await expect(drop(page)).toHaveCount(0);
});

When("I start dragging the tree row {string} over the session area edge", async ({ page }, rel: string) => {
  const b = (await page.getByTestId("session-area").boundingBox())!;
  await row(page, rel).hover();
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.85, b.y + b.height / 2, { steps: 10 });
  await page.mouse.move(b.x + b.width * 0.85 + 2, b.y + b.height / 2, { steps: 2 });
});

Then("no drop overlay is shown", async ({ page }) => {
  await expect(page.getByTestId("split-drop")).toHaveCount(0);
});

When("I drag the tree row {string} onto the prompt box", async ({ page }, rel: string) => {
  const b = (await page.getByRole("combobox", { name: /^(First prompt|Prompt)$/ }).boundingBox())!;
  await row(page, rel).hover();
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2, { steps: 2 });
  await page.mouse.up();
});

Then("no attachment is shown", async ({ page }) => {
  await page.waitForTimeout(500);
  await expect(page.getByTestId("attachment")).toHaveCount(0);
});

/** macOS only: puts a real folder on the OS clipboard, as Finder's Copy does. */
When("the system clipboard holds the project folder {string}", async ({ project }, rel: string) => {
  if (process.platform !== "darwin") throw new Error("needs macOS (osascript)");
  execFileSync("osascript", ["-e", `set the clipboard to (POSIX file "${join(project.path, rel)}")`]);
});

When("I open the tree menu of {string}", async ({ page }, rel: string) => {
  await row(page, rel).click({ button: "right" });
  await expect(page.getByTestId("tree-menu")).toBeVisible();
});

Then("the tree menu items {string} are visible", async ({ page }, names: string) => {
  for (const n of names.split(",").map((s) => s.trim())) {
    const item = page.getByRole("menuitem", { name: n, exact: true });
    await item.scrollIntoViewIfNeeded();
    await expect(item).toBeVisible();
  }
});

When("the system clipboard holds the project file {string}", async ({ project }, rel: string) => {
  if (process.platform !== "darwin") throw new Error("needs macOS (osascript)");
  execFileSync("osascript", ["-e", `set the clipboard to (POSIX file "${join(project.path, rel)}")`]);
});
