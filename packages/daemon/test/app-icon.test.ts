import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { serveAppIcon } from "../src/app-icon.ts";

const BYTES = Buffer.from("RIFFxxxxWEBP");
const IMG = `data:image/webp;base64,${BYTES.toString("base64")}`;
const MANIFEST = { name: "Claude UI", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }] };
let dir: string;
let server: Server;
let port: number;
let icon = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "claude-ui-app-icon-"));
  writeFileSync(join(dir, "manifest.webmanifest"), JSON.stringify(MANIFEST));
  server = createServer((req, res) => {
    if (!serveAppIcon(req, res, resolve(dir), new URL(req.url ?? "/", "http://x").pathname, () => icon)) res.writeHead(404, { "x-fell-through": "1" }).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", fail);
    req.end();
  });

it("the built-in icon: /app-icon redirects to /icon.svg and the manifest falls through to the static file", async () => {
  icon = "";
  const r = await get("/app-icon");
  expect([r.status, r.headers.location]).toEqual([302, "/icon.svg"]);
  expect((await get("/manifest.webmanifest")).headers["x-fell-through"]).toBe("1");
});

it("an image icon is served as its decoded bytes with its type, no-cache and nosniff", async () => {
  icon = IMG;
  const r = await get("/app-icon?v=abc");
  expect(r.status).toBe(200);
  expect(r.body.equals(BYTES)).toBe(true);
  expect(r.headers["content-type"]).toBe("image/webp");
  expect(r.headers["cache-control"]).toBe("no-cache");
  expect(r.headers["x-content-type-options"]).toBe("nosniff");
  expect(r.headers["content-security-policy"]).toBeUndefined();
});

it("an emoji icon is an SVG with the emoji escaped and a restrictive CSP", async () => {
  icon = "<&>";
  const r = await get("/app-icon");
  const svg = r.body.toString();
  expect(r.headers["content-type"]).toBe("image/svg+xml");
  expect(r.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'");
  expect(svg).toContain('viewBox="0 0 512 512"');
  expect(svg).toContain(">&#60;&#38;&#62;</text>");
  expect(svg).not.toContain("<&>");
});

it("an ETag gives 304 for the same icon and a new one for another", async () => {
  icon = "🚀";
  const a = await get("/app-icon");
  const etag = a.headers.etag as string;
  expect((await get("/app-icon", { "if-none-match": etag })).status).toBe(304);
  icon = "🎉";
  const b = await get("/app-icon", { "if-none-match": etag });
  expect(b.status).toBe(200);
  expect(b.headers.etag).not.toBe(etag);
});

it("the manifest swaps its icons for the custom one and keeps the other fields", async () => {
  icon = IMG;
  const r = await get("/manifest.webmanifest");
  expect(r.headers["content-type"]).toBe("application/manifest+json");
  expect(r.headers["cache-control"]).toBe("no-cache");
  const m = JSON.parse(r.body.toString());
  expect(m.name).toBe("Claude UI");
  expect(m.icons).toEqual([{ src: expect.stringMatching(/^\/app-icon\?v=[0-9a-f]{8}$/), sizes: "512x512", type: "image/webp", purpose: "any" }]);
  icon = "🚀";
  const e = JSON.parse((await get("/manifest.webmanifest")).body.toString());
  expect(e.icons[0]).toMatchObject({ sizes: "any", type: "image/svg+xml" });
  expect(e.icons[0].src).not.toBe(m.icons[0].src);
});
