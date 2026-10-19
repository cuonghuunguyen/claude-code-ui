// Writes the docs screenshots to docs/site/public/screenshots/: the real web app against a scripted fake daemon (packages/web/scenes),
// captured with Playwright. `npm run docs:shots [scene...]`; with no argument every scene is captured.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { SCENES } from "../../../packages/web/scenes/index.ts";

const out = fileURLToPath(new URL("../public/screenshots/", import.meta.url));
const web = fileURLToPath(new URL("../../../packages/web/", import.meta.url));
// The page clock is fixed to the scenes' "now" (scenes/demo.ts NOW), so relative times read the same on every run.
const NOW = new Date("2026-03-12T10:30:00Z");

const wanted = process.argv.slice(2);
const unknown = wanted.filter((n) => !SCENES[n]);
if (unknown.length) {
  console.error(`unknown scene ${unknown.join(", ")}; known: ${Object.keys(SCENES).join(", ")}`);
  process.exit(1);
}
const names = wanted.length ? wanted : Object.keys(SCENES);

mkdirSync(out, { recursive: true });
const server = await createServer({ configFile: `${web}vite.scenes.config.ts`, server: { port: 0, forwardConsole: false } });
await server.listen();
const base = server.resolvedUrls!.local[0]!;
const browser = await chromium.launch();
let failed = false;
try {
  for (const name of names) {
    const scene = SCENES[name]!;
    for (const theme of scene.themes ?? ["light"]) {
      const file = `${name}${theme === "dark" ? "-dark" : ""}.png`;
      const context = await browser.newContext({ viewport: scene.viewport ?? { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: "reduce" });
      const page = await context.newPage();
      const problems: string[] = [];
      page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "warning" && m.text().startsWith("[scene]")) console.log(`  ${name}: ${m.text()}`);
        else if (m.type() === "error") problems.push(`console error: ${m.text()}`);
        else if (process.env.SHOTS_DEBUG) console.log(`  ${name}: [${m.type()}] ${m.text()}`);
      });
      try {
        await page.clock.setFixedTime(NOW);
        await page.goto(`${base}scenes/scenes.html?scene=${name}&theme=${theme}`, { waitUntil: "commit" });
        await page.waitForSelector("body[data-scene-ready]", { timeout: 90_000 });
        await page.evaluate(() => document.fonts.ready);
        await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
        await scene.steps?.(page);
        await page.waitForTimeout(300);
        const target = scene.clip ? page.locator(scene.clip) : page;
        await target.screenshot({ path: `${out}${file}` });
        console.log(`${file}${problems.length ? `  (${problems.length} problem${problems.length > 1 ? "s" : ""})` : ""}`);
        for (const p of problems) console.log(`  ${name}: ${p}`);
      } catch (e) {
        failed = true;
        console.error(`${file}: ${(e as Error).message}`);
        for (const p of problems) console.error(`  ${name}: ${p}`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
