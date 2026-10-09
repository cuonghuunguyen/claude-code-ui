import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage, SideCheck } from "@claude-ui/protocol";
import { blockedCheck, checkMessage, checkScript, createRouter, createSides, parseCheck, setupScript, verdictOf, wslSide, dockerSide, type SideProcess } from "../src/sides.ts";

const dir = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;
/** Absolute, so the fake PATH of a test does not hide it. */
const SH = existsSync("/bin/sh") ? "/bin/sh" : "sh";
const KEY = "0.5.0-1700";

const base = { make: true, python3: true, cxx: true, credentials: true, installed: "none" as "current" | "other" | "none", node: "22.4.0" as string | undefined };
const verdict = (checked: Partial<Parameters<typeof verdictOf>[0]["checked"]>, o: Partial<Parameters<typeof verdictOf>[0]> = {}) => verdictOf({ key: KEY, label: "WSL: Ubuntu", kind: "wsl", build: true, checked: { ...base, ...checked }, ...o });

describe("checkScript", () => {
  for (const kind of ["wsl", "docker"] as const) {
    it(`${kind}: only reads: no install, copy, write, redirect into a file, key names or file contents`, () => {
      const s = checkScript(KEY, kind, "C:\\pkg");
      for (const bad of [/\bnpm\b/, /\brm\b/, /\bmv\b/, /\bmkdir\b/, /\bcp\b/, /\bcat\b/, /\btee\b/, /\btouch\b/, /\bchmod\b/, /\bpack\b/, /ANTHROPIC|OAUTH|TOKEN|API_KEY/, /\benv\b|\bprintenv\b/, /node "?\$cli|--side|exec node/]) expect(s).not.toMatch(bad);
      // Redirects only into /dev/null or other file descriptors.
      for (const m of s.matchAll(/\d?>>?\s*([^\s;&|)]+)/g)) expect(m[1]).toMatch(/^(\/dev\/null|&\d)$/);
      expect(s).not.toMatch(/<\s*[^\s(]/);
      expect(s).toContain("CLAUDE_UI_CHECK");
    });
  }

  it("docker lists writable folders; wsl looks for the Windows package with wslpath and sources no nvm", () => {
    const d = checkScript(KEY, "docker");
    expect(d).toContain("writable");
    expect(d).toContain("nvm.sh");
    expect(d).not.toContain("wslpath");
    const w = checkScript(KEY, "wsl", "C:\\pkg's");
    expect(w).toContain("wslpath -u 'C:\\pkgs'");
    expect(w).not.toContain("writable");
    expect(w).not.toContain("nvm.sh");
  });

  it("is plain sh", () => {
    if (hasSh) for (const kind of ["wsl", "docker"] as const) expect(spawnSync("sh", ["-n", "-c", checkScript(KEY, kind, "/p")]).status).toBe(0);
  });
});

describe("parseCheck", () => {
  const out = (lines: string[]) => lines.map((l) => `CLAUDE_UI_CHECK ${l}`).join("\n");
  it("reads every fact and skips shell noise", () => {
    const r = parseCheck(`Welcome to Ubuntu\n${out(["node=22.4.0", "make=1", "python3=0", "cxx=1", "credentials=1", "writable=/tmp,/dev/shm", "installed=other", "installedKey=0.4.0-1"])}\nmotd\r\n`);
    expect(r).toEqual({ node: "22.4.0", make: true, python3: false, cxx: true, credentials: true, writable: ["/tmp", "/dev/shm"], installed: "other", installedKey: "0.4.0-1" });
  });
  it("no node, an empty writable list and the WSL package flag", () => {
    expect(parseCheck(out(["node=none", "make=0", "python3=0", "cxx=0", "credentials=0", "package=0", "installed=none"]))).toEqual({ make: false, python3: false, cxx: false, credentials: false, packageVisible: false, installed: "none" });
    expect(parseCheck(out(["node=22.1.0", "writable=", "installed=current"]))!.writable).toEqual([]);
  });
  it("is undefined without the last line (the script did not finish) or without any line", () => {
    expect(parseCheck(out(["node=22.4.0", "make=1"]))).toBeUndefined();
    expect(parseCheck("bash: wsl: command not found")).toBeUndefined();
    expect(parseCheck(out(["installed=maybe"]))).toBeUndefined();
  });
});

describe("verdictOf", () => {
  it("running on a table of facts", () => {
    const table: [string, Partial<typeof base> & { installed?: "current" | "other" | "none"; installedKey?: string; packageVisible?: boolean; writable?: string[] }, Partial<Parameters<typeof verdictOf>[0]>, string, string | undefined][] = [
      ["install", {}, {}, "install", undefined],
      ["update", { installed: "other", installedKey: "0.4.0-1" }, {}, "update", undefined],
      ["installed", { installed: "current" }, {}, "installed", undefined],
      ["no build", { installed: "current" }, { build: false }, "blocked", "no_build"],
      ["no node", { node: undefined }, {}, "blocked", "node_missing"],
      ["old node", { node: "20.11.0" }, {}, "blocked", "node_old"],
      ["tools missing", { make: false, cxx: false }, {}, "blocked", "build_tools_missing"],
      ["tools missing but installed", { make: false, installed: "current" }, {}, "installed", undefined],
      ["no credentials", {}, {}, "blocked", "not_logged_in"],
      ["package unreadable", { packageVisible: false }, {}, "blocked", "package_unreadable"],
      ["package unreadable but installed", { packageVisible: false, installed: "current" }, {}, "installed", undefined],
      ["old node beats tools", { node: "18.0.0", make: false }, {}, "blocked", "node_old"],
      ["tools beat login", { make: false, credentials: false }, {}, "blocked", "build_tools_missing"],
      ["docker: nothing writable", { writable: [] }, { kind: "docker", cpUsable: false }, "blocked", "no_writable_path"],
      ["docker: cp works, nothing writable for a stream", { writable: [] }, { kind: "docker", cpUsable: true }, "install", undefined],
      ["docker: cp unknown, nothing writable", { writable: [] }, { kind: "docker" }, "install", undefined],
      ["docker: cp not usable, a folder is writable", { writable: ["/dev/shm"] }, { kind: "docker", cpUsable: false }, "install", undefined],
      ["docker: nothing writable but installed", { writable: [], installed: "current" }, { kind: "docker", cpUsable: false }, "installed", undefined],
    ];
    for (const [name, checked, o, v, reason] of table) {
      const creds = name === "no credentials" ? { credentials: false } : {};
      const r = verdict({ ...checked, ...creds }, o);
      expect([name, r.verdict, r.reason]).toEqual([name, v, reason]);
      expect(r.key).toBe(KEY);
      expect(Object.keys(r.facts)).not.toContain("copy");
      if (v === "blocked" || v === "install" || v === "update") expect(r.message, name).toBeTruthy();
    }
  });

  it("facts carry what was seen; the message never names the copy method", () => {
    const r = verdict({ installed: "other", installedKey: "0.4.0-1", writable: ["/tmp"] }, { kind: "docker", label: "Docker: dev", name: "dev", cpUsable: true });
    expect(r.facts).toEqual({ reachable: true, running: true, node: "22.4.0", nodeOk: true, buildTools: { make: true, python3: true, cxx: true }, credentialsFile: true, installed: "other", installedKey: "0.4.0-1", writable: ["/tmp"] });
    for (const reason of ["gone", "not_running", "unreachable", "no_build", "package_unreadable", "node_missing", "node_old", "build_tools_missing", "not_logged_in", "no_writable_path", "check_failed"] as const)
      for (const docker of [true, false]) expect(checkMessage(reason, "X", { docker, detail: "d", name: "n" }), reason).not.toMatch(/docker cp|docker exec|\bcp\b|stream|exec/i);
  });

  it("every reason has a short plain message and the not-logged-in one is soft (offers installing anyway)", () => {
    expect(checkMessage("not_logged_in", "WSL: Ubuntu")).toMatch(/install anyway/);
    expect(checkMessage("node_old", "WSL: Ubuntu", { detail: "20.1.0" })).toContain("20.1.0");
    expect(checkMessage("not_running", "Docker: dev", { docker: true, name: "dev" })).toContain("docker start dev");
    expect(blockedCheck(KEY, "X", "gone").facts).toEqual({ reachable: false, installed: "none" });
  });
});

describe("setupScript modes", () => {
  it("never: no install branch, no tarball, no pack; not_installed and the phase lines", () => {
    for (const kind of ["wsl", "docker"] as const) {
      const s = setupScript(kind === "docker" ? "/tmp/a.tgz" : "C:\\p", KEY, kind, "never");
      expect(s).toContain("say not_installed");
      expect(s).not.toMatch(/npm install|wslpath|\$src|src=/);
      expect(s).toContain("CLAUDE_UI_PHASE %s\\n' starting");
      expect(s).not.toContain("installing");
    }
  });
  it("needed (default) is today's script with phase lines; force installs whatever is there", () => {
    const needed = setupScript("/tmp/a.tgz", KEY, "docker");
    expect(needed).toBe(setupScript("/tmp/a.tgz", KEY, "docker", "needed"));
    expect(needed).toContain('if [ ! -f "$cli" ] || ! sdk "$dir"; then');
    expect(needed).toContain("installing");
    const force = setupScript("/tmp/a.tgz", KEY, "docker", "force");
    expect(force).toContain("if true; then");
    expect(force).not.toContain('if [ ! -f "$cli" ]');
    expect(force).toContain('mv "$new" "$dir"');
    if (hasSh) for (const m of ["never", "needed", "force"] as const) for (const k of ["wsl", "docker"] as const) expect(spawnSync("sh", ["-n", "-c", setupScript("/tmp/a.tgz", KEY, k, m)]).status).toBe(0);
  });
});

/** Every path under `root` with size and mtime: a read-only check leaves it identical. */
function snapshot(root: string, out: string[] = [], rel = ""): string[] {
  for (const n of readdirSync(join(root, rel)).sort()) {
    const p = join(rel, n);
    const st = statSync(join(root, p));
    out.push(`${p}|${st.isDirectory() ? "d" : st.size}|${Math.trunc(st.mtimeMs)}`);
    if (st.isDirectory()) snapshot(root, out, p);
  }
  return out;
}

describe.skipIf(!hasSh || process.platform === "win32")("the check and setup scripts in sh (fake HOME and PATH)", () => {
  function box(o: { node?: string | false; tools?: boolean; credentials?: boolean; install?: "current" | "other" | "no-binary" | "none" }) {
    const home = dir("chk-home-");
    const bin = dir("chk-bin-");
    const log = join(dir("chk-log-"), "calls.log");
    const root = join(home, ".local/share/claude-ui/side");
    const pkg = (name: string, binary: boolean) => {
      mkdirSync(join(root, name, "node_modules/claude-code-ui/dist"), { recursive: true });
      writeFileSync(join(root, name, "node_modules/claude-code-ui/dist/cli.js"), "x");
      if (binary) mkdirSync(join(root, name, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"), { recursive: true });
    };
    if (o.install === "current") pkg(KEY, true);
    if (o.install === "no-binary") pkg(KEY, false);
    if (o.install === "other") pkg("0.4.0-1", true);
    if (o.credentials !== false) (mkdirSync(join(home, ".claude")), writeFileSync(join(home, ".claude/.credentials.json"), "SECRET-DO-NOT-READ"));
    // A fake node answers `-p` (the version), `-v` and `--version`; run as the side it prints a marker.
    if (o.node !== false) writeFileSync(join(bin, "node"), `#!/bin/sh\necho "node $*" >> '${log}'\ncase "$1" in -p) case "$2" in *split*) echo ${(o.node ?? "22.4.0").split(".")[0]};; *) echo ${o.node ?? "22.4.0"};; esac;; -v) echo v${o.node ?? "22.4.0"};; *) echo side started;; esac\n`, { mode: 0o755 });
    if (o.tools !== false) for (const t of ["make", "python3", "g++"]) writeFileSync(join(bin, t), "#!/bin/sh\n", { mode: 0o755 });
    // npm only logs (and fakes a complete install into the --prefix).
    writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> '${log}'\nwhile [ "$1" != --prefix ]; do shift; done; p=$2\nmkdir -p "$p/node_modules/claude-code-ui/dist" "$p/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"\necho x > "$p/node_modules/claude-code-ui/dist/cli.js"\n`, { mode: 0o755 });
    // The check runs with nothing but the fakes on PATH; the setup script also needs rm, mv and mkdir.
    const run = (script: string, system = false) => spawnSync(SH, ["-c", script], { cwd: home, encoding: "utf8", env: { PATH: system ? `${bin}:/usr/bin:/bin` : bin, HOME: home } });
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
    return { home, root, run, calls };
  }
  const check = (o: Parameters<typeof box>[0]) => {
    const b = box(o);
    const before = snapshot(b.home);
    const r = b.run(checkScript(KEY, "docker"));
    return { ...b, out: r.stdout, parsed: parseCheck(r.stdout), unchanged: snapshot(b.home).join("\n") === before.join("\n"), err: r.stderr };
  };

  it("nothing installed: install", () => {
    const c = check({});
    expect(c.parsed).toMatchObject({ node: "22.4.0", make: true, python3: true, cxx: true, credentials: true, installed: "none" });
    expect(c.parsed!.writable).toContain(c.home);
    expect(c.unchanged).toBe(true);
    expect(c.calls().filter((l) => l.startsWith("npm"))).toEqual([]);
    // Only `node -p <version>` ever ran, never the claude-ui entry.
    expect(c.calls()).toEqual(["node -p process.versions.node"]);
  });
  it("another build installed: update, named; this build without the SDK binary counts as not current", () => {
    expect(check({ install: "other" }).parsed).toMatchObject({ installed: "other", installedKey: "0.4.0-1" });
    expect(check({ install: "no-binary" }).parsed).toMatchObject({ installed: "other", installedKey: KEY });
  });
  it("this build installed: current", () => {
    const c = check({ install: "current" });
    expect(c.parsed).toMatchObject({ installed: "current" });
    expect(c.parsed!.installedKey).toBeUndefined();
    expect(c.unchanged).toBe(true);
  });
  it("no node, old node, no tools, no credentials", () => {
    expect(check({ node: false }).parsed!.node).toBeUndefined();
    expect(check({ node: "20.11.0" }).parsed!.node).toBe("20.11.0");
    expect(check({ tools: false }).parsed).toMatchObject({ make: false, python3: false, cxx: false });
    expect(check({ credentials: false }).parsed!.credentials).toBe(false);
  });
  it("leaves the whole HOME tree (paths, sizes, mtimes) as it was, and never prints the credentials", () => {
    for (const o of [{}, { install: "other" as const }, { install: "current" as const }, { credentials: false }, { node: false as const }]) {
      const c = check(o);
      expect(c.unchanged, JSON.stringify(o)).toBe(true);
      expect(c.out + c.err).not.toContain("SECRET");
    }
  });
  it("the WSL variant reports the package flag (no wslpath here: not visible)", () => {
    const b = box({});
    expect(parseCheck(b.run(checkScript(KEY, "wsl", "/nope")).stdout)).toMatchObject({ packageVisible: false, installed: "none" });
  });

  it("setup never: prints not_installed and installs nothing; with this build installed it only starts it", () => {
    const b = box({});
    const r = b.run(setupScript("/tmp/x.tgz", KEY, "docker", "never"));
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("CLAUDE_UI_SETUP not_installed");
    expect(b.calls().some((l) => l.startsWith("npm"))).toBe(false);
    expect(existsSync(b.root)).toBe(false);
    const ok = box({ install: "current" });
    const s = ok.run(setupScript("/tmp/x.tgz", KEY, "docker", "never"));
    expect(s.stdout).toContain("CLAUDE_UI_PHASE starting");
    expect(s.stdout).toContain("side started");
    expect(ok.calls().some((l) => l.startsWith("npm"))).toBe(false);
  });
  it("setup never does not run a build that is another version", () => {
    const b = box({ install: "other" });
    expect(b.run(setupScript("/tmp/x.tgz", KEY, "docker", "never")).stdout).toContain("CLAUDE_UI_SETUP not_installed");
    expect(readdirSync(b.root)).toEqual(["0.4.0-1"]);
  });
  it("setup force installs again over a complete install; needed leaves it", () => {
    const f = box({ install: "current" });
    writeFileSync(join(f.home, "side.tgz"), "");
    const r = f.run(setupScript(join(f.home, "side.tgz"), KEY, "docker", "force"), true);
    expect(r.stdout).toContain("CLAUDE_UI_PHASE installing");
    expect(r.stdout).toContain("side started");
    expect(f.calls().filter((l) => l.startsWith("npm install"))).toHaveLength(1);
    const n = box({ install: "current" });
    writeFileSync(join(n.home, "side.tgz"), "");
    n.run(setupScript(join(n.home, "side.tgz"), KEY, "docker", "needed"), true);
    expect(n.calls().filter((l) => l.startsWith("npm install"))).toHaveLength(0);
  });
});

// A hub with fake side processes: no daemon, no wire.
function fakeSide(frames: string[] = []): SideProcess {
  const stdin = new PassThrough();
  stdin.on("data", (d) => frames.push(String(d)));
  return { stdin, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {}, on: () => {} };
}
const result = (): SideCheck => ({ verdict: "install", key: KEY, facts: { reachable: true, installed: "none" } });

describe("side.check in the hub", () => {
  function hub(opts: Partial<Parameters<typeof createSides>[0]> = {}) {
    const sent: ServerMessage[] = [];
    const forwarded: ClientMessage[] = [];
    const sides = createSides({ targets: [wslSide("Ubuntu"), wslSide("Old")], spawn: () => fakeSide(), key: () => KEY, ...opts });
    const router = createRouter({ sides, send: (m) => sent.push(m), local: async (m) => void forwarded.push(m), localCall: async (m) => ({ type: "reply", reqId: m.reqId, result: {} }), isLocalSession: async () => false });
    return { sides, router, sent, forwarded };
  }
  const ask = (h: ReturnType<typeof hub>, msg: object) => h.router.handle({ ...msg, reqId: "r" } as never);

  it("an unknown side is unknown_side", async () => {
    const h = hub({ check: async () => result() });
    await ask(h, { type: "side.check", side: "wsl:Nope" });
    await ask(h, { type: "side.check" });
    expect(h.sent).toEqual([
      { type: "error", reqId: "r", code: "unknown_side", message: "unknown side wsl:Nope" },
      { type: "error", reqId: "r", code: "unknown_side", message: "unknown side undefined" },
    ]);
  });

  it("replies with the check and never forwards it or starts the side", async () => {
    const spawn = vi.fn(() => fakeSide());
    const check = vi.fn(async () => result());
    const h = hub({ spawn, check });
    await ask(h, { type: "side.check", side: "wsl:Ubuntu" });
    expect(h.sent).toEqual([{ type: "reply", reqId: "r", result: result() }]);
    expect(check).toHaveBeenCalledWith("wsl:Ubuntu");
    expect(spawn).not.toHaveBeenCalled();
    expect(h.forwarded).toEqual([]);
    expect(h.sides.list().find((s) => s.id === "wsl:Ubuntu")!.state).toBe("off");
  });

  it("a ready side answers running at once, nothing executed; a starting one answers starting with its phase", async () => {
    const check = vi.fn(async () => result());
    let phase: ((p: "packing" | "copying" | "installing" | "starting") => void) | undefined;
    const frames: string[] = [];
    const h = hub({ check, spawn: async (id, o) => (id === "wsl:Ubuntu" ? fakeReady(frames) : ((phase = o.phase), await new Promise<SideProcess>(() => {}))) });
    await h.sides.start("wsl:Ubuntu");
    await ask(h, { type: "side.check", side: "wsl:Ubuntu" });
    expect(h.sent.at(-1)).toMatchObject({ type: "reply", result: { verdict: "running", key: KEY, facts: { reachable: true, running: true } } });
    void h.sides.start("wsl:Old");
    await Promise.resolve();
    phase!("copying");
    await ask(h, { type: "side.check", side: "wsl:Old" });
    expect(h.sent.at(-1)).toMatchObject({ result: { verdict: "starting", phase: "copying" } });
    expect(check).not.toHaveBeenCalled();
  });

  it("one check per side at a time", async () => {
    const releases: (() => void)[] = [];
    const check = vi.fn(() => new Promise<SideCheck>((r) => (releases.length < 2 ? releases.push(() => r(result())) : r(result()))));
    const h = hub({ check });
    const a = ask(h, { type: "side.check", side: "wsl:Ubuntu" });
    const b = ask(h, { type: "side.check", side: "wsl:Ubuntu" });
    const other = ask(h, { type: "side.check", side: "wsl:Old" });
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(2);
    releases.forEach((r) => r());
    await Promise.all([a, b, other]);
    expect(h.sent.filter((m) => m.type === "reply")).toHaveLength(3);
    await ask(h, { type: "side.check", side: "wsl:Ubuntu" });
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("no answer in time is blocked unreachable; a throwing check is blocked check_failed", async () => {
    const slow = hub({ check: () => new Promise(() => {}), checkMs: 20 });
    await ask(slow, { type: "side.check", side: "wsl:Ubuntu" });
    expect(slow.sent[0]).toMatchObject({ type: "reply", result: { verdict: "blocked", reason: "unreachable" } });
    const bad = hub({ check: async () => Promise.reject(new Error("boom")) });
    await ask(bad, { type: "side.check", side: "wsl:Ubuntu" });
    expect(bad.sent[0]).toMatchObject({ result: { verdict: "blocked", reason: "check_failed", message: expect.stringContaining("boom") } });
  });

  it("side.start passes the setup mode; a bad one is bad_request; autostart runs with never", async () => {
    const modes: string[] = [];
    const h = hub({ spawn: async (_id, o) => (modes.push(o.setup), fakeReady()) });
    await ask(h, { type: "side.start", side: "wsl:Ubuntu", setup: "force" });
    await ask(h, { type: "side.start", side: "wsl:Old" });
    await ask(h, { type: "side.start", side: "wsl:Old", setup: "bogus" });
    expect(modes).toEqual(["force", "needed"]);
    expect(h.sent.at(-1)).toMatchObject({ type: "error", code: "bad_request" });
    const auto: string[] = [];
    createSides({ targets: [wslSide("A")], saved: ["wsl:A"], spawn: async (_id, o) => (auto.push(o.setup), fakeReady()) });
    await Promise.resolve();
    expect(auto).toEqual(["never"]);
  });

  it("a not_installed exit puts the side back to off (not error) and the phase shows while starting", async () => {
    const out = new PassThrough();
    const exit = new EventEmitter();
    const changes: string[] = [];
    const sides = createSides({ targets: [dockerSide("dev")], key: () => KEY, spawn: () => ({ stdin: new PassThrough(), stdout: out, stderr: new PassThrough(), kill: () => {}, on: (e, l) => exit.on(e, l) }) });
    sides.onChange(() => changes.push(JSON.stringify(sides.list()[1])));
    const started = sides.start("docker:dev", "never").catch((e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 5));
    out.write("CLAUDE_UI_PHASE installing\n");
    await new Promise((r) => setTimeout(r, 5));
    expect(sides.list()[1]).toEqual({ id: "docker:dev", label: "Docker: dev", state: "starting", phase: "installing" });
    out.write("CLAUDE_UI_SETUP not_installed\n");
    await new Promise((r) => setTimeout(r, 5));
    exit.emit("exit", 3);
    expect(await started).toContain("not installed");
    expect(sides.list()[1]).toEqual({ id: "docker:dev", label: "Docker: dev", state: "off" });
  });
});

/** A side process that is ready at once. */
function fakeReady(frames: string[] = []): SideProcess {
  const stdout = new PassThrough();
  const side = fakeSide(frames);
  setTimeout(() => stdout.write('{"ready":true}\n'), 1);
  return { ...side, stdout };
}
