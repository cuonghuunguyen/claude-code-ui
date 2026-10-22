import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleBundle, bundleTargetOf, ensureParts, parseTarget, partsFor, sideCacheDir, TARGET_PROBE, writeTar, type Part } from "../src/side-bundle.ts";

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
    expect(readdirSync(dir).filter((f) => f.startsWith("node"))).toEqual([]);
  });

  it("offline with an empty cache fails naming the part; with a warm cache it works", async () => {
    const dir = tmp("parts-");
    await expect(ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch({}) })).rejects.toThrow(/could not download Node\.js/);
    await ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch(files) });
    await expect(ensureParts({ dir, parts: parts(), registry: "https://r", fetch: fakeFetch({}) })).resolves.toBeDefined();
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
  function makeBundle(home: string, o: { nodeFails?: boolean } = {}) {
    const w = mkdtempSync(join(tmpdir(), "bw-"));
    const nd = join(w, "n", B.nodeDir);
    mkdirSync(join(nd, "bin"), { recursive: true });
    // The fake Node.js: --version of the side passes (or fails), --side prints a marker.
    writeFileSync(join(nd, "bin", "node"), `#!/bin/sh\nfor a in "$@"; do case "$a" in --version) ${o.nodeFails ? "echo 'libstdc++.so.6: cannot open' >&2; exit 127" : "echo 1.2.3; exit 0"};; --side) echo "bundled side started"; exit 0;; esac; done\n`, { mode: 0o755 });
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
    return assembleBundle({ partFiles: { "node.tar.gz": join(w, "node.tar.gz"), "node-pty.tgz": join(w, "node-pty.tgz"), "sdk.tgz": join(w, "sdk.tgz"), "claude.tgz": join(w, "claude.tgz") }, sideDir: side, version: "1.2.3", outDir: home });
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
