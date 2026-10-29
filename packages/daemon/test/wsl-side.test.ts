import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, utimesSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Exec } from "../src/docker-side.ts";
import { checkWslSide, setupScript } from "../src/sides.ts";
import { NODE } from "../src/side-bundle.ts";
import { partsIdOf, prepareWslSide, probeArgs } from "../src/wsl-side.ts";

const made: string[] = [];
const dir = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  made.push(d);
  return d;
};
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const hasTools = process.platform !== "win32" && ["sh", "tar", "gzip"].every((t) => spawnSync(t, ["--version"]).status !== null);

const probeOut = (arch: string, libc = "glibc", foundnode?: string) => ["arch=" + arch, "libc=" + libc, "glibc=2.36", "cxxrt=1", ...(foundnode ? ["foundnode=" + foundnode] : [])].map((l) => `CLAUDE_UI_CHECK ${l}`).join("\n");
const sha = (b: string) => createHash("sha256").update(b).digest("hex");
const sideBuildPkg = (withSide = true) => {
  const d = dir("wsl-pkg-");
  if (withSide) {
    mkdirSync(join(d, "dist", "side"), { recursive: true });
    writeFileSync(join(d, "dist", "side", "cli.js"), "side");
    writeFileSync(join(d, "dist", "side", "side.json"), JSON.stringify({ sdk: "0.3.1" }));
  }
  return d;
};
const parts = () => [{ file: "node.tar.gz", label: "Node.js", url: "https://n/node", sha256: sha("node") }];
const okFetch = (async () => new Response("node")) as unknown as typeof fetch;
const offline = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

// Named like the real cache: pruneCache only touches claude-ui's side cache.
const sideRoot = () => join(dir("wsl-home-"), "claude-ui", "side");

describe("prepareWslSide", () => {
  function go(o: { foundnode?: string; seen?: unknown[]; arch?: string; libc?: string; fetch?: typeof fetch; cacheRoot?: string; withSide?: boolean; setup?: "never" | "needed" | "force" }) {
    const calls: string[][] = [];
    const exec: Exec = async (_cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: probeOut(o.arch ?? "x86_64", o.libc, o.foundnode), stderr: "" };
    };
    const phases: string[] = [];
    const installs: unknown[] = [];
    const cacheRoot = o.cacheRoot ?? sideRoot();
    const result = prepareWslSide({ distro: "Ubuntu", pkgDir: sideBuildPkg(o.withSide), setup: o.setup, exec, onPhase: (p) => phases.push(p), onInstall: (i) => installs.push(i), bundle: { cacheRoot, version: "1.0.0", fetch: o.fetch ?? okFetch, parts: o.seen ? (_t, p) => (o.seen!.push(p.node), p.node === "found" ? [] : parts()) : parts } });
    return { calls, phases, installs, result, cacheRoot };
  }

  it("the probe runs in bash -lic like the setup script, with the script as base64 (no quotes or newlines on the Windows command line)", () => {
    const a = probeArgs("Ubuntu");
    expect(a.slice(0, 5)).toEqual(["-d", "Ubuntu", "--exec", "bash", "-lic"]);
    expect(a[5]).not.toMatch(/["\n]/);
  });

  it("a covered distro: parts verified into the shared cache, the bundle names the cached files and dist/side; no tar is assembled", async () => {
    const a = go({});
    const b = (await a.result)!;
    expect(b.target).toBe("linux-x64");
    expect(b.host).toEqual({ partsDir: join(a.cacheRoot, "1.0.0", "linux-x64"), sideDir: expect.stringMatching(/dist[\\/]side$/), version: "1.0.0", partsId: partsIdOf("linux-x64", "0.3.1") });
    expect(a.phases).toEqual(["downloading"]);
    expect(a.installs).toEqual([{ bundle: true }]);
    expect(readFileSync(join(b.host!.partsDir, "node.tar.gz"), "utf8")).toBe("node");
    expect(existsSync(join(a.cacheRoot, "1.0.0", ".tmp"))).toBe(false);
    // Cached and verified: a second distro downloads nothing.
    const c = go({ cacheRoot: a.cacheRoot, fetch: offline });
    expect((await c.result)?.target).toBe("linux-x64");
    expect(c.phases).toEqual([]);
  });

  it("a distro with Node.js 22+: no Node.js part, no nodejs.org fetch, parts id node-found; the pinned id is unchanged", async () => {
    const seen: unknown[] = [];
    const a = go({ foundnode: "1", seen, fetch: offline });
    const b = (await a.result)!;
    expect(seen).toEqual(["found"]);
    expect(b.nodeDir).toBeUndefined();
    expect(b.host!.partsId).toMatch(/^node-found\|/);
    expect(b.host!.partsId).toBe(partsIdOf("linux-x64", "0.3.1", "found"));
    expect(partsIdOf("linux-x64", "0.3.1", "pinned")).toBe(partsIdOf("linux-x64", "0.3.1"));
    expect(partsIdOf("linux-x64", "0.3.1")).toMatch(/^node-24\./);
    const pinned = (await go({ foundnode: "0" }).result)!;
    expect(pinned.nodeDir).toBeTruthy();
  });

  it("aarch64 picks the arm64 parts; the parts id changes with the target and the SDK", async () => {
    expect((await go({ arch: "aarch64" }).result)?.target).toBe("linux-arm64");
    expect(partsIdOf("linux-x64", "0.3.1")).not.toBe(partsIdOf("linux-arm64", "0.3.1"));
    expect(partsIdOf("linux-x64", "0.3.1")).not.toBe(partsIdOf("linux-x64", "0.3.2"));
  });

  it("musl, no side build, or offline with an empty cache: npm, with the reason", async () => {
    for (const [o, why] of [
      [{ libc: "musl" }, /musl/],
      [{ withSide: false }, /no distro bundle/],
      [{ fetch: offline }, /could not download Node\.js.*no verified copy/],
    ] as const) {
      const g = go(o);
      expect(await g.result).toBeUndefined();
      expect(g.installs).toEqual([{ fallback: expect.stringMatching(why) }]);
    }
  });

  it("a probe wsl.exe could not run is told apart from a distro the bundle does not cover; reasons use the word distro", async () => {
    for (const [r, why] of [
      [{ code: null, stdout: "", stderr: "" }, "the distro did not answer the target probe (no answer in time)"],
      [{ code: 1, stdout: "", stderr: "W\0S\0L\0 failed.\n" }, "the distro did not answer the target probe (WSL failed)"],
      [{ code: 1, stdout: "", stderr: "" }, "the distro did not answer the target probe (exit code 1)"],
    ] as const) {
      const installs: unknown[] = [];
      const exec: Exec = async () => r;
      expect(await prepareWslSide({ distro: "U", pkgDir: sideBuildPkg(), exec, onInstall: (i) => installs.push(i), bundle: { cacheRoot: sideRoot(), version: "1.0.0", fetch: okFetch, parts } })).toBeUndefined();
      expect(installs).toEqual([{ fallback: why }]);
    }
    for (const [arch, libc] of [["armv7l", "glibc"], ["x86_64", "musl"]] as const) {
      const g = go({ arch, libc });
      await g.result;
      expect(JSON.stringify(g.installs)).toMatch(/the distro/);
      expect(JSON.stringify(g.installs)).not.toMatch(/container/);
    }
  });

  it("a checksum mismatch falls back with the full sentence", async () => {
    const g = go({ fetch: (async () => new Response("evil")) as unknown as typeof fetch });
    await g.result;
    expect(g.installs).toEqual([{ fallback: "the Node.js the host downloaded does not match its checksum (it was not used) and the host has no verified copy of it" }]);
  });

  it("marks this version used, then prunes by the 7-day rule: a version used 2 days ago stays, one unused for 8 days goes", async () => {
    const cacheRoot = sideRoot();
    for (const [v, days] of [["0.9.0", 2], ["0.8.0", 8]] as const) {
      mkdirSync(join(cacheRoot, v), { recursive: true });
      writeFileSync(join(cacheRoot, v, ".used"), "");
      const t = new Date(Date.now() - days * 24 * 3_600_000);
      utimesSync(join(cacheRoot, v, ".used"), t, t);
    }
    await go({ cacheRoot }).result;
    expect(readdirSync(cacheRoot).sort()).toEqual(["0.9.0", "1.0.0"]);
    expect(existsSync(join(cacheRoot, "1.0.0", ".used"))).toBe(true);
  });

  it("this version is marked used before the parts are fetched", async () => {
    const cacheRoot = sideRoot();
    let markedAtFetch: boolean | undefined;
    const spy = (async () => ((markedAtFetch ??= existsSync(join(cacheRoot, "1.0.0", ".used"))), new Response("node"))) as unknown as typeof fetch;
    await go({ cacheRoot, fetch: spy }).result;
    expect(markedAtFetch).toBe(true);
  });

  it("the parts id includes the Node.js checksum", () => {
    expect(partsIdOf("linux-x64", "1")).toContain(NODE.sha256["linux-x64"]);
  });

  it("never: nothing is probed or downloaded", async () => {
    const g = go({ setup: "never" });
    expect(await g.result).toBeUndefined();
    expect(g.calls).toEqual([]);
    expect(g.installs).toEqual([]);
    expect(existsSync(join(g.cacheRoot, "1.0.0"))).toBe(false);
  });
});

const host = { partsDir: "C:\\cache\\side\\1.0.0\\linux-x64", sideDir: "C:\\pkg\\dist\\side", version: "1.0.0", partsId: "id-1" };
const bundle = { target: "linux-x64" as const, nodeDir: "node-v24.22.1-linux-x64", claudePackage: "claude-agent-sdk-linux-x64", host };

describe("setupScript for a WSL distro: bundle, npm fallback, never", () => {
  it("a bundle: no npm, no Node.js check, no compile, no tar from the host; the parts are read in place and never removed", () => {
    for (const mode of ["needed", "force"] as const) {
      const s = setupScript("C:\\pkg", "1.0.0-1", "wsl", mode, bundle);
      expect(s).toContain("wslpath -u 'C:\\cache\\side\\1.0.0\\linux-x64'");
      expect(s).toContain("wslpath -u 'C:\\pkg\\dist\\side'");
      expect(s).toContain("id='id-1'");
      expect(s).not.toMatch(/npm install|node_missing|node_old|build_tools_missing|command -v node|--install-links|\$src/);
      // Only the install's own temp and old folders are removed: nothing under the part folder.
      for (const l of s.split("\n").filter((l) => /\brm\b/.test(l))) expect(l, l).not.toMatch(/\$pd|\$sd/);
      expect(s).toContain('exec "$dir/node/bin/node" "$cli" --side');
      expect(s).toContain("CLAUDE_UI_PHASE %s\\n' installing");
      expect(s).toContain("CLAUDE_UI_PHASE %s\\n' starting");
      expect(s).not.toContain("not_logged_in");
    }
  });

  it("the fast path: an install with an equal parts.id and a working Node.js is hard-linked, claude-ui excepted; written before the swap", () => {
    const s = setupScript("C:\\pkg", "1.0.0-1", "wsl", "needed", bundle);
    for (const part of ['"$d/parts.id"', "cp -al", '"${m##*/}" = claude-code-ui', '"$d/node/bin/node" --version', 'printf \'%s\\n\' "$id" > "$new/parts.id"']) expect(s).toContain(part);
    expect(s.indexOf('> "$new/parts.id"')).toBeLessThan(s.indexOf('mv "$new" "$dir"'));
    expect(s).toContain('if [ ! -f "$cli" ] || ! sdk "$dir" || [ ! -x "$dir/node/bin/node" ]; then');
    // force installs again from the parts: the install of the same key is no source.
    expect(setupScript("C:\\pkg", "1.0.0-1", "wsl", "force", bundle)).toContain('[ "$d" != "$dir" ]');
    expect(setupScript("C:\\pkg", "1.0.0-1", "wsl", "needed", bundle)).not.toContain('[ "$d" != "$dir" ]');
  });

  it("without a bundle (fallback) the npm script runs; never ignores the bundle; both can run an installed bundle without Node.js", () => {
    const npm = setupScript("C:\\pkg", "1.0.0-1", "wsl", "needed");
    expect(npm).toContain("npm install");
    expect(npm).toContain("build_tools_missing");
    expect(npm).toContain('if [ -x "$dir/node/bin/node" ] && [ -f "$cli" ] && sdk "$dir"; then :; else');
    expect(npm).toContain('exec "${n:-node}" "$cli" --side');
    const never = setupScript("C:\\pkg", "1.0.0-1", "wsl", "never", bundle);
    expect(never).toBe(setupScript("C:\\pkg", "1.0.0-1", "wsl", "never"));
    expect(never).toContain("say not_installed");
    expect(never).toContain('exec "$dir/node/bin/node" "$cli" --side');
    expect(setupScript("C:\\pkg", "1.0.0-1", "wsl", "force")).toContain("npm install");
    for (const s of [npm, never, setupScript("C:\\pkg", "k", "wsl", "needed", bundle)]) if (hasTools) expect(spawnSync("bash", ["-n", "-c", s]).status).toBe(0);
  });
});

describe("checkWslSide: the install method follows the distro's target and this build", () => {
  const lines = (l: string[]) => l.map((x) => `CLAUDE_UI_CHECK ${x}`).join("\n");
  const pkgWith = (side: boolean) => {
    const d = sideBuildPkg(side);
    mkdirSync(join(d, "dist"), { recursive: true });
    writeFileSync(join(d, "dist", "cli.js"), "cli");
    return d;
  };
  const run = (extra: string[], side = true) =>
    checkWslSide({ distro: "Ubuntu", pkgDir: pkgWith(side), key: "1-1", exec: async () => ({ code: 0, stdout: lines(["make=0", "python3=0", "cxx=0", "credentials=1", "package=1", ...extra, "tar=1", "gzip=1", "git=1", "npm=1", "bundled=0", "installed=none"]), stderr: "" }) });
  const glibc = ["arch=x86_64", "libc=glibc", "glibc=2.36", "cxxrt=1"];

  it("a covered distro without Node.js, make or g++ can install: the bundle needs none of them", async () => {
    const r = await run(glibc);
    expect(r.verdict).toBe("install");
    expect(r.facts).toMatchObject({ install: { method: "bundle" }, bundled: false, target: { arch: "x86_64", libc: "glibc" } });
  });

  it("the parts fact: cold cache says download, every part file cached says cached; without a bundle source there is none", async () => {
    const cacheRoot = join(dir("wsl-home-"), "claude-ui", "side");
    const d = pkgWith(true);
    const exec = async () => ({ code: 0, stdout: lines(["make=0", "python3=0", "cxx=0", "credentials=1", "package=1", ...glibc, "tar=1", "gzip=1", "git=1", "npm=1", "bundled=0", "installed=none"]), stderr: "" });
    const src = { cacheRoot, version: "1.0.0", parts };
    const at = (bundle?: typeof src) => checkWslSide({ distro: "Ubuntu", pkgDir: d, key: "1-1", exec, ...(bundle && { bundle }) });
    expect((await at(src)).facts.install).toEqual({ method: "bundle", parts: "download" });
    mkdirSync(join(cacheRoot, "1.0.0", "linux-x64"), { recursive: true });
    writeFileSync(join(cacheRoot, "1.0.0", "linux-x64", "node.tar.gz"), "x");
    expect((await at(src)).facts.install).toEqual({ method: "bundle", parts: "cached" });
    expect((await at()).facts.install).toEqual({ method: "bundle" });
  });

  it("musl or a build without dist/side: npm, so Node.js is needed and the reason is told", async () => {
    const musl = await run(["arch=x86_64", "libc=musl", "cxxrt=1"]);
    expect([musl.verdict, musl.reason]).toEqual(["blocked", "node_missing"]);
    expect(musl.message).toContain("musl");
    expect(musl.facts.install).toMatchObject({ method: "npm", reason: expect.stringContaining("musl") });
    const old = await run(glibc, false);
    expect(old.reason).toBe("node_missing");
    expect(old.facts.install?.method).toBe("npm");
  });
});

// The generated script, run for real under bash with fake part tarballs and a `wslpath` that returns its argument.
describe.skipIf(!hasTools)("the WSL bundle script, run", () => {
  const TARGET = "linux-x64";
  const NODE_DIR = `node-v24.22.1-${TARGET}`;
  /** A fake world: cached parts (tarballs made with tar), a side build, a HOME and a fake wslpath. */
  function world(weird = false) {
    // weird: an apostrophe, a space and double quotes in every path the script is given
    const base = weird ? join(dir("wsl-run-"), "O'Brien \"x\" y") : dir("wsl-run-");
    mkdirSync(base, { recursive: true });
    const src = join(base, "src");
    const partsDir = join(base, "cache", "1.0.0", TARGET);
    const sideDir = join(base, "pkg", "dist", "side");
    const home = join(base, "home");
    const bin = join(base, "bin");
    for (const d of [src, partsDir, sideDir, home, bin]) mkdirSync(d, { recursive: true });
    const put = (rel: string, text: string, mode?: number) => {
      mkdirSync(join(src, rel, ".."), { recursive: true });
      writeFileSync(join(src, rel), text, { mode });
    };
    put(`${NODE_DIR}/bin/node`, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, 0o755);
    put(`${NODE_DIR}/LICENSE`, "node license");
    put("pty/package/package.json", "{}");
    put(`pty/package/prebuilds/${TARGET}/pty.node`, "elf");
    put("pty/package/prebuilds/win32-x64/pty.node", "pe");
    put("sdk/package/package.json", "{}");
    put(`claude/package/claude`, "bin");
    const tar = (out: string, dirIn: string, ...paths: string[]) => expect(spawnSync("tar", ["-czf", join(partsDir, out), "-C", join(src, dirIn), ...paths]).status).toBe(0);
    tar("node.tar.gz", ".", NODE_DIR);
    tar("node-pty.tgz", "pty", "package");
    tar("sdk.tgz", "sdk", "package");
    tar("claude.tgz", "claude", "package");
    writeFileSync(join(sideDir, "cli.js"), 'if (process.argv.includes("--version")) { console.log("1.0.0"); process.exit(0); } console.log("side started");');
    writeFileSync(join(sideDir, "chunk.js"), "");
    writeFileSync(join(sideDir, "side.json"), '{"sdk":"1"}');
    writeFileSync(join(sideDir, "THIRD_PARTY_LICENSES.txt"), "licenses");
    writeFileSync(join(bin, "wslpath"), '#!/bin/sh\nprintf "%s\\n" "$2"\n', { mode: 0o755 });
    const root = join(home, ".local/share/claude-ui/side");
    // A node that passes the usable_node rule (the host's is no linux node on macOS) and runs the rest on the host's.
    writeFileSync(join(bin, "found-node"), `#!/bin/sh\ncase "$1" in -e) echo claude-ui-node-ok;; -p) echo "$0";; *) exec '${process.execPath}' "$@";; esac\n`, { mode: 0o755 });
    const run = (key: string, mode: "needed" | "force" | "never", id = "id-1", extra: Record<string, string> = {}, found = false) => {
      if (found) copyFileSync(join(bin, "found-node"), join(bin, "node"));
      else rmSync(join(bin, "node"), { force: true });
      const b = { target: TARGET, ...(!found && { nodeDir: NODE_DIR }), claudePackage: `claude-agent-sdk-${TARGET}`, host: { partsDir, sideDir, version: "1.0.0", partsId: id } } as const;
      const r = spawnSync("bash", ["-c", setupScript("C:\\unused", key, "wsl", mode, b)], { cwd: home, encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, ANTHROPIC_API_KEY: "test", ...extra } });
      return { status: r.status, out: r.stdout, entries: existsSync(root) ? readdirSync(root).sort() : [] };
    };
    const hostFiles = () => readdirSync(partsDir).sort();
    return { base, partsDir, sideDir, root, run, hostFiles };
  }
  const installed = (root: string, key: string) => join(root, key);

  it("installs from the parts: node, node-pty with only this target's prebuild, SDK, Claude Code, side JS, package.json, parts.id; starts; the host files stay", () => {
    const w = world();
    const before = w.hostFiles();
    const r = w.run("1.0.0-1", "needed");
    expect(r.out).toContain("CLAUDE_UI_PHASE installing");
    expect(r.out).toContain("side started");
    expect(r.entries).toEqual(["1.0.0-1"]);
    const d = installed(w.root, "1.0.0-1");
    expect(statSync(join(d, "node/bin/node")).mode & 0o111).toBeTruthy();
    expect(readdirSync(join(d, "node_modules/node-pty/prebuilds"))).toEqual([TARGET]);
    for (const f of ["@anthropic-ai/claude-agent-sdk/package.json", `@anthropic-ai/claude-agent-sdk-${TARGET}/claude`, "claude-code-ui/dist/cli.js", "claude-code-ui/dist/chunk.js", "claude-code-ui/dist/THIRD_PARTY_LICENSES.txt"]) expect(existsSync(join(d, "node_modules", f)), f).toBe(true);
    expect(existsSync(join(d, "node_modules/claude-code-ui/dist/side.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(d, "node_modules/claude-code-ui/package.json"), "utf8"))).toEqual({ name: "claude-code-ui", version: "1.0.0", type: "module" });
    expect(readFileSync(join(d, "parts.id"), "utf8").trim()).toBe("id-1");
    expect(w.hostFiles()).toEqual(before);
    // Installed: needed does nothing, not even the installing phase.
    const again = w.run("1.0.0-1", "needed");
    expect(again.out).not.toContain("installing");
    expect(again.out).toContain("side started");
  });

  it("a new build with the same parts is hard-linked from the old install: it installs with the parts gone; other parts unpack again", () => {
    const w = world();
    expect(w.run("1.0.0-1", "needed").out).toContain("side started");
    for (const f of w.hostFiles()) rmSync(join(w.partsDir, f));
    const r = w.run("1.0.0-2", "needed");
    expect(r.out).toContain("side started");
    expect(r.out).not.toContain("install_failed");
    expect(r.entries).toEqual(["1.0.0-2"]);
    const d = installed(w.root, "1.0.0-2");
    expect(existsSync(join(d, "node_modules/claude-code-ui/dist/cli.js"))).toBe(true);
    expect(existsSync(join(d, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"))).toBe(true);
    expect(readFileSync(join(d, "parts.id"), "utf8").trim()).toBe("id-1");
    expect(existsSync(join(d, "b"))).toBe(false);
    // Other parts: no reuse, and the parts are gone: the install fails and the old one stays.
    const other = w.run("1.0.0-3", "needed", "id-2");
    expect(other.status).toBe(3);
    expect(other.out).toMatch(/^CLAUDE_UI_SETUP install_failed .*parts were not found/m);
    expect(other.entries).toEqual(["1.0.0-2"]);
  });

  it("force unpacks the parts again (the install of the same key is no source); an npm install of the same key is replaced once", () => {
    const w = world();
    w.run("1.0.0-1", "needed");
    for (const f of w.hostFiles()) rmSync(join(w.partsDir, f));
    const forced = w.run("1.0.0-1", "force");
    expect(forced.status).toBe(3);
    expect(forced.out).toContain("install_failed");
    expect(forced.entries).toEqual(["1.0.0-1"]);
    // npm install of this build: cli.js and the SDK binary, no node/bin/node.
    const v = world();
    const npmDir = installed(v.root, "1.0.0-1");
    mkdirSync(join(npmDir, "node_modules/claude-code-ui/dist"), { recursive: true });
    mkdirSync(join(npmDir, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"), { recursive: true });
    writeFileSync(join(npmDir, "node_modules/claude-code-ui/dist/cli.js"), "old npm build");
    const r = v.run("1.0.0-1", "needed");
    expect(r.out).toContain("side started");
    expect(existsSync(join(npmDir, "node/bin/node"))).toBe(true);
    expect(readFileSync(join(npmDir, "node_modules/claude-code-ui/dist/cli.js"), "utf8")).toContain("side started");
  });

  it("a part that does not unpack leaves the old install; the host files stay", () => {
    const w = world();
    w.run("1.0.0-1", "needed");
    writeFileSync(join(w.partsDir, "sdk.tgz"), "not a tarball");
    const before = w.hostFiles();
    const r = w.run("1.0.0-2", "needed", "id-2");
    expect(r.status).toBe(3);
    expect(r.out).toMatch(/^CLAUDE_UI_SETUP install_failed .*Agent SDK could not be unpacked/m);
    expect(r.entries).toEqual(["1.0.0-1"]);
    expect(w.hostFiles()).toEqual(before);
  });

  it("paths with an apostrophe, a space and double quotes work (escaped, not stripped)", () => {
    const w = world(true);
    const r = w.run("1.0.0-1", "needed");
    expect(r.status, r.out).not.toBe(3);
    expect(r.out).toContain("side started");
    expect(existsSync(join(installed(w.root, "1.0.0-1"), "node/bin/node"))).toBe(true);
  });

  it("found mode: runs on the found Node.js with no node/ and no node.tar.gz; reuse links node_modules only; a pinned id is not reused", () => {
    const w = world();
    rmSync(join(w.partsDir, "node.tar.gz"));
    const r = w.run("1.0.0-1", "needed", "node-found|x", {}, true);
    expect(r.out).toContain("side started");
    expect(r.out).not.toContain("install_failed");
    expect(existsSync(join(installed(w.root, "1.0.0-1"), "node"))).toBe(false);
    for (const f of w.hostFiles()) rmSync(join(w.partsDir, f));
    const again = w.run("1.0.0-2", "needed", "node-found|x", {}, true);
    expect(again.out).toContain("side started");
    expect(again.entries).toEqual(["1.0.0-2"]);
    expect(existsSync(join(installed(w.root, "1.0.0-2"), "node"))).toBe(false);
    const pinned = w.run("1.0.0-3", "needed", "node-24|x");
    expect(pinned.out).toMatch(/^CLAUDE_UI_SETUP install_failed .*parts were not found/m);
  });

  it("a candidate for reuse without the SDK binary is not linked: the parts are unpacked", () => {
    const w = world();
    w.run("1.0.0-1", "needed");
    rmSync(join(installed(w.root, "1.0.0-1"), `node_modules/@anthropic-ai/claude-agent-sdk-${TARGET}`), { recursive: true });
    const r = w.run("1.0.0-2", "needed");
    expect(r.out).toContain("side started");
    expect(r.entries).toEqual(["1.0.0-2"]);
    expect(existsSync(join(installed(w.root, "1.0.0-2"), `node_modules/@anthropic-ai/claude-agent-sdk-${TARGET}/claude`))).toBe(true);
  });

  it("a reused install that does not start is dropped and the parts are unpacked once", () => {
    const w = world();
    w.run("1.0.0-1", "needed");
    // Starts for the candidate test (--version alone) but not with the side's cli.js.
    writeFileSync(join(installed(w.root, "1.0.0-1"), "node/bin/node"), '#!/bin/sh\n[ "$#" -le 1 ] && exit 0\nexit 1\n', { mode: 0o755 });
    const r = w.run("1.0.0-2", "needed");
    expect(r.out).toContain("side started");
    expect(r.out).not.toContain("install_failed");
    expect(r.entries).toEqual(["1.0.0-2"]);
    expect(readFileSync(join(installed(w.root, "1.0.0-2"), "node/bin/node"), "utf8")).toContain("exec");
  });
});
