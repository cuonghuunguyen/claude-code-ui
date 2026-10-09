import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomFillSync } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { precompressDir } from "../precompress.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("precompressDir", () => {
  it("writes .br (and no .gz) that decompress to the original, only where the file is big and compressible enough", async () => {
    dir = mkdtempSync(join(tmpdir(), "claude-ui-precompress-"));
    mkdirSync(join(dir, "assets"));
    const big = "const a = 1;\n".repeat(500);
    writeFileSync(join(dir, "assets", "app.js"), big);
    writeFileSync(join(dir, "index.html"), "<p>small</p>");
    writeFileSync(join(dir, "assets", "font.woff2"), "x".repeat(5000));
    writeFileSync(join(dir, "icon.png"), "x".repeat(5000));
    const noise = Buffer.alloc(4000);
    writeFileSync(join(dir, "assets", "noise.js"), randomFillSync(noise));

    const r = await precompressDir(dir, { brotliQuality: 5 });

    expect(brotliDecompressSync(readFileSync(join(dir, "assets", "app.js.br"))).toString()).toBe(big);
    expect(existsSync(join(dir, "assets", "app.js.gz"))).toBe(false);
    for (const skipped of ["index.html.br", "index.html.gz", "assets/font.woff2.br", "assets/font.woff2.gz", "icon.png.gz", "assets/noise.js.br", "assets/noise.js.gz"]) {
      expect(existsSync(join(dir, skipped)), skipped).toBe(false);
    }
    expect(r.files).toBe(2);
  });
});
