// The app icon and name (docs/spec.md "Static files"): /app-icon serves the `app.icon` setting as an image, /manifest.webmanifest
// swaps in that icon and the `app.name`. Both are unauthenticated like the static files (an installed app fetches them without the token).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { APP_ICON_PX } from "@claude-ui/protocol";

const DATA = /^data:(image\/(?:png|webp|jpeg));base64,(.+)$/;
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hashOf = (icon: string) => createHash("sha256").update(icon).digest("hex");

/** The icon as bytes and type: the decoded image, or an SVG around the emoji (same geometry as the web app's favicon). */
export function iconFile(icon: string): { body: Buffer; type: string; image: boolean } {
  const m = DATA.exec(icon);
  if (m) return { body: Buffer.from(m[2]!, "base64"), type: m[1]!, image: true };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${APP_ICON_PX} ${APP_ICON_PX}"><text x="256" y="256" font-size="400" text-anchor="middle" dominant-baseline="central">${xml(icon)}</text></svg>`;
  return { body: Buffer.from(svg), type: "image/svg+xml", image: false };
}

const COMMON = { "cache-control": "no-cache", "x-content-type-options": "nosniff" } as const;
const notModified = (req: IncomingMessage, etag: string) => (req.headers["if-none-match"] ?? "").split(",").some((t) => t.trim() === "*" || t.trim().replace(/^W\//, "") === etag);

/** Handles GET/HEAD /app-icon and /manifest.webmanifest; false = not ours (or neither icon nor name is set: static serves the manifest). `getApp`: reads the current setting, only for these two paths. */
export function serveAppIcon(req: IncomingMessage, res: ServerResponse, root: string, path: string, getApp: () => { icon: string; name: string }): boolean {
  if (path !== "/app-icon" && path !== "/manifest.webmanifest") return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const { icon, name } = getApp();
  if (path === "/manifest.webmanifest") {
    if (!icon && !name) return false;
    void manifest(req, res, root, icon, name);
    return true;
  }
  if (!icon) return void res.writeHead(302, { location: "/icon.svg", "cache-control": "no-cache" }).end(), true;
  const f = iconFile(icon);
  const etag = `"${hashOf(icon).slice(0, 32)}"`;
  const headers: Record<string, string | number> = { ...COMMON, etag, ...(!f.image && { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" }) };
  if (notModified(req, etag)) return void res.writeHead(304, headers).end(), true;
  res.writeHead(200, { ...headers, "content-type": f.type, "content-length": f.body.length }).end(req.method === "HEAD" ? undefined : f.body);
  return true;
}

async function manifest(req: IncomingMessage, res: ServerResponse, root: string, icon: string, name: string) {
  try {
    const m = JSON.parse(await readFile(join(root, "manifest.webmanifest"), "utf8")) as Record<string, unknown>;
    if (name) m.name = m.short_name = name;
    if (icon) {
      const f = iconFile(icon);
      m.icons = [{ src: `/app-icon?v=${hashOf(icon).slice(0, 8)}`, sizes: f.image ? `${APP_ICON_PX}x${APP_ICON_PX}` : "any", type: f.type, purpose: "any" }];
    }
    const body = Buffer.from(JSON.stringify(m));
    res.writeHead(200, { ...COMMON, "content-type": "application/manifest+json", "content-length": body.length }).end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" }).end("not found");
  }
}
