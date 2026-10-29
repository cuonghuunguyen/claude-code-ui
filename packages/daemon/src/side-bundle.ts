// The Docker side bundle (docs/spec.md "Sides"): the hub assembles, per target (linux-x64, linux-arm64, glibc), one tar with
// everything the side runs on, so the container needs no Node.js, npm, network or build tools. Parts, each fetched from its
// official source and checked before any use (also when cached): the Node.js runtime (nodejs.org, pinned version and SHA-256 from
// its SHASUMS256.txt), node-pty with its Linux N-API prebuilds (npm registry, pinned sha512 integrity) and the Claude Code binary
// and the Agent SDK's JS (`@anthropic-ai/claude-agent-sdk-linux-<arch>` and `@anthropic-ai/claude-agent-sdk` of the SDK version
// this build was made with, npm registry, the registry's integrity). The side JS is this build's dist/side (build.mjs), with its
// inlined packages' license texts. Nothing is re-hosted: the hub downloads, the container gets a copy.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NODE_MIN } from "@claude-ui/protocol";
import { REGISTRY } from "./update.ts";

export type BundleTarget = "linux-x64" | "linux-arm64";

/** Node.js runtime of the bundle. SHA-256 values from https://nodejs.org/dist/v<version>/SHASUMS256.txt (update both on a bump). */
export const NODE = {
  version: "24.22.1",
  sha256: {
    "linux-x64": "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c",
    "linux-arm64": "33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3",
  } satisfies Record<BundleTarget, string>,
};
/** node-pty with Linux prebuilds (N-API, glibc 2.28+) in its npm tarball; the hub's own node-pty 1.1.0 has none for Linux. */
export const PTY = { name: "node-pty", version: "1.2.0-beta.15", integrity: "sha512-vORSzHXi4Ofl7HemVWpuudLqCPdaQb4LfpRCUpE5HPxhp4JYscl8zZwxh11p26v2wvW24WMwnMfLjhRLixrfxA==" };
/** Oldest glibc the Node.js and node-pty binaries run on. */
const MIN_GLIBC = [2, 28] as const;

/**
 * Read-only sh lines that print the container's target as `CLAUDE_UI_CHECK` lines: arch (`uname -m`), libc (glibc, musl,
 * unknown), the glibc version and whether libstdc++ (the C++ runtime Node.js and node-pty link) is there. Part of the check script.
 */
const TARGET_PROBE_BASE = [
  "emit() { printf 'CLAUDE_UI_CHECK %s=%s\\n' \"$1\" \"$2\"; }",
  'emit arch "$(uname -m 2>/dev/null)"',
  'g=$(getconf GNU_LIBC_VERSION 2>/dev/null); m=; for f in /lib/ld-musl-* /usr/lib/ld-musl-*; do [ -e "$f" ] && m=1; done',
  'if [ -n "$g" ]; then emit libc glibc; emit glibc "${g#glibc }"',
  'elif [ -n "$m" ] || ldd --version 2>&1 | grep -qi musl; then emit libc musl',
  "elif v=$(ldd --version 2>&1 | head -n 1 | grep -o '[0-9][0-9]*\\.[0-9][0-9]*$') && [ -n \"$v\" ]; then emit libc glibc; emit glibc \"$v\"",
  "else emit libc unknown; fi",
  'c=0; for f in /lib/*/libstdc++.so.6 /usr/lib/*/libstdc++.so.6 /lib64/libstdc++.so.6 /usr/lib64/libstdc++.so.6 /lib/libstdc++.so.6 /usr/lib/libstdc++.so.6; do [ -e "$f" ] && c=1; done; emit cxxrt "$c"',
];

/** nvm, as the setup script of a container sources it (a WSL distro's bash -lic reads .bashrc itself). One line for setup, check and probe. */
export const NVM_LINE = 'nvm="${NVM_DIR:-$HOME/.nvm}/nvm.sh"; [ -s "$nvm" ] && . "$nvm" >/dev/null 2>&1';

/**
 * Run by the candidate node itself (`node -e`, args: minimum version, arch or ""): prints NODE_OK_TOKEN when it is in range, on Linux, of the
 * bundle's arch (node-pty ships x64 and arm64 prebuilds only) and no Bun or Deno answering to the name `node`.
 */
export const NODE_OK_JS =
  'const v=process.versions,a=v.node.split(".").map(Number),m=process.argv[1].split(".").map(Number);let c=0;for(let i=0;i<3&&!c;i++)c=(a[i]||0)-(m[i]||0);process.stdout.write(c>=0&&process.platform==="linux"&&(!process.argv[2]||process.arch===process.argv[2])&&!v.bun&&!v.deno?"claude-ui-node-ok":"no")';
/** What NODE_OK_JS prints: the shell compares the output, not the exit code (a shim whose execPath is /bin/true exits 0 and prints nothing). */
export const NODE_OK_TOKEN = "claude-ui-node-ok";
/** `ver <node> <cli.js>`: the side's `--version` must print a version (a digit first), not just exit 0. */
export const VER_FN = 'ver() { case "$("$1" "$2" --version 2>/dev/null)" in [0-9]*) return 0;; esac; return 1; }';

/**
 * `usable_node <arch>`: sets `n` to the real binary of the `node` found by `command -v` (its `process.execPath`, not a shim) when
 * that is a regular executable that runs by itself and passes NODE_OK_JS; else fails with `n` empty. The side later runs `$n` directly.
 */
export const USABLE_NODE_FN = `usable_node() { n=; command -v node >/dev/null 2>&1 || return 1; p=$(node -p process.execPath 2>/dev/null) && [ -f "$p" ] && [ -x "$p" ] && [ "$("$p" -e '${NODE_OK_JS}' '${NODE_MIN}' "$1" 2>/dev/null)" = '${NODE_OK_TOKEN}' ] && n=$p; }`;
/** The arch name of the bundle target as `process.arch` says it (empty: unknown, no arch check). */
const NODE_ARCH_LINES = 'case "$(uname -m)" in x86_64|amd64) na=x64;; aarch64|arm64) na=arm64;; *) na=;; esac';
const NODE_PROBE_LINES = [USABLE_NODE_FN, NODE_ARCH_LINES, 'usable_node "$na" && emit foundnode 1 || emit foundnode 0'];
export const TARGET_PROBE_LINES = [...TARGET_PROBE_BASE, ...NODE_PROBE_LINES];
export const TARGET_PROBE = TARGET_PROBE_LINES.join("\n");
/** The probe of a container: nvm first, like its setup script. */
export const DOCKER_PROBE = [NVM_LINE, ...TARGET_PROBE_LINES].join("\n");

export type ContainerTarget = { arch: string; libc: "glibc" | "musl" | "unknown"; glibc?: string; cxxRuntime: boolean; /** A Node.js in range is in the target (the bundle then leaves its own out). */ node?: boolean };

/** The target from `CLAUDE_UI_CHECK` lines (other lines are shell noise); undefined without an arch line. */
export function parseTarget(out: string): ContainerTarget | undefined {
  const kv = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^CLAUDE_UI_CHECK ([a-zA-Z0-9]+)=(.*)$/.exec(line.trim());
    if (m) kv.set(m[1]!, m[2]!.trim());
  }
  const arch = kv.get("arch");
  if (!arch) return undefined;
  const libc = kv.get("libc");
  return { arch, libc: libc === "glibc" || libc === "musl" ? libc : "unknown", ...(kv.get("glibc") && { glibc: kv.get("glibc") }), cxxRuntime: kv.get("cxxrt") === "1", ...(kv.has("foundnode") && { node: kv.get("foundnode") === "1" }) };
}

/** The bundle that runs in a container, or why none does (a plain phrase: "the container uses musl ..."): then the side installs with npm. */
export function bundleTargetOf(t: Partial<ContainerTarget>, noun: "container" | "distro" = "container"): { target: BundleTarget } | { reason: string } {
  const arch = t.arch === "x86_64" || t.arch === "amd64" ? "x64" : t.arch === "aarch64" || t.arch === "arm64" ? "arm64" : undefined;
  if (!arch) return { reason: `the ${noun}'s CPU (${t.arch || "unknown"}) has no bundle (x86_64 and aarch64 only)` };
  if (t.libc === "musl") return { reason: `the ${noun} uses musl (for example Alpine); the bundle needs glibc` };
  if (t.libc !== "glibc") return { reason: `the ${noun}'s C library could not be detected; the bundle needs glibc` };
  const [maj, min] = (t.glibc ?? "").split(".").map(Number);
  if (maj === undefined || min === undefined || Number.isNaN(maj) || Number.isNaN(min) || maj < MIN_GLIBC[0] || (maj === MIN_GLIBC[0] && min < MIN_GLIBC[1]))
    return { reason: `the ${noun}'s glibc ${t.glibc || "version is unknown"}${t.glibc ? " is older than" : "; the bundle needs"} ${MIN_GLIBC.join(".")}` };
  if (!t.cxxRuntime) return { reason: `the ${noun} has no libstdc++ (the C++ runtime Node.js needs)` };
  return { target: `linux-${arch}` };
}

/** Why a container or distro installs with npm when the bundle is not used, or the bundle target. `build`: this claude-ui's dist/side. */
export function installMethodOf(target: Partial<ContainerTarget> | undefined, build: boolean, noun: "container" | "distro" = "container"): { method: "bundle"; target: BundleTarget; node: "found" | "pinned" } | { method: "npm"; reason: string } {
  if (!build) return { method: "npm", reason: `this claude-ui build has no ${noun} bundle (build it again with npm start or npm run build)` };
  const t = bundleTargetOf(target ?? {}, noun);
  return "target" in t ? { method: "bundle", target: t.target, node: target?.node ? "found" : "pinned" } : { method: "npm", reason: t.reason };
}

/** Where the hub keeps verified parts: `$XDG_CACHE_HOME/claude-ui/side` (default ~/.cache), Windows `%LOCALAPPDATA%\claude-ui\cache\side`. */
export function sideCacheDir(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "claude-ui", "cache", "side");
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "claude-ui", "side");
}

/** One downloaded part: a fixed URL with a pinned SHA-256, or a registry package (pinned integrity, else the registry's). */
export type Part = { file: string; label: string; url?: string; sha256?: string; integrity?: string; registryPackage?: { name: string; version: string } };

export const nodeDirName = (target: BundleTarget) => `node-v${NODE.version}-${target}`;
export const claudePackage = (target: BundleTarget) => `claude-agent-sdk-${target}`;

/** `node: "found"`: the target has its own Node.js in range, so the Node.js part is left out (nothing is fetched from nodejs.org). */
export function partsFor(target: BundleTarget, o: { sdkVersion: string; node?: "found" | "pinned" }): Part[] {
  return [
    ...(o.node === "found" ? [] : [{ file: "node.tar.gz", label: "Node.js", url: `https://nodejs.org/dist/v${NODE.version}/${nodeDirName(target)}.tar.gz`, sha256: NODE.sha256[target] }]),
    { file: "node-pty.tgz", label: "node-pty", registryPackage: { name: PTY.name, version: PTY.version }, integrity: PTY.integrity },
    { file: "sdk.tgz", label: "the Claude Agent SDK", registryPackage: { name: "@anthropic-ai/claude-agent-sdk", version: o.sdkVersion } },
    { file: "claude.tgz", label: "Claude Code", registryPackage: { name: `@anthropic-ai/${claudePackage(target)}`, version: o.sdkVersion } },
  ];
}

async function hashOf(file: string, algo: "sha256" | "sha512") {
  const h = createHash(algo);
  await pipeline(createReadStream(file), h);
  return h.digest(algo === "sha256" ? "hex" : "base64");
}
/** Whether `file` matches the part's checksum (sha256 hex, or an `sha512-<base64>` integrity). */
async function matches(file: string, c: { sha256?: string; integrity?: string }) {
  if (c.sha256) return (await hashOf(file, "sha256")) === c.sha256;
  const m = /^sha512-(.+)$/.exec(c.integrity ?? "");
  return !!m && (await hashOf(file, "sha512")) === m[1];
}

const DOWNLOAD_MS = 15 * 60_000;
async function download(f: typeof fetch, url: string, to: string) {
  const r = await f(url, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body as import("node:stream/web").ReadableStream), createWriteStream(to));
}

/**
 * Makes every part present and verified in `dir`: a cached part that matches is used as it is; a missing or mismatching one is
 * downloaded (`onDownload` once, before the first download) into a `.partial` file, checked, then renamed. A registry part's
 * integrity comes from the pin or from the registry (kept as `<file>.integrity` so a cached part is checked offline too).
 * Rejects with "could not download <label>" (network) or "<label> ... checksum" (mismatch); a bad file is never kept.
 * Concurrent calls for the same `dir` and the same parts (two distros, a distro and a container) share one run: each caller's `onDownload` is
 * called once when that run starts a download. The `.partial` file name is unique per run.
 */
export function ensureParts(o: { dir: string; parts: Part[]; registry?: string; fetch?: typeof fetch; onDownload?: () => void }): Promise<Record<string, string>> {
  const key = `${resolve(o.dir)}|${o.parts.map((p) => p.file).join(",")}`;
  const running = inflight.get(key);
  if (running) {
    if (running.announced) o.onDownload?.();
    else if (o.onDownload) running.listeners.push(o.onDownload);
    return running.promise;
  }
  const entry: { announced: boolean; listeners: (() => void)[]; promise: Promise<Record<string, string>> } = { announced: false, listeners: o.onDownload ? [o.onDownload] : [], promise: undefined as never };
  entry.promise = ensureOnce({ ...o, onDownload: () => ((entry.announced = true), entry.listeners.forEach((l) => l())) }).finally(() => inflight.delete(key));
  inflight.set(key, entry);
  return entry.promise;
}
const inflight = new Map<string, { announced: boolean; listeners: (() => void)[]; promise: Promise<Record<string, string>> }>();
let partialSeq = 0;

async function ensureOnce(o: { dir: string; parts: Part[]; registry?: string; fetch?: typeof fetch; onDownload?: () => void }): Promise<Record<string, string>> {
  const f = o.fetch ?? fetch;
  const registry = (o.registry ?? REGISTRY).replace(/\/+$/, "");
  mkdirSync(o.dir, { recursive: true });
  const out: Record<string, string> = {};
  let announced = false;
  for (const p of o.parts) {
    const file = join(o.dir, p.file);
    const saved = join(o.dir, `${p.file}.integrity`);
    const partial = `${file}.partial-${process.pid}-${++partialSeq}`;
    const known = p.sha256 || p.integrity ? { sha256: p.sha256, integrity: p.integrity } : existsSync(saved) ? { integrity: readFileSync(saved, "utf8").trim() } : undefined;
    if (known && existsSync(file) && (await matches(file, known))) {
      out[p.file] = file;
      continue;
    }
    if (!announced) (announced = true), o.onDownload?.();
    // Leftovers of a run that was killed mid-download (unique names, so nothing overwrites them); an hour old: no live run writes it.
    for (const n of readdirSync(o.dir)) if (n.startsWith(`${p.file}.partial-`) && Date.now() - statSync(join(o.dir, n)).mtimeMs > 3_600_000) rmSync(join(o.dir, n), { force: true });
    let url = p.url;
    let check = known && (p.sha256 || p.integrity) ? known : undefined;
    try {
      if (p.registryPackage) {
        const r = await f(`${registry}/${p.registryPackage.name.replace("/", "%2f")}/${p.registryPackage.version}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const meta = (await r.json()) as { dist?: { tarball?: string; integrity?: string } };
        url = meta.dist?.tarball;
        if (!url || !/^https?:\/\//.test(url)) throw new Error("the registry answer has no tarball");
        // A pinned integrity wins over the registry's.
        if (!check) {
          if (!meta.dist?.integrity?.startsWith("sha512-")) throw new Error("the registry answer has no sha512 integrity");
          check = { integrity: meta.dist.integrity };
        }
      }
      await download(f, url!, partial);
    } catch (e) {
      rmSync(partial, { force: true });
      throw new Error(`could not download ${p.label} (${(e as Error).message.replace(/\.$/, "")})`);
    }
    if (!check || !(await matches(partial, check))) {
      rmSync(partial, { force: true });
      throw new Error(`the downloaded ${p.label} does not match its checksum; it was not used`);
    }
    rmSync(file, { force: true });
    renameSync(partial, file);
    if (!p.sha256 && !p.integrity) writeFileSync(saved, check.integrity!);
    out[p.file] = file;
  }
  return out;
}

/** One tar entry: a file on disk or bytes. Names are ASCII, at most 100 characters. */
export type TarEntry = { name: string; path?: string; data?: Buffer };

function tarHeader(name: string, size: number) {
  if (Buffer.byteLength(name) > 100 || !/^[\x20-\x7e]+$/.test(name)) throw new Error(`tar: bad name ${name}`);
  const h = Buffer.alloc(512);
  const put = (s: string, at: number, len: number) => h.write(s, at, len, "ascii");
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(name, 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

/** Writes a plain (uncompressed) ustar archive: regular files only. */
export async function writeTar(out: string, entries: TarEntry[]) {
  const ws = createWriteStream(out);
  const write = (b: Buffer) => new Promise<void>((res, rej) => ws.write(b, (e) => (e ? rej(e) : res())));
  try {
    for (const e of entries) {
      const size = e.data ? e.data.length : statSync(e.path!).size;
      await write(tarHeader(e.name, size));
      if (e.data) await write(e.data);
      else for await (const chunk of createReadStream(e.path!)) await write(chunk as Buffer);
      if (size % 512) await write(Buffer.alloc(512 - (size % 512)));
    }
    await write(Buffer.alloc(1024));
  } finally {
    await new Promise<void>((res) => ws.end(res));
  }
}

/**
 * The bundle tar: the parts as they were downloaded (the container unpacks them), the side JS (`dist/side`, without its
 * side.json) under `app/dist/` and a package.json (name, version, ESM) under `app/`. Written to a new file in `outDir`.
 */
export async function assembleBundle(o: { partFiles: Record<string, string>; sideDir: string; version: string; outDir: string }) {
  mkdirSync(o.outDir, { recursive: true });
  const out = join(o.outDir, `bundle-${process.pid}-${Date.now()}.tar`);
  const js = readdirSync(o.sideDir).filter((f) => f.endsWith(".js") || f === "THIRD_PARTY_LICENSES.txt").sort();
  try {
    await writeTar(out, [
      ...Object.entries(o.partFiles).map(([name, path]) => ({ name, path })),
      ...js.map((f) => ({ name: `app/dist/${f}`, path: join(o.sideDir, f) })),
      { name: "app/package.json", data: Buffer.from(JSON.stringify({ name: "claude-code-ui", version: o.version, type: "module" })) },
    ]);
  } catch (e) {
    rmSync(out, { force: true });
    throw e;
  }
  return out;
}

/** This build's side JS: `dist/side` with `cli.js` and `side.json` (`{sdk}`: the SDK version it bundles); undefined when it has none. */
export function sideBuild(pkgDir: string): { dir: string; sdkVersion: string } | undefined {
  const dir = join(pkgDir, "dist", "side");
  try {
    const sdk = (JSON.parse(readFileSync(join(dir, "side.json"), "utf8")) as { sdk?: unknown }).sdk;
    if (typeof sdk === "string" && /^\d+\.\d+\.\d+[\w.+-]*$/.test(sdk) && existsSync(join(dir, "cli.js"))) return { dir, sdkVersion: sdk };
  } catch {
    // No side build (older build or a build that is running).
  }
  return undefined;
}

/** Removes cached parts of other claude-ui versions (`<cacheRoot>/<version>`): a new version gets new parts. */
export function pruneCache(cacheRoot: string, keep: string) {
  try {
    for (const n of readdirSync(cacheRoot)) if (n !== keep) rmSync(join(cacheRoot, n), { recursive: true, force: true });
  } catch {
    // No cache yet.
  }
}
