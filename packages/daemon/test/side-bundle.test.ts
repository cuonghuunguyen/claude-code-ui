import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { NODE_MIN, nodeMinOf } from "@claude-ui/protocol";
import { describe, expect, it } from "vitest";
import { assembleBundle, bundleTargetOf, ensureParts, installMethodOf, markUsed, NODE_OK_JS, NODE_OK_TOKEN, parseTarget, partsCached, partsFor, probeFailReason, pruneCache, removeStale, sideCacheDir, TARGET_PROBE, USABLE_NODE_FN, writeTar, type Part } from "../src/side-bundle.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const hasTar = spawnSync("tar", ["--version"]).status === 0 && process.platform !== "win32";
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const sha512 = (b: Buffer | string) => `sha512-${createHash("sha512").update(b).digest("base64")}`;

describe("target", () => {
  it("parses the probe lines and skips noise", () => {
    expect(parseTarget("motd\nCLAUDE_UI_CHECK arch=x86_64\nCLAUDE_UI_CHECK libc=glibc\nCLAUDE_UI_CHECK glibc=2.36\nCLAUDE_UI_CHECK cxxrt=1\n")).toEqual({ arch: "x86_64", libc: "glibc", glibc: "2.36", cxxRuntime: true });
    expect(parseTarget("CLAUDE_UI_CHECK arch=aarch64\nCLAUDE_UI_CHECK libc=musl\nCLAUDE_UI_CHECK cxxrt=0\n")).toEqual({ arch: "aarch64", libc: "musl", cxxRuntime: false });
    expect(parseTarget("nothing")).toBeUndefined();
  });

  it("covers linux x64 and arm64 with glibc 2.28+ and libstdc++; any other container gets a reason", () => {
    const g = { libc: "glibc" as const, glibc: "2.36", cxxRuntime: true };
    expect(bundleTargetOf({ arch: "x86_64", ...g })).toEqual({ target: "linux-x64" });
    expect(bundleTargetOf({ arch: "amd64", ...g })).toEqual({ target: "linux-x64" });
    expect(bundleTargetOf({ arch: "aarch64", ...g })).toEqual({ target: "linux-arm64" });
    expect(bundleTargetOf({ arch: "arm64", ...g, glibc: "2.28" })).toEqual({ target: "linux-arm64" });
    expect(bundleTargetOf({ arch: "x86_64", libc: "musl", cxxRuntime: true })).toEqual({ reason: expect.stringMatching(/musl.*Alpine/) });
    expect(bundleTargetOf({ arch: "armv7l", ...g })).toEqual({ reason: expect.stringMatching(/armv7l/) });
    expect(bundleTargetOf({ arch: "x86_64", ...g, glibc: "2.17" })).toEqual({ reason: expect.stringMatching(/glibc 2\.17.*2\.28/) });
    expect(bundleTargetOf({ arch: "x86_64", ...g, cxxRuntime: false })).toEqual({ reason: expect.stringMatching(/libstdc\+\+/) });
    expect(bundleTargetOf({ arch: "x86_64", libc: "unknown", cxxRuntime: true })).toEqual({ reason: expect.stringMatching(/C library/) });
  });

  it("parses foundnode; installMethodOf picks found or pinned Node.js on the bundle path", () => {
    const g = "CLAUDE_UI_CHECK arch=x86_64\nCLAUDE_UI_CHECK libc=glibc\nCLAUDE_UI_CHECK glibc=2.36\nCLAUDE_UI_CHECK cxxrt=1\n";
    expect(installMethodOf(parseTarget(`${g}CLAUDE_UI_CHECK foundnode=1`), true)).toEqual({ method: "bundle", target: "linux-x64", node: "found" });
    expect(installMethodOf(parseTarget(`${g}CLAUDE_UI_CHECK foundnode=0`), true)).toMatchObject({ node: "pinned" });
    expect(installMethodOf(parseTarget(g), true)).toMatchObject({ node: "pinned" });
    expect(installMethodOf(parseTarget(g.replace("glibc\n", "musl\n") + "CLAUDE_UI_CHECK foundnode=1"), true)).toMatchObject({ method: "npm" });
  });

  it("NODE_MIN comes from engines.node; another shape throws", () => {
    expect(NODE_MIN).toBe(JSON.parse(readFileSync(new URL("../../claude-ui/package.json", import.meta.url), "utf8")).engines.node.replace(">=", ""));
    expect(nodeMinOf(">=22.1")).toBe("22.1");
    expect(() => nodeMinOf("^22")).toThrow(/engines\.node/);
  });

  describe("NODE_OK_JS (the rule the candidate node runs)", () => {
    const ok = (o: { v?: string; min?: string; arch?: string; want?: string; platform?: string; bun?: string; deno?: string }) => {
      let out: string | undefined;
      const process = { versions: { node: o.v ?? "22.0.0", ...(o.bun && { bun: o.bun }), ...(o.deno && { deno: o.deno }) }, argv: ["node", o.min ?? "22", o.want ?? ""], platform: o.platform ?? "linux", arch: o.arch ?? "x64", stdout: { write: (t: string) => (out = t) } };
      runInNewContext(NODE_OK_JS, { process });
      return out === NODE_OK_TOKEN;
    };
    it("version: full x.y.z compare against the minimum", () => {
      expect(ok({})).toBe(true);
      expect(ok({ v: "24.1.0" })).toBe(true);
      expect(ok({ v: "21.9.9" })).toBe(false);
      expect(ok({ v: "22.3.0", min: "22.4" })).toBe(false);
      expect(ok({ v: "22.4.1", min: "22.4.1" })).toBe(true);
    });
    it("platform linux, matching arch (when one is asked), no Bun or Deno", () => {
      expect(ok({ platform: "darwin" })).toBe(false);
      expect(ok({ want: "arm64", arch: "x64" })).toBe(false);
      expect(ok({ want: "arm64", arch: "arm64" })).toBe(true);
      expect(ok({ want: "", arch: "ia32" })).toBe(true);
      expect(ok({ bun: "1.1.0" })).toBe(false);
      expect(ok({ deno: "2.0.0" })).toBe(false);
    });
  });

  it("found Node.js: the parts leave Node.js out; pinned has it", () => {
    expect(partsFor("linux-x64", { sdkVersion: "0.3.285", node: "found" }).map((p) => p.file)).toEqual(["node-pty.tgz", "sdk.tgz", "claude.tgz"]);
    expect(partsFor("linux-x64", { sdkVersion: "0.3.285", node: "pinned" }).map((p) => p.file)).toContain("node.tar.gz");
  });

  it.skipIf(!hasTar)("usable_node: the real binary behind a shim; refuses a node that fails the rule or whose real path is not a runnable file", () => {
    const bin = tmp("un-");
    const real = join(bin, "real-node");
    const fake = (path: string, o: { exec: string; ok?: boolean }) => writeFileSync(path, `#!/bin/sh\ncase "$1" in -e) ${o.ok === false ? "echo no" : "echo claude-ui-node-ok"};; -p) echo '${o.exec}';; esac\n`, { mode: 0o755 });
    fake(real, { exec: real });
    const shim = join(bin, "shim");
    mkdirSync(shim);
    const n = (path: string) => spawnSync("sh", ["-c", `${USABLE_NODE_FN}; usable_node x64; echo "rc=$? n=$n"`], { encoding: "utf8", env: { PATH: `${path}:/usr/bin:/bin` } }).stdout.trim();
    fake(join(shim, "node"), { exec: real });
    expect(n(shim)).toBe(`rc=0 n=${real}`);
    fake(real, { exec: real, ok: false });
    expect(n(shim)).toBe("rc=1 n=");
    fake(real, { exec: real });
    fake(join(shim, "node"), { exec: join(bin, "missing") });
    expect(n(shim)).toBe("rc=1 n=");
    fake(join(shim, "node"), { exec: bin });
    expect(n(shim)).toBe("rc=1 n=");
    // A shim whose execPath is /bin/true exits 0 for every argument and prints nothing: not usable.
    fake(join(shim, "node"), { exec: "/bin/true" });
    expect(n(shim)).toBe("rc=1 n=");
    expect(n("/nonexistent")).toBe("rc=1 n=");
  });

  it.skipIf(!hasTar)("the probe runs in sh and reports this machine", () => {
    const out = execFileSync("sh", ["-c", TARGET_PROBE], { encoding: "utf8" });
    const t = parseTarget(out)!;
    expect(t.arch).toBe(execFileSync("uname", ["-m"], { encoding: "utf8" }).trim());
    expect(["glibc", "musl", "unknown"]).toContain(t.libc);
  });
});

describe("cache dir", () => {
  it("XDG_CACHE_HOME, else ~/.cache; Windows LOCALAPPDATA", () => {
    expect(sideCacheDir({ XDG_CACHE_HOME: "/c" }, "/home/u", "linux")).toBe(join("/c", "claude-ui", "side"));
    expect(sideCacheDir({}, "/home/u", "linux")).toBe(join("/home/u", ".cache", "claude-ui", "side"));
    expect(sideCacheDir({ LOCALAPPDATA: "C:\\L" }, "C:\\U", "win32")).toBe(join("C:\\L", "claude-ui", "cache", "side"));
  });
});

describe("parts", () => {
  it("node from nodejs.org (pinned sha256), node-pty and the Claude binary from the registry", () => {
    const p = partsFor("linux-arm64", { sdkVersion: "0.3.285" });
    expect(p.map((x) => x.file)).toEqual(["node.tar.gz", "node-pty.tgz", "sdk.tgz", "claude.tgz"]);
    expect(p[0]!.url).toMatch(/^https:\/\/nodejs\.org\/dist\/v\d+\.\d+\.\d+\/node-v\d+\.\d+\.\d+-linux-arm64\.tar\.gz$/);
    expect(p[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p[1]!.integrity).toMatch(/^sha512-/);
    expect(p[2]!.registryPackage).toEqual({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.285" });
    expect(p[3]!.registryPackage).toEqual({ name: "@anthropic-ai/claude-agent-sdk-linux-arm64", version: "0.3.285" });
    // Anthropic's packages: integrity from the registry, never pinned or re-hosted here.
    expect(p[2]!.integrity ?? p[3]!.integrity).toBeUndefined();
  });

  const fakeFetch = (files: Record<string, Buffer | string>, log: string[] = []) =>
    (async (url: string) => {
      log.push(String(url));
      const body = files[String(url)];
      if (body === undefined) throw new TypeError("fetch failed");
      return new Response(typeof body === "string" ? body : new Uint8Array(body), { status: 200 });
    }) as unknown as typeof fetch;

  const node = Buffer.from("node tarball");
  const parts = (): Part[] => [
    { file: "node.tar.gz", url: "https://n/node.tgz", sha256: sha256(node), label: "Node.js" },
    { file: "claude.tgz", registryPackage: { name: "@x/claude", version: "1.0.0" }, label: "Claude Code" },
  ];
  const claude = Buffer.from("claude tarball");
  const meta = JSON.stringify({ dist: { tarball: "https://r/claude.tgz", integrity: sha512(claude) } });
  const files = { "https://n/node.tgz": node, "https://r/@x%2fclaude/1.0.0": meta, "https://r/claude.tgz": claude };

  it("downloads, verifies and caches; a second run downloads nothing", async () => {
    const dir = tmp("parts-");
    const log: string[] = [];
    const phases: string[] = [];
    const got = await ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch(files, log), onDownload: () => phases.push("downloading") });
    expect(readFileSync(got["node.tar.gz"]!)).toEqual(node);
    expect(readFileSync(got["claude.tgz"]!)).toEqual(claude);
    expect(phases).toEqual(["downloading"]);
    log.length = 0;
    await ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch({}, log), onDownload: () => phases.push("again") });
    expect(log).toEqual([]);
    expect(phases).toEqual(["downloading"]);
  });

  it("concurrent calls for one folder share one run: one download per part, every caller announced, no .partial left", async () => {
    const dir = tmp("parts-");
    const log: string[] = [];
    const seen: string[] = [];
    const a = ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch(files, log), onDownload: () => seen.push("a") });
    const b = ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch(files, log), onDownload: () => seen.push("b") });
    expect(b).toBe(a);
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb).toEqual(ra);
    expect(seen.sort()).toEqual(["a", "b"]);
    expect(log.filter((l) => l === "https://n/node.tgz")).toHaveLength(1);
    expect(log.filter((l) => l === "https://r/claude.tgz")).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.includes(".partial"))).toEqual([]);
    // A later call after the run is a new run (the memo is released): cached, nothing downloaded.
    const again: string[] = [];
    await ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch({}, again) });
    expect(again).toEqual([]);
  });

  it("a found-mode and a pinned-mode call for one folder at once: the pinned caller gets node.tar.gz", async () => {
    const dir = tmp("parts-");
    const found = ensureParts({ dir, parts: parts().slice(1), registry: "https://r", fetch: fakeFetch(files) });
    const pinned = ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch(files) });
    const [rf, rp] = await Promise.all([found, pinned]);
    expect(Object.keys(rf)).toEqual(["claude.tgz"]);
    expect(Object.keys(rp).sort()).toEqual(["claude.tgz", "node.tar.gz"]);
  });

  it("a .partial left by a killed run is removed once it is an hour old; a fresh one stays", async () => {
    const dir = tmp("parts-");
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, "node.tar.gz.partial-1-1");
    const fresh = join(dir, "node.tar.gz.partial-2-1");
    writeFileSync(stale, "half");
    writeFileSync(fresh, "half");
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(stale, old, old);
    await ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch(files) });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("a corrupted cached part is downloaded again, never used", async () => {
    const dir = tmp("parts-");
    await ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch(files) });
    writeFileSync(join(dir, "node.tar.gz"), "corrupt");
    writeFileSync(join(dir, "claude.tgz"), "corrupt");
    const log: string[] = [];
    const got = await ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch(files, log) });
    expect(readFileSync(got["node.tar.gz"]!)).toEqual(node);
    expect(readFileSync(got["claude.tgz"]!)).toEqual(claude);
    expect(log).toContain("https://n/node.tgz");
    expect(log).toContain("https://r/claude.tgz");
  });

  it("a download that does not match its checksum is refused and not kept", async () => {
    const dir = tmp("parts-");
    await expect(ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch({ ...files, "https://n/node.tgz": "evil" }) })).rejects.toThrow(/Node\.js.*checksum/);
    await expect(ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch({ ...files, "https://n/node.tgz": "evil" }) })).rejects.toThrow(
      "the Node.js the host downloaded does not match its checksum (it was not used) and the host has no verified copy of it",
    );
    expect(readdirSync(dir).filter((f) => f.startsWith("node"))).toEqual([]);
  });

  it("offline with an empty cache fails naming the part; with a warm cache it works", async () => {
    const dir = tmp("parts-");
    await expect(ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch({}) })).rejects.toThrow("the host could not download Node.js (fetch failed) and has no verified copy of it");
    await ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch(files) });
    await expect(ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch({}) })).resolves.toBeDefined();
  });

  it("another process finishing the same part first: the run ends with a verified file and no .partial", async () => {
    const dir = tmp("parts-");
    const other = (async (url: string) => {
      // The other hub renames its finished part into place while this run still downloads.
      if (String(url) === "https://n/node.tgz") writeFileSync(join(dir, "node.tar.gz"), node);
      const body = files[String(url) as keyof typeof files];
      return new Response(typeof body === "string" ? body : new Uint8Array(body), { status: 200 });
    }) as unknown as typeof fetch;
    const got = await ensureParts({ dir, parts: parts(), registry: "https://r", fetch: other });
    expect(readFileSync(got["node.tar.gz"]!)).toEqual(node);
    expect(readdirSync(dir).filter((f) => f.includes(".partial"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a cache folder that cannot be written: could not keep the part in its cache", async () => {
    const dir = tmp("parts-");
    chmodSync(dir, 0o500);
    try {
      await expect(ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch(files) })).rejects.toThrow(/^the host could not keep Node\.js in its cache .* \(EACCES/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("a cache folder that is a file: could not keep the part in its cache", async () => {
    const root = tmp("parts-");
    writeFileSync(join(root, "f"), "x");
    await expect(ensureParts({ dir: join(root, "f"), parts: parts(), registry: "https://r", fetch: fakeFetch(files) })).rejects.toThrow(/^the host could not keep the parts in its cache /);
  });

  it("removeStale removes files with the prefix older than the age; others stay", () => {
    const dir = tmp("stale-");
    for (const n of ["bundle-old", "bundle-new", "other-old"]) writeFileSync(join(dir, n), "x");
    const old = new Date(Date.now() - 2 * 3_600_000);
    for (const n of ["bundle-old", "other-old"]) utimesSync(join(dir, n), old, old);
    removeStale(dir, "bundle-", 3_600_000);
    removeStale(join(dir, "missing"), "bundle-", 1);
    expect(readdirSync(dir).sort()).toEqual(["bundle-new", "other-old"]);
  });

  it("partsCached: every file there, and a registry part without a pinned integrity also has its .integrity; nothing is hashed", () => {
    const dir = tmp("parts-");
    expect(partsCached(dir, parts())).toBe(false);
    writeFileSync(join(dir, "node.tar.gz"), "not even the right bytes");
    writeFileSync(join(dir, "claude.tgz"), "x");
    expect(partsCached(dir, parts())).toBe(false);
    writeFileSync(join(dir, "claude.tgz.integrity"), sha512(claude));
    expect(partsCached(dir, parts())).toBe(true);
    expect(partsCached(join(dir, "none"), parts())).toBe(false);
  });

  it("probeFailReason: NUL stripped, last stderr line, no answer in time, exit code", () => {
    expect(probeFailReason({ code: null, stderr: "" }, "container")).toBe("the container did not answer the target probe (no answer in time)");
    expect(probeFailReason({ code: 1, stderr: "a\nW\0S\0L\0 failed.\n" }, "distro")).toBe("the distro did not answer the target probe (WSL failed)");
    expect(probeFailReason({ code: 126, stderr: "" }, "container")).toBe("the container did not answer the target probe (exit code 126)");
  });
});

// Deletes folders: only claude-ui's own side cache, never the current version's folder.
describe("pruneCache and markUsed", () => {
  const DAY = 24 * 3_600_000;
  const root = () => join(tmp("home-"), "claude-ui", "side");
  const folder = (cache: string, name: string, daysOld?: number, mark = false) => {
    const d = join(cache, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "part"), "x");
    const t = new Date(Date.now() - (daysOld ?? 0) * DAY);
    if (mark) (writeFileSync(join(d, ".used"), ""), utimesSync(join(d, ".used"), t, t));
    utimesSync(d, t, t);
    return d;
  };

  it("keeps the current version however old, and versions used within 7 days; removes older ones", () => {
    const c = root();
    folder(c, "1.0.0", 100);
    folder(c, "0.9.0", 3, true);
    folder(c, "0.8.0", 8, true);
    folder(c, "0.7.0", 30, true);
    pruneCache(c, "1.0.0");
    expect(readdirSync(c).sort()).toEqual(["0.9.0", "1.0.0"]);
  });

  it("the .used mark decides, else the folder's own time (a cache of an older build)", () => {
    const c = root();
    folder(c, "recent-mark-old-folder", 30);
    writeFileSync(join(c, "recent-mark-old-folder", ".used"), "");
    folder(c, "old-mark-new-folder", 20, true);
    utimesSync(join(c, "old-mark-new-folder"), new Date(), new Date());
    folder(c, "no-mark-old", 8);
    folder(c, "no-mark-new", 1);
    pruneCache(c, "1.0.0");
    expect(readdirSync(c).sort()).toEqual(["no-mark-new", "recent-mark-old-folder"]);
  });

  it("the now argument moves the cut-off", () => {
    const c = root();
    folder(c, "0.9.0", 3, true);
    pruneCache(c, "1.0.0", Date.now() + 5 * DAY);
    expect(readdirSync(c)).toEqual([]);
  });

  it("touches nothing outside the cache folder: files, symlinks (and their targets), siblings and the parent", () => {
    const c = root();
    const outside = folder(join(c, ".."), "outside", 100);
    const target = folder(tmp("target-"), "precious", 100);
    folder(c, "0.8.0", 100);
    writeFileSync(join(c, "loose-file"), "x");
    symlinkSync(target, join(c, "link"), "dir");
    pruneCache(c, "1.0.0");
    expect(existsSync(join(target, "part"))).toBe(true);
    expect(existsSync(join(outside, "part"))).toBe(true);
    expect(existsSync(join(c, "loose-file"))).toBe(true);
    expect(lstatSync(join(c, "link")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(c, "0.8.0"))).toBe(false);
  });

  it("refuses a folder that is not claude-ui's side cache, and an empty keep: nothing is removed", () => {
    const home = tmp("home-");
    for (const bad of [home, join(home, "Documents"), join(home, ".cache"), join(home, "side"), join(home, "other", "side"), join(home, "claude-ui")]) {
      folder(bad, "old", 100);
      pruneCache(bad, "1.0.0");
      expect(existsSync(join(bad, "old", "part"))).toBe(true);
    }
    const c = root();
    folder(c, "old", 100);
    pruneCache(c, "");
    expect(existsSync(join(c, "old", "part"))).toBe(true);
    expect(() => pruneCache(join(c, "missing"), "1.0.0")).not.toThrow();
  });

  it("the real cache location passes the guard (Linux, macOS and Windows forms)", () => {
    for (const p of ["linux", "darwin", "win32"] as const) {
      const base = tmp("home-");
      const c = sideCacheDir({ XDG_CACHE_HOME: join(base, "xdg"), LOCALAPPDATA: join(base, "local") }, base, p);
      folder(c, "0.8.0", 100);
      pruneCache(c, "1.0.0");
      expect(existsSync(c) && readdirSync(c)).toEqual([]);
    }
  });

  it("markUsed writes <root>/<version>/.used (refreshed on a later call) and never throws", () => {
    const c = root();
    markUsed(c, "1.0.0");
    const mark = join(c, "1.0.0", ".used");
    expect(existsSync(mark)).toBe(true);
    const old = new Date(Date.now() - 5 * DAY);
    utimesSync(mark, old, old);
    markUsed(c, "1.0.0");
    expect(Date.now() - lstatSync(mark).mtimeMs).toBeLessThan(60_000);
    const file = join(tmp("f-"), "file");
    writeFileSync(file, "x");
    expect(() => markUsed(join(file, "sub"), "1.0.0")).not.toThrow();
  });
});

describe.skipIf(!hasTar)("tar", () => {
  it("writes a ustar archive tar can list and extract", async () => {
    const d = tmp("tar-");
    writeFileSync(join(d, "a.bin"), Buffer.alloc(1000, 7));
    writeFileSync(join(d, "b.txt"), "hello");
    const out = join(d, "x.tar");
    await writeTar(out, [
      { name: "a.bin", path: join(d, "a.bin") },
      { name: "app/dist/b.txt", path: join(d, "b.txt") },
      { name: "app/package.json", data: Buffer.from('{"v":1}') },
    ]);
    expect(execFileSync("tar", ["-tf", out], { encoding: "utf8" }).trim().split("\n")).toEqual(["a.bin", "app/dist/b.txt", "app/package.json"]);
    const x = join(d, "x");
    mkdirSync(x);
    execFileSync("tar", ["-xf", out, "-C", x]);
    expect(readFileSync(join(x, "app/dist/b.txt"), "utf8")).toBe("hello");
    expect(readFileSync(join(x, "a.bin")).length).toBe(1000);
  });

  it("assembles parts, the side JS and a package.json into one tar", async () => {
    const d = tmp("asm-");
    const side = join(d, "side");
    mkdirSync(side);
    for (const f of ["cli.js", "chunk-1.js", "THIRD_PARTY_LICENSES.txt"]) writeFileSync(join(side, f), f);
    writeFileSync(join(side, "side.json"), "{}");
    const partFiles = Object.fromEntries(["node.tar.gz", "node-pty.tgz", "claude.tgz"].map((f) => (writeFileSync(join(d, f), f), [f, join(d, f)])));
    const out = await assembleBundle({ partFiles, sideDir: side, version: "1.2.3", outDir: d });
    const names = execFileSync("tar", ["-tf", out], { encoding: "utf8" }).trim().split("\n").sort();
    expect(names).toEqual(["app/dist/THIRD_PARTY_LICENSES.txt", "app/dist/chunk-1.js", "app/dist/cli.js", "app/package.json", "claude.tgz", "node-pty.tgz", "node.tar.gz"]);
    const x = join(d, "x");
    mkdirSync(x);
    execFileSync("tar", ["-xf", out, "-C", x]);
    expect(JSON.parse(readFileSync(join(x, "app/package.json"), "utf8"))).toEqual({ name: "claude-code-ui", version: "1.2.3", type: "module" });
    expect(existsSync(join(x, "app/dist/side.json"))).toBe(false);
  });
});

describe.skipIf(!hasTar)("bundle setup script in sh (fake HOME, fake Node.js)", () => {
  const KEY = "1.2.3-1";
  const B = { target: "linux-x64" as const, nodeDir: "node-v9.9.9-linux-x64", claudePackage: "claude-agent-sdk-linux-x64" };
  function makeBundle(home: string, o: { nodeFails?: boolean; noNode?: boolean; silent?: boolean } = {}) {
    const w = mkdtempSync(join(tmpdir(), "bw-"));
    const nd = join(w, "n", B.nodeDir);
    mkdirSync(join(nd, "bin"), { recursive: true });
    // The fake Node.js: --version of the side passes (or fails), --side prints a marker.
    writeFileSync(join(nd, "bin", "node"), `#!/bin/sh\nfor a in "$@"; do case "$a" in --version) ${o.nodeFails ? "echo 'libstdc++.so.6: cannot open' >&2; exit 127" : o.silent ? "exit 0" : "echo 1.2.3; exit 0"};; --side) echo "bundled side started"; exit 0;; esac; done\n`, { mode: 0o755 });
    writeFileSync(join(nd, "LICENSE"), "node license");
    writeFileSync(join(nd, "bin", "npm"), "unused");
    execFileSync("tar", ["-czf", join(w, "node.tar.gz"), "-C", join(w, "n"), B.nodeDir]);
    for (const [pkg, files] of [
      ["pty", { "package.json": "{}", "prebuilds/linux-x64/pty.node": "x", "prebuilds/win32-x64/conpty.node": "x" }],
      ["claude", { "package.json": "{}", claude: "bin" }],
      ["sdk", { "package.json": "{}", "sdk.mjs": "" }],
    ] as const) {
      for (const [f, c] of Object.entries(files)) (mkdirSync(join(w, pkg, "package", f, ".."), { recursive: true }), writeFileSync(join(w, pkg, "package", f), c));
      execFileSync("tar", ["-czf", join(w, pkg === "pty" ? "node-pty.tgz" : `${pkg}.tgz`), "-C", join(w, pkg), "package"]);
    }
    const side = join(w, "side");
    mkdirSync(side);
    writeFileSync(join(side, "cli.js"), "side");
    return assembleBundle({ partFiles: { ...(!o.noNode && { "node.tar.gz": join(w, "node.tar.gz") }), "node-pty.tgz": join(w, "node-pty.tgz"), "sdk.tgz": join(w, "sdk.tgz"), "claude.tgz": join(w, "claude.tgz") }, sideDir: side, version: "1.2.3", outDir: home });
  }
  const run = (home: string, script: string) => spawnSync("sh", ["-c", script], { cwd: home, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home, ANTHROPIC_API_KEY: "x" } });

  it("unpacks without Node.js, npm or build tools, keeps this target's prebuild only, runs the side on its own Node.js", async () => {
    const { setupScript } = await import("../src/sides.ts");
    const home = tmp("bh-");
    const tar = await makeBundle(home);
    const r = run(home, setupScript(tar, KEY, "docker", "needed", B));
    expect(r.stdout).toContain("CLAUDE_UI_PHASE installing");
    expect(r.stdout).toContain("bundled side started");
    const dir = join(home, ".local/share/claude-ui/side", KEY);
    expect(existsSync(join(dir, "node/bin/node"))).toBe(true);
    expect(existsSync(join(dir, "node/bin/npm"))).toBe(false);
    expect(readdirSync(join(dir, "node_modules/node-pty/prebuilds"))).toEqual(["linux-x64"]);
    expect(existsSync(join(dir, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"))).toBe(true);
    expect(existsSync(join(dir, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"))).toBe(true);
    expect(readFileSync(join(dir, "node_modules/claude-code-ui/dist/cli.js"), "utf8")).toBe("side");
    expect(existsSync(tar)).toBe(false);
    // needed again: installed, nothing unpacked; never (no Node.js in PATH needed): runs the bundled one.
    const again = run(home, setupScript(tar, KEY, "docker", "needed", B));
    expect(again.stdout).not.toContain("installing");
    expect(again.stdout).toContain("bundled side started");
    const never = spawnSync("sh", ["-c", setupScript("", KEY, "docker", "never")], { cwd: home, encoding: "utf8", env: { PATH: "/nonexistent:/bin", HOME: home, ANTHROPIC_API_KEY: "x" } });
    expect(never.stdout).toContain("bundled side started");
  });

  describe("found Node.js", () => {
    const F = { target: "linux-x64" as const, claudePackage: "claude-agent-sdk-linux-x64" };
    /** A node on PATH that passes the usable_node rule and answers the side's --version and --side. */
    const nodeIn = () => {
      const bin = tmp("fn-");
      writeFileSync(join(bin, "node"), `#!/bin/sh\ncase "$1" in -e) echo claude-ui-node-ok;; -p) echo "$0";; esac\nfor a in "$@"; do case "$a" in --version) echo 1.2.3; exit 0;; --side) echo "found node side started"; exit 0;; esac; done\n`, { mode: 0o755 });
      return bin;
    };
    const runOn = (home: string, script: string, path: string) => spawnSync("sh", ["-c", script], { cwd: home, encoding: "utf8", env: { PATH: `${path}:/usr/bin:/bin`, HOME: home, ANTHROPIC_API_KEY: "x" } });
    const sideDir = (home: string) => join(home, ".local/share/claude-ui/side", KEY);

    it("unpacks without node/, runs the side on the found Node.js", async () => {
      const { setupScript } = await import("../src/sides.ts");
      const home = tmp("bh-");
      const tar = await makeBundle(home, { noNode: true });
      const r = runOn(home, setupScript(tar, KEY, "docker", "needed", F), nodeIn());
      expect(r.stdout).toContain("CLAUDE_UI_PHASE installing");
      expect(r.stdout).toContain("found node side started");
      expect(existsSync(join(sideDir(home), "node"))).toBe(false);
      expect(existsSync(join(sideDir(home), "node_modules/node-pty/prebuilds/linux-x64/pty.node"))).toBe(true);
    });

    it("the new install must print a version: a node that exits 0 and prints nothing is node_unusable (found) or install_failed (pinned), never swapped in", async () => {
      const { setupScript } = await import("../src/sides.ts");
      const silent = tmp("fs-");
      writeFileSync(join(silent, "node"), `#!/bin/sh\ncase "$1" in -e) echo claude-ui-node-ok;; -p) echo "$0";; esac\nexit 0\n`, { mode: 0o755 });
      const home = tmp("bh-");
      const tar = await makeBundle(home, { noNode: true });
      const r = runOn(home, setupScript(tar, KEY, "docker", "needed", F), silent);
      expect(r.stdout).toMatch(/^CLAUDE_UI_SETUP node_unusable/m);
      expect(existsSync(sideDir(home))).toBe(false);
      expect(existsSync(tar)).toBe(false);
      // Pinned: its own node exits 0 and prints nothing for --version: install_failed, old install untouched.
      const home2 = tmp("bh-");
      const r2 = run(home2, setupScript(await makeBundle(home2, { silent: true }), KEY, "docker", "needed", B));
      expect(r2.stdout).toMatch(/^CLAUDE_UI_SETUP install_failed the new install does not start/m);
      expect(existsSync(sideDir(home2))).toBe(false);
    });

    it("an install made with the found Node.js is installed again with the pinned one when the Node.js is gone", async () => {
      const { setupScript } = await import("../src/sides.ts");
      const home = tmp("bh-");
      runOn(home, setupScript(await makeBundle(home, { noNode: true }), KEY, "docker", "needed", F), nodeIn());
      const r = runOn(home, setupScript(await makeBundle(home), KEY, "docker", "needed", B), "/nonexistent");
      expect(r.stdout).toContain("CLAUDE_UI_PHASE installing");
      expect(r.stdout).toContain("bundled side started");
      expect(existsSync(join(sideDir(home), "node/bin/node"))).toBe(true);
    });

    it("a pinned install is kept when the container gains Node.js 22+", async () => {
      const { setupScript } = await import("../src/sides.ts");
      const home = tmp("bh-");
      run(home, setupScript(await makeBundle(home), KEY, "docker", "needed", B));
      const r = runOn(home, setupScript(await makeBundle(home, { noNode: true }), KEY, "docker", "needed", F), nodeIn());
      expect(r.stdout).not.toContain("installing");
      expect(r.stdout).toContain("bundled side started");
    });

    it("the Node.js is gone between the probe and the start: node_changed, nothing installed", async () => {
      const { setupScript } = await import("../src/sides.ts");
      const home = tmp("bh-");
      const tar = await makeBundle(home, { noNode: true });
      const r = runOn(home, setupScript(tar, KEY, "docker", "needed", F), "/nonexistent");
      expect(r.stdout).toContain("CLAUDE_UI_SETUP node_changed");
      expect(existsSync(tar)).toBe(false);
      expect(existsSync(join(home, ".local/share/claude-ui/side"))).toBe(false);
    });
  });

  it("a bundle that does not start is never swapped in; the old install stays", async () => {
    const { setupScript } = await import("../src/sides.ts");
    const home = tmp("bh-");
    const good = await makeBundle(home);
    run(home, setupScript(good, KEY, "docker", "needed", B));
    const bad = await makeBundle(home, { nodeFails: true });
    const r = run(home, setupScript(bad, KEY, "docker", "force", B));
    expect(r.stdout).toMatch(/CLAUDE_UI_SETUP install_failed the new install does not start: libstdc\+\+/);
    expect(readdirSync(join(home, ".local/share/claude-ui/side"))).toEqual([KEY]);
    expect(existsSync(bad)).toBe(false);
  });
});
