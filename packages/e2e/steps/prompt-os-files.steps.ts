import { expect, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";
import { promptBox } from "../support/ui.ts";

/** A DataTransfer built in the page with the shape the OS gives (Files); `folder` adds a directory entry. */
const MAKE_DT = (names: string[], folder: boolean) => {
  const d = new DataTransfer();
  for (const n of names) d.items.add(new File([`content of ${n}`], n, { type: "text/plain" }));
  if (!folder) return d;
  // Chromium cannot build a directory item: the items list is replaced by one that reports a folder entry.
  const items = [
    ...Array.from(d.items).map((it) => ({ kind: "file", getAsFile: () => it.getAsFile(), webkitGetAsEntry: () => ({ isDirectory: false }) })),
    { kind: "file", getAsFile: () => new File([], "somefolder"), webkitGetAsEntry: () => ({ isDirectory: true }) },
  ];
  Object.defineProperty(d, "items", { value: items });
  return d;
};

const fire = async (page: Page, kind: "paste" | "drop", names: string[], folder = false) => {
  await promptBox(page).click();
  await promptBox(page).evaluate(
    (el, { kind, names, folder, make }) => {
      const d = new Function(`return (${make})`)()(names, folder) as DataTransfer;
      if (kind === "paste") el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: d }));
      else el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: d }));
    },
    { kind, names, folder, make: MAKE_DT.toString() },
  );
};

When("I paste the OS file {string} in the prompt box", async ({ page }, name: string) => fire(page, "paste", [name]));
When("I drop the OS files {string} on the prompt box", async ({ page }, names: string) => fire(page, "drop", names.split(",").map((n) => n.trim())));
When("I drop the OS file {string} and a folder on the prompt box", async ({ page }, name: string) => fire(page, "drop", [name], true));
When("I press {string} in the prompt box", async ({ page }, keys: string) => {
  await promptBox(page).focus();
  await page.keyboard.press(keys);
});

Then("the prompt box holds an @ mention of {string}", async ({ page }, name: string) => {
  await expect(promptBox(page)).toHaveValue(new RegExp(`@\\S*${name.replace(/\./g, "\\.")}`), { timeout: 30_000 });
});
Then("the prompt box text does not hold {string}", async ({ page }, text: string) => {
  await expect(promptBox(page)).not.toHaveValue(new RegExp(text));
});
Then("no prompt error is shown", async ({ page }) => {
  await expect(page.getByTestId("prompt-error")).toHaveCount(0);
});
Then("the prompt error says {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("prompt-error")).toContainText(text);
});
