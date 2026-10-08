import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveStatic } from "../src/static.ts";

const js = "export const hello = 'world';\n".repeat(200);
const br = brotliCompressSync(js);
const gz = gzipSync(js);
let dir: string;
let server: Server;
let port: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "claude-ui-static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<h1>app</h1>");
  writeFileSync(join(dir, "sw.js"), "// sw");
  writeFileSync(join(dir, "manifest.webmanifest"), "{}");
  writeFileSync(join(dir, "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, "assets", "app-abc123.js"), js);
  writeFileSync(join(dir, "assets", "app-abc123.js.br"), br);
  writeFileSync(join(dir, "assets", "app-abc123.js.gz"), gz);
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    serveStatic(req, res, resolve(dir), path);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

// fetch() decompresses and hides content-encoding on some versions: use http.request for raw bytes.
const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", fail);
    req.end();
  });

describe("static files: precompressed variants", () => {
  it("serves the .br file to a client that accepts br, immutable and varying on accept-encoding", async () => {
    const r = await get("/assets/app-abc123.js", { "accept-encoding": "gzip, deflate, br" });
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBe("br");
    expect(r.headers["content-type"]).toBe("text/javascript");
    expect(r.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(r.headers.vary).toBe("accept-encoding");
    expect(r.headers["content-length"]).toBe(String(br.length));
    expect(r.body.equals(br)).toBe(true);
  });

  it("falls back to .gz for a client without br, and to the plain file without any encoding or with br;q=0", async () => {
    const g = await get("/assets/app-abc123.js", { "accept-encoding": "gzip" });
    expect(g.headers["content-encoding"]).toBe("gzip");
    expect(g.body.equals(gz)).toBe(true);
    for (const h of [{}, { "accept-encoding": "br;q=0" }, { "accept-encoding": "identity" }] as Record<string, string>[]) {
      const p = await get("/assets/app-abc123.js", h);
      expect(p.headers["content-encoding"]).toBeUndefined();
      expect(p.headers.vary).toBe("accept-encoding");
      expect(p.body.toString()).toBe(js);
    }
    const q = await get("/assets/app-abc123.js", { "accept-encoding": "br;q=0, gzip;q=0.5" });
    expect(q.headers["content-encoding"]).toBe("gzip");
  });

  it("never serves a variant file by its own name", async () => {
    expect((await get("/assets/app-abc123.js.br", { "accept-encoding": "br" })).status).toBe(404);
    expect((await get("/assets/app-abc123.js.gz")).status).toBe(404);
  });

  it("does not compress or vary a file that is not compressible", async () => {
    const r = await get("/icon-192.png", { "accept-encoding": "br" });
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.headers.vary).toBeUndefined();
    expect(r.headers["content-type"]).toBe("image/png");
  });
});

describe("static files: missing paths", () => {
  it("answers 404, not index.html, for a missing asset or a missing file with an extension", async () => {
    for (const p of ["/assets/missing-zzz.js", "/missing.png", "/assets/nope"]) {
      const r = await get(p);
      expect(r.status, p).toBe(404);
      expect(r.headers["content-type"]).toBe("text/plain");
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.body.toString()).not.toContain("<h1>");
    }
  });

  it("falls back to index.html for a client route and for /", async () => {
    for (const p of ["/some/route", "/"]) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      expect(r.body.toString()).toBe("<h1>app</h1>");
      expect(r.headers["cache-control"]).toBe("no-cache");
    }
  });

  it("stays 403 outside the root", async () => {
    const res = { writeHead: (s: number) => (status = s, res), end: () => res } as never;
    let status = 0;
    serveStatic({ method: "GET", headers: {} } as never, res, resolve(dir), "/../x");
    expect(status).toBe(403);
  });

  it("answers 405 to a method other than GET and HEAD", async () => {
    const r = await get("/", {}, "POST");
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe("GET, HEAD");
  });
});

describe("static files: cache headers and validators", () => {
  it("revalidates the service worker, manifest, icons and html on every load", async () => {
    for (const p of ["/sw.js", "/manifest.webmanifest", "/icon-192.png", "/index.html"]) {
      expect((await get(p)).headers["cache-control"], p).toBe("no-cache");
    }
    expect((await get("/manifest.webmanifest")).headers["content-type"]).toBe("application/manifest+json");
  });

  it("answers 304 with no body to a matching If-None-Match, and a different ETag per encoding", async () => {
    const enc = await get("/assets/app-abc123.js", { "accept-encoding": "br" });
    const plain = await get("/assets/app-abc123.js");
    expect(enc.headers.etag).toMatch(/^W\/"[0-9a-z]+-[0-9a-z]+"$/);
    expect(enc.headers.etag).not.toBe(plain.headers.etag);
    expect(enc.headers["last-modified"]).toBeDefined();
    const again = await get("/assets/app-abc123.js", { "accept-encoding": "br", "if-none-match": enc.headers.etag as string });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    expect(again.headers.etag).toBe(enc.headers.etag);
    // The br ETag does not validate the identity representation.
    expect((await get("/assets/app-abc123.js", { "if-none-match": enc.headers.etag as string })).status).toBe(200);
    expect((await get("/", { "if-none-match": (await get("/")).headers.etag as string })).status).toBe(304);
  });

  it("answers HEAD with the headers of GET and no body", async () => {
    const h = await get("/assets/app-abc123.js", { "accept-encoding": "br" }, "HEAD");
    expect(h.status).toBe(200);
    expect(h.headers["content-length"]).toBe(String(br.length));
    expect(h.headers["content-encoding"]).toBe("br");
    expect(h.body.length).toBe(0);
  });
});
