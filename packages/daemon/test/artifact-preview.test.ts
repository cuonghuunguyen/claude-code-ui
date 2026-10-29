import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { Part } from "@claude-ui/protocol";
import { ARTIFACT_ASSET_HEADERS, ARTIFACT_ASSETS_MAX, ARTIFACT_CSP, ARTIFACT_HEADERS, artifactAssetsOf, artifactCsp, artifactFileOf, artifactHeaders, assetKey, assetRequestAllowed, scratchpadOf } from "../src/artifact-preview.ts";

const call = (input: unknown, status: string = "done", tool = "Artifact"): Part => ({ type: "tool_call", id: "t", toolUseId: "t", tool, input, status }) as Part;

describe("artifactFileOf", () => {
  it("accepts a done publish of an .html/.htm page, absolute or relative to the cwd", () => {
    expect(artifactFileOf(call({ file_path: "/t/a.html" }), "/c")).toMatchObject({ path: resolve("/t/a.html") });
    expect(artifactFileOf(call({ file_path: "a/p.HTM" }), "/c")).toMatchObject({ path: resolve("/c", "a/p.HTM") });
    expect(artifactFileOf(call({ action: "publish", file_path: "/t/a.html" }), "/c")).toMatchObject({ path: resolve("/t/a.html") });
  });

  it("refuses other tools, other actions, asset uploads, unfinished calls and missing paths (unknown_part)", () => {
    const bad = [
      call({ file_path: "/t/a.html" }, "done", "Read"),
      { type: "tool_result", id: "r", toolUseId: "t", output: "x", isError: false } as unknown as Part,
      undefined,
      call({ action: "read", file_path: "/t/a.html" }),
      call({ action: "list", file_path: "/t/a.html" }),
      call({ asset: true, file_path: "/t/a.html" }),
      ...["error", "denied", "pending", "running"].map((s) => call({ file_path: "/t/a.html" }, s)),
      call({ file_path: "" }),
      call({ file_path: 5 }),
      call({ file_path: "a\0.html" }),
      call("x"),
      call(null),
    ];
    for (const p of bad) expect(artifactFileOf(p, "/c"), JSON.stringify(p)).toMatchObject({ code: "unknown_part" });
  });

  it("refuses a non-HTML file_path (unsupported_type)", () => {
    for (const f of ["/t/a.txt", "/t/a.html.txt", "/t/noext"]) expect(artifactFileOf(call({ file_path: f }), "/c")).toMatchObject({ code: "unsupported_type" });
  });
});

describe("artifactFileOf title (GH-400)", () => {
  it("is the input title, else the file base name", () => {
    expect(artifactFileOf(call({ file_path: "/t/a.html", title: "Sales" }), "/c")).toMatchObject({ title: "Sales" });
    expect(artifactFileOf(call({ file_path: "/t/a.html", title: "" }), "/c")).toMatchObject({ title: "a.html" });
    expect(artifactFileOf(call({ file_path: "/t/a.html", title: 5 }), "/c")).toMatchObject({ title: "a.html" });
    expect(artifactFileOf(call({ file_path: "a/p.htm" }), "/c")).toMatchObject({ title: "p.htm" });
  });
});

describe("ARTIFACT_CSP", () => {
  const dirs = new Map(ARTIFACT_CSP.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]));

  it("has no allow-same-origin, no network source and frames only from the own origin", () => {
    expect(dirs.get("sandbox")).toEqual(["allow-scripts"]);
    expect(dirs.get("default-src")).toEqual(["'none'"]);
    expect(dirs.get("frame-ancestors")).toEqual(["'self'"]);
    expect(dirs.has("connect-src")).toBe(false);
    expect(dirs.has("frame-src")).toBe(false);
    for (const [k, v] of dirs) {
      if (k === "frame-ancestors") continue;
      for (const s of v) expect(s, k).not.toMatch(/^(https?:|\*|'self')/);
    }
    expect(dirs.get("script-src")).not.toContain("'unsafe-eval'");
  });
});

describe("artifactAssetsOf (GH-335)", () => {
  const css = "text/css; charset=utf-8";
  it("map form: string and {from} sources, relative to root or cwd, absolute kept; contentType ignored", () => {
    const files = { "a.css": "s/a.css", "js/b.js": { from: "/abs/b.js", contentType: "x/y" }, "c.png": "c.png" };
    expect(artifactAssetsOf({ files, root: "site" }, "/c")).toEqual({
      assets: [
        { key: "a.css", path: resolve("/c", "site", "s/a.css"), type: css },
        { key: "js/b.js", path: resolve("/abs/b.js"), type: "text/javascript; charset=utf-8" },
        { key: "c.png", path: resolve("/c", "site", "c.png"), type: "image/png" },
      ],
      unavailable: [],
    });
    expect(artifactAssetsOf({ files }, "/c").assets[0]!.path).toBe(resolve("/c", "s/a.css"));
    expect(artifactAssetsOf({ files, root: "/r" }, "/c").assets[0]!.path).toBe(resolve("/r", "s/a.css"));
  });
  it("list form: published at its path, source under root", () => {
    const r = artifactAssetsOf({ files: [{ path: "a.css" }, { path: "img/b.png" }, 5, { nope: 1 }], root: "/r" }, "/c");
    expect(r.assets).toEqual([
      { key: "a.css", path: resolve("/r", "a.css"), type: css },
      { key: "img/b.png", path: resolve("/r", "img/b.png"), type: "image/png" },
    ]);
    expect(r.unavailable).toEqual(["5", "undefined"].map((x) => (x === "5" ? "5" : "[object Object]")));
  });
  it("a removed (null) entry is skipped, a copy from another artifact is unavailable", () => {
    const r = artifactAssetsOf({ files: { "r.css": null, "c.css": { artifact: "https://x", path: "a.css" }, "n.css": 5 } }, "/c");
    expect(r).toEqual({ assets: [], unavailable: ["c.css", "n.css"] });
  });
  it("unsafe published paths are unavailable; ./a.css is a.css", () => {
    const bad = ["../a.css", "/a.css", "a//b.css", "a\\b.css", "a\0.css", "", "a/../b.css"];
    const r = artifactAssetsOf({ files: Object.fromEntries([...bad, "./a.css"].map((k) => [k, "s.css"])) }, "/c");
    expect(r.assets.map((a) => a.key)).toEqual(["a.css"]);
    expect(r.unavailable).toHaveLength(bad.length);
  });
  it("types come from the published extension only", () => {
    const r = artifactAssetsOf({ files: { "a.html": "x", "a.htm": "x", "a.wasm": "x", "a.exe": "x", noext: "x", "A.CSS": "x" } }, "/c");
    expect(r.assets).toEqual([{ key: "A.CSS", path: resolve("/c", "x"), type: css }]);
    expect(r.unavailable).toEqual(["a.html", "a.htm", "a.wasm", "a.exe", "noext"]);
  });
  it("a source with NUL is unavailable", () => {
    expect(artifactAssetsOf({ files: { "a.css": "a\0b" } }, "/c")).toEqual({ assets: [], unavailable: ["a.css"] });
  });
  it("duplicate keys: first wins; more than the cap: the rest unavailable; non-object files: empty; bad root: all unavailable", () => {
    expect(artifactAssetsOf({ files: [{ path: "a.css" }, { path: "./a.css" }] }, "/c")).toMatchObject({ assets: [{ key: "a.css" }], unavailable: ["./a.css"] });
    const many = Object.fromEntries(Array.from({ length: ARTIFACT_ASSETS_MAX + 3 }, (_, i) => [`f${i}.css`, "s.css"]));
    const r = artifactAssetsOf({ files: many }, "/c");
    expect(r.assets).toHaveLength(ARTIFACT_ASSETS_MAX);
    expect(r.unavailable).toHaveLength(3);
    for (const files of [undefined, "x", 5, null]) expect(artifactAssetsOf({ files }, "/c")).toEqual({ assets: [], unavailable: [] });
    for (const root of [5, "", "a\0"]) expect(artifactAssetsOf({ files: { "a.css": "a.css" }, root }, "/c")).toEqual({ assets: [], unavailable: ["a.css"] });
  });
  it("artifactFileOf carries the assets of a done publish", () => {
    expect(artifactFileOf(call({ file_path: "/t/a.html", files: { "a.css": "/t/a.css" } }), "/c")).toEqual({
      path: resolve("/t/a.html"),
      title: "a.html",
      assets: [{ key: "a.css", path: resolve("/t/a.css"), type: css }],
      unavailable: [],
    });
    expect(artifactFileOf(call({ file_path: "/t/a.html", files: { "a.css": "x" } }, "error"), "/c")).toMatchObject({ code: "unknown_part" });
  });
});

describe("assetKey", () => {
  it("decodes each segment once", () => {
    expect(assetKey("img/a%20b.png")).toBe("img/a b.png");
    expect(assetKey("%252e%252e")).toBe("%2e%2e");
  });
  it("refuses traversal and encoded separators", () => {
    for (const p of ["..", "a/../b", "%2e%2e/x", ".%2e/x", "a%2fb", "a%2Fb", "a%5cb", "a\\b", "a%00b", "./a", "a//b", "/a", "a/", "%E0%A4%A", ""]) expect(assetKey(p), p).toBeUndefined();
  });
});

describe("artifactCsp", () => {
  const base = "http://127.0.0.1:1234/artifact/" + "a".repeat(32) + "/";
  const dirs = new Map(artifactCsp(base).split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]));
  it("without a base it is ARTIFACT_CSP", () => {
    expect(artifactCsp()).toBe(ARTIFACT_CSP);
    expect(artifactHeaders()).toEqual(ARTIFACT_HEADERS);
  });
  it("with a base: the base is the only http source, on script/style/img/font/media/connect only", () => {
    for (const k of ["script-src", "style-src", "img-src", "font-src", "media-src", "connect-src"]) expect(dirs.get(k), k).toContain(base);
    for (const [k, v] of dirs) {
      if (k === "frame-ancestors") continue;
      for (const s of v) if (s !== base) expect(s, k).not.toMatch(/^(https?:|\*|'self')/);
      if (!["script-src", "style-src", "img-src", "font-src", "media-src", "connect-src"].includes(k)) expect(v, k).not.toContain(base);
    }
    expect(dirs.get("sandbox")).toEqual(["allow-scripts"]);
    expect(dirs.get("default-src")).toEqual(["'none'"]);
    expect(dirs.get("script-src")).not.toContain("'unsafe-eval'");
    expect(artifactHeaders(base)["content-security-policy"]).toBe(artifactCsp(base));
  });
});

describe("ARTIFACT_ASSET_HEADERS / assetRequestAllowed", () => {
  it("is cross-origin readable by the opaque-origin page, inert as a document", () => {
    expect(ARTIFACT_ASSET_HEADERS["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(ARTIFACT_ASSET_HEADERS["access-control-allow-origin"]).toBe("null");
    expect(ARTIFACT_ASSET_HEADERS).not.toHaveProperty("access-control-allow-credentials");
    expect(ARTIFACT_ASSET_HEADERS["x-content-type-options"]).toBe("nosniff");
    expect(ARTIFACT_ASSET_HEADERS["cache-control"]).toBe("no-store");
    expect(ARTIFACT_ASSET_HEADERS["content-security-policy"]).toMatch(/^sandbox.*default-src 'none'/);
  });
  it("allows subresource loads only", () => {
    for (const dest of ["style", "script", "image", "font", "empty", "audio", "video", "track", undefined]) expect(assetRequestAllowed({ dest }, false), String(dest)).toBe(true);
    for (const dest of ["document", "iframe", "frame", "embed", "object", "worker", "serviceworker", "sharedworker", "manifest"]) expect(assetRequestAllowed({ dest }, false), dest).toBe(false);
    expect(assetRequestAllowed({ mode: "navigate" }, false)).toBe(false);
    expect(assetRequestAllowed({ origin: "http://evil.example" }, false)).toBe(false);
    expect(assetRequestAllowed({ origin: "null" }, false)).toBe(true);
    expect(assetRequestAllowed({ origin: "http://own" }, true)).toBe(true);
    expect(assetRequestAllowed({}, false)).toBe(true);
  });
});

describe("scratchpadOf", () => {
  const id = "36a77cf8-ba9a-48cd-b806-032f7e6b6ae8";
  it("matches the folders the CLI makes (slug: every non-alphanumeric of the cwd -> '-')", () => {
    expect(scratchpadOf("C:\\Users\\chnguyen\\IdeaProjects\\claude-code-ui", id, "C:\\Users\\chnguyen\\AppData\\Local\\Temp")).toBe(
      resolve("C:\\Users\\chnguyen\\AppData\\Local\\Temp", "claude", "C--Users-chnguyen-IdeaProjects-claude-code-ui", id, "scratchpad"),
    );
    expect(scratchpadOf("/home/a.b/my proj", id, "/tmp")).toBe(resolve("/tmp", "claude", "-home-a-b-my-proj", id, "scratchpad"));
  });
  it("is undefined for a slug over 200 characters (the CLI adds a hash) and for a session id that is not a uuid", () => {
    expect(scratchpadOf("/" + "a".repeat(201), id, "/tmp")).toBeUndefined();
    for (const bad of ["..", "../x", "", "A".repeat(36)]) expect(scratchpadOf("/p", bad, "/tmp")).toBeUndefined();
  });
});
