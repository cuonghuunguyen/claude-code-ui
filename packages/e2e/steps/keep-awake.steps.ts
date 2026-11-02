import { execFileSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";
import { openApp } from "../support/flow.ts";
import type { Daemon } from "../support/daemon.ts";
import { Given, Then, When } from "./fixtures.ts";

const row = (page: Page) => page.getByTestId("settings-computer-awake");
const screenSw = (page: Page) => page.getByTestId("settings-keep-awake");
const second = new WeakMap<object, Page>();

async function openGeneral(page: Page) {
  // A phone shows the sidebar, and its Settings button, in a drawer.
  const drawer = page.getByTestId("open-drawer");
  if (await drawer.isVisible()) await drawer.click();
  const open = page.getByTestId("open-settings").last();
  await expect(open).toBeInViewport();
  await open.click();
  await page.getByTestId("settings-group-general").click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
}

/** Run `fn` with Settings › General open; close it again when this call opened it. */
async function inGeneral<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  if (await page.getByTestId("settings-dialog").isVisible()) return fn();
  await openGeneral(page);
  const r = await fn();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
  return r;
}

const checked = (on: string) => (on === "on" ? "true" : "false");

Given("Keep computer awake is off", async ({ page }) => {
  await inGeneral(page, async () => {
    if ((await row(page).getAttribute("aria-checked")) === "true") await row(page).click();
    await expect(row(page)).toHaveAttribute("aria-checked", "false");
  });
});

When("I open Settings › General", async ({ page }) => {
  await openGeneral(page);
});

When("I click Keep computer awake", async ({ page }) => {
  await row(page).click();
});

When("I click Keep screen awake", async ({ page }) => {
  await screenSw(page).click();
});

When("I click the Keep screen awake titlebar button", async ({ page }) => {
  await page.getByTestId("keep-awake").click();
});

Then("Keep computer awake is {string}", async ({ page }, on: string) => {
  await inGeneral(page, () => expect(row(page)).toHaveAttribute("aria-checked", checked(on)));
});

Then("Keep screen awake is {string}", async ({ page }, on: string) => {
  await inGeneral(page, () => expect(screenSw(page)).toHaveAttribute("aria-checked", checked(on)));
});

Then("Keep computer awake says closing the lid can still sleep a laptop", async ({ page }) => {
  const hint = page.locator("#settings-computer-awake-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText("Stops idle sleep while a session runs. Closing the lid can still sleep a laptop.");
});

Given("a second page shows Settings › General", async ({ page, daemon }) => {
  const p2 = await page.context().newPage();
  await p2.setViewportSize({ width: 1440, height: 900 });
  await openApp(p2, daemon);
  await openGeneral(p2);
  await expect(row(p2)).toHaveAttribute("aria-checked", "false");
  second.set(page, p2);
});

Then("Keep computer awake is {string} on the second page", async ({ page }, on: string) => {
  await expect(row(second.get(page)!)).toHaveAttribute("aria-checked", checked(on), { timeout: 10_000 });
  await second.get(page)!.screenshot({ path: `${process.env.E2E_EVIDENCE_DIR ?? "."}/keep-computer-awake--second-page.png` });
});

/** Rows of `ps` that are a caffeinate (macOS) or systemd-inhibit (Linux) child of this daemon, matched by the daemon's PID. */
function inhibitors(daemon: Daemon): string[] {
  const name = process.platform === "darwin" ? "caffeinate" : "systemd-inhibit";
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  return out.split("\n").filter((l) => new RegExp(`^\\s*\\d+\\s+${daemon.pid}\\s+\\S*${name}( |$)`).test(l));
}

Then("the daemon holds one sleep inhibitor", async ({ daemon }) => {
  await expect.poll(() => inhibitors(daemon), { timeout: 15_000 }).toHaveLength(1);
  if (process.platform === "darwin") expect(inhibitors(daemon)[0]).toMatch(new RegExp(`caffeinate -i -w ${daemon.pid}$`));
});

Then("the daemon holds no sleep inhibitor", async ({ daemon }) => {
  await expect.poll(() => inhibitors(daemon), { timeout: 15_000 }).toHaveLength(0);
});
