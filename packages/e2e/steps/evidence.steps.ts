import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { evidenceDir, runDir, slug, testSlugs } from "../support/paths.ts";
import { Then } from "./fixtures.ts";

// <evidence>/<feature>--<scenario>--<nn>-<name>--<w>x<h>[-r<retry>].png, also attached to the HTML report.
Then("I capture {string}", async ({ page, evidence, $testInfo }, name: string) => {
  const dir = evidenceDir(runDir());
  mkdirSync(dir, { recursive: true });
  const size = page.viewportSize();
  const { feature, scenario } = testSlugs($testInfo);
  const retry = $testInfo.retry ? `-r${$testInfo.retry}` : "";
  const nn = String(evidence.next()).padStart(2, "0");
  const file = join(dir, `${feature}--${scenario}--${nn}-${slug(name, 30)}--${size?.width}x${size?.height}${retry}.png`);
  await page.screenshot({ path: file });
  await $testInfo.attach(name, { path: file, contentType: "image/png" });
});
