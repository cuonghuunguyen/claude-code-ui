// Static files of the built web app (docs/spec.md "Static files"): cache headers, ETag/304, precompressed
// .br/.gz variants written by the web build, and a 404 (not index.html) for a missing asset.
import { createReadStream, statSync, type Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";
import { gzip } from "node:zlib";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

/** Types worth compressing; the web build writes .br next to these (packages/web/precompress.ts); gzip is made on request (below). */
const COMPRESSIBLE = new Set([".js", ".css", ".html", ".svg", ".json", ".webmanifest", ".txt", ".wasm"]);

/** Encodings the client accepts (q > 0), best first among those we have files for. */
const acceptedEncodings = (header: string | undefined): Set<string> => {
  const ok = new Set<string>();
  const banned = new Set<string>();
  for (const part of (header ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
    (q !== undefined && Number(q) === 0 ? banned : ok).add(name);
  }
  if (ok.has("*")) for (const e of ["br", "gzip"]) if (!banned.has(e)) ok.add(e);
  for (const e of banned) ok.delete(e);
  return ok;
};

const fileStat = (file: string): Stats | undefined => {
  try {
    const st = statSync(file);
    return st.isFile() ? st : undefined;
  } catch {
    return undefined;
  }
};

const MIN_GZIP_BYTES = 1024;
/** On-the-fly gzip for a client without br (plain-http --lan): compressed once per file version, kept in memory (the web app is a few MB). */
const gzipped = new Map<string, Promise<Buffer>>();
const gzipOf = (file: string, etag: string): Promise<Buffer> => {
  const key = `${file}|${etag}`;
  let p = gzipped.get(key);
  if (!p) {
    p = readFile(file).then((data) => new Promise<Buffer>((ok, fail) => gzip(data, { level: 9 }, (e, out) => (e ? fail(e) : ok(out)))));
    p.catch(() => gzipped.delete(key));
    gzipped.set(key, p);
  }
  return p;
};

const etagOf = (st: Stats) => `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;

const notFound = (res: ServerResponse, text: string) => void res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" }).end(text);

/** `path` is the decoded request pathname. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, path: string): void {
  if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
  let file = join(root, path);
  if (!file.startsWith(root + sep) && file !== root) return void res.writeHead(403).end();
  // A variant file is only served through negotiation, never by its own name.
  if (/\.(br|gz)$/.test(path)) return notFound(res, "not found");
  let st = fileStat(file);
  let logical = path;
  if (!st) {
    // SPA fallback only for a client route; a missing asset (or any path with an extension) must not parse as html.
    if (path.startsWith("/assets/") || extname(path) !== "") return notFound(res, "not found");
    file = join(root, "index.html");
    logical = "/index.html";
    st = fileStat(file);
    if (!st) return notFound(res, "web app not built: run npm run build");
  }
  const ext = extname(file);
  const headers: Record<string, string | number> = {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": logical.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  };
  let gz = false;
  if (COMPRESSIBLE.has(ext)) {
    headers.vary = "accept-encoding";
    const accepted = acceptedEncodings(req.headers["accept-encoding"]);
    const br = accepted.has("br") ? fileStat(file + ".br") : undefined;
    if (br) {
      file += ".br";
      st = br;
      headers["content-encoding"] = "br";
    } else if (accepted.has("gzip") && st.size >= MIN_GZIP_BYTES) {
      gz = true;
      headers["content-encoding"] = "gzip";
    }
  }
  headers.etag = gz ? etagOf(st).replace(/"$/, '-gz"') : etagOf(st);
  headers["last-modified"] = st.mtime.toUTCString();
  const inm = req.headers["if-none-match"];
  if (inm && (inm.trim() === "*" || inm.split(",").some((t) => t.trim().replace(/^W\//, "") === headers.etag.toString().replace(/^W\//, "")))) {
    delete headers["content-type"];
    return void res.writeHead(304, headers).end();
  }
  if (gz) {
    const source = file;
    return void gzipOf(source, headers.etag as string).then(
      (body) => {
        headers["content-length"] = body.length;
        res.writeHead(200, headers).end(req.method === "HEAD" ? undefined : body);
      },
      () => res.destroy(),
    );
  }
  headers["content-length"] = st.size;
  res.writeHead(200, headers);
  if (req.method === "HEAD") return void res.end();
  const stream = createReadStream(file);
  res.on("close", () => stream.destroy());
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}
