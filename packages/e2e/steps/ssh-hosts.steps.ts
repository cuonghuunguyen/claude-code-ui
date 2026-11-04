// GH-547: see features/ssh-hosts.feature. Needs no docker: the ssh config is a file of the run folder.
import { expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDir, sshDir } from "../support/paths.ts";
import { Given, Then, When } from "./fixtures.ts";

Given("an ssh config with an Include and patterns", async ({ daemon }) => {
  void daemon; // the daemon of the worker reads CLAUDE_UI_SSH_CONFIG on every list
  const dir = sshDir(runDir());
  mkdirSync(join(dir, "conf.d"), { recursive: true });
  writeFileSync(
    join(dir, "config"),
    ["Host main-a", "  HostName 127.0.0.1", "Host *", "  LogLevel ERROR", "Host wild-* !neg-y", "  User x", `Include ${join(dir, "conf.d", "*.conf")}`, "Host inc-b", "  HostName 127.0.0.2", ""].join("\n"),
  );
  writeFileSync(join(dir, "conf.d", "a.conf"), ["Host inc-b inc-c", "  HostName 127.0.0.3", "Host *.wild", "Host !neg-y", ""].join("\n"));
  // The daemon throttles host discovery to one run per 5 s: a config written right after its start would be read by the next refresh only.
  await new Promise((r) => setTimeout(r, 5_200));
});

const rows = (page: import("@playwright/test").Page, alias: string) => page.getByTestId("container-row").filter({ has: page.getByText(alias, { exact: true }) });

Then("the SSH host list shows {string} once", async ({ page }, alias: string) => {
  await expect(rows(page, alias)).toHaveCount(1, { timeout: 30_000 });
});

Then("the SSH host list does not show {string}", async ({ page }, alias: string) => {
  await expect(page.getByTestId("container-row").first()).toBeVisible();
  await expect(rows(page, alias)).toHaveCount(0);
});

const dialog = (page: import("@playwright/test").Page) => page.getByTestId("add-ssh-host-dialog");

When("I open the Add SSH host dialog", async ({ page }) => {
  await page.getByTestId("add-ssh-host").click();
  await expect(dialog(page)).toBeVisible();
});

When("I type the Add SSH host command {string}", async ({ page }, command: string) => {
  await page.getByTestId("add-ssh-host-command").fill(command);
});

When("I add the typed SSH host", async ({ page }) => {
  await page.getByTestId("add-ssh-host-submit").click();
});

Then("the Add SSH host preview shows {string} as {string}", async ({ page }, key: string, value: string) => {
  await expect(page.getByTestId(`add-ssh-host-preview-${key}`)).toHaveText(value);
});

Then("the Add SSH host dialog says {string}", async ({ page }, text: string) => {
  await expect(dialog(page).getByRole("alert")).toContainText(text);
});

Then("the Add SSH host dialog is closed", async ({ page }) => {
  await expect(dialog(page)).toHaveCount(0);
});

Then("the SSH host {string} is the selected row", async ({ page }, alias: string) => {
  await expect(rows(page, alias)).toHaveAttribute("aria-selected", "true");
});

When("I press Escape in the Add SSH host dialog", async ({ page }) => {
  await page.getByTestId("add-ssh-host-command").press("Escape");
});

Then("the Add SSH host button has the focus", async ({ page }) => {
  await expect(page.getByTestId("add-ssh-host")).toBeFocused();
});

const inside = async (outer: import("@playwright/test").Locator, inner: import("@playwright/test").Locator, name: string) => {
  await inner.scrollIntoViewIfNeeded();
  const d = (await outer.boundingBox())!;
  const b = (await inner.boundingBox())!;
  expect(b && b.y >= d.y - 0.5 && b.y + b.height <= d.y + d.height + 0.5 && b.x >= d.x - 0.5 && b.x + b.width <= d.x + d.width + 0.5, `${name} ${JSON.stringify(b)} in dialog ${JSON.stringify(d)}`).toBe(true);
};

Then("the Add SSH host dialog fits the viewport", async ({ page }) => {
  const box = (await dialog(page).boundingBox())!;
  const { width: vw, height: vh } = page.viewportSize()!;
  expect(box.x >= 0 && box.x + box.width <= vw && box.y >= 0 && box.y + box.height <= vh, `dialog ${JSON.stringify(box)} in ${vw}x${vh}`).toBe(true);
  // Below sm (640 px) it is a full-height sheet.
  if (vw < 640) expect(Math.round(box.height), `sheet height in ${vh}`).toBe(vh);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The input, its buttons and an error are inside the dialog; targets are 44 px tall below md (768 px).
  const parts = { input: page.getByTestId("add-ssh-host-command"), add: page.getByTestId("add-ssh-host-submit"), cancel: page.getByTestId("add-ssh-host-cancel") };
  for (const [name, loc] of Object.entries(parts)) {
    await inside(dialog(page), loc, name);
    if (vw < 768) expect((await loc.boundingBox())!.height, `${name} height`).toBeGreaterThanOrEqual(44);
  }
  const alert = dialog(page).getByRole("alert");
  if (await alert.count()) await inside(dialog(page), alert, "error");
});

Then("the ssh config has a Host block {string} with {string}", async ({}, alias: string, line: string) => {
  const text = readFileSync(join(sshDir(runDir()), "config"), "utf8");
  const i = text.indexOf(`Host ${alias}\n`);
  expect(i, text).toBeGreaterThanOrEqual(0);
  expect(text.slice(i)).toContain(line);
});
