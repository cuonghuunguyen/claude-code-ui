// Build step: writes .br and .gz next to every compressible file in dist/, served by packages/daemon/src/static.ts.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { Plugin } from "vite";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Keep in step with COMPRESSIBLE in packages/daemon/src/static.ts. woff2 and png are already compressed. */
const COMPRESSIBLE = new Set([".js", ".css", ".html", ".svg", ".json", ".webmanifest", ".txt", ".wasm"]);
const MIN_BYTES = 1024;
/** A variant must be at least 10% smaller than the original, else the client gets the plain file. */
const MAX_RATIO = 0.9;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

export type PrecompressResult = { files: number; originalBytes: number; brBytes: number; gzBytes: number };

export async function precompressDir(dir: string, opts: { brotliQuality?: number; concurrency?: number } = {}): Promise<PrecompressResult> {
  const quality = opts.brotliQuality ?? 11;
  const result: PrecompressResult = { files: 0, originalBytes: 0, brBytes: 0, gzBytes: 0 };
  const files: string[] = [];
  for await (const f of walk(dir)) if (COMPRESSIBLE.has(extname(f)) && (await stat(f)).size >= MIN_BYTES) files.push(f);
  const one = async (f: string) => {
    const data = await readFile(f);
    const [br, gz] = await Promise.all([
      brotli(data, { params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
      gzipAsync(data, { level: 9 }),
    ]);
    result.files++;
    result.originalBytes += data.length;
    if (br.length <= data.length * MAX_RATIO) (await writeFile(f + ".br", br), (result.brBytes += br.length));
    if (gz.length <= data.length * MAX_RATIO) (await writeFile(f + ".gz", gz), (result.gzBytes += gz.length));
  };
  // The zlib work runs on libuv's pool (4 threads): a few files at a time keeps it busy without holding every file in memory.
  const queue = [...files];
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, async () => { for (let f = queue.shift(); f; f = queue.shift()) await one(f); }));
  return result;
}

export function precompress(): Plugin {
  let outDir = "dist";
  return {
    name: "precompress",
    apply: "build",
    configResolved: (c) => void (outDir = join(c.root, c.build.outDir)),
    // closeBundle: public/ files and THIRD_PARTY_LICENSES.txt are in dist by now.
    async closeBundle() {
      const t = Date.now();
      const r = await precompressDir(outDir);
      console.log(`precompress: ${r.files} files, ${(r.originalBytes / 1e6).toFixed(1)} MB -> br ${(r.brBytes / 1e6).toFixed(1)} MB, gz ${(r.gzBytes / 1e6).toFixed(1)} MB in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    },
  };
}
