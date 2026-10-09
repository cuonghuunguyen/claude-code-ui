// Dev-only: renders the PNG icons in ../public from the SVG sources (public/icon.svg and the ones next to this file).
// Not part of `npm run build` and adds no dependency: it drives an installed Chrome/Edge in headless mode.
// Usage: node packages/web/scripts/icons.mjs   (CHROME=<path> to pick the browser)
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public");

const targets = [
  ["icon-192.png", join(pub, "icon.svg"), 192],
  ["icon-512.png", join(pub, "icon.svg"), 512],
  ["icon-maskable-192.png", join(here, "icon-maskable.svg"), 192],
  ["icon-maskable-512.png", join(here, "icon-maskable.svg"), 512],
  ["apple-touch-icon.png", join(here, "icon-apple.svg"), 180],
  ["badge-96.png", join(here, "badge.svg"), 96],
  ["favicon-32.png", join(pub, "icon.svg"), 32],
];

const candidates = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) throw new Error("No Chrome/Edge found: set CHROME=<path>");

const tmp = mkdtempSync(join(tmpdir(), "claude-ui-icons-"));
try {
  for (const [name, svg, size] of targets) {
    const page = join(tmp, "page.html");
    const data = Buffer.from(readFileSync(svg)).toString("base64");
    writeFileSync(
      page,
      `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="data:image/svg+xml;base64,${data}">`,
    );
    const out = join(tmp, name);
    execFileSync(chrome, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
      "--default-background-color=00000000", `--window-size=${size},${size}`, `--screenshot=${out}`,
      `--user-data-dir=${join(tmp, "profile")}`, pathToFileURL(page).href,
    ], { stdio: "ignore" });
    renameSync(out, join(pub, name));
    console.log(`${name} ${size}x${size}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
