import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_MIN, NODE_MIN_MAJOR } from "@claude-ui/protocol";
import { describe, expect, it } from "vitest";
import type { Exec } from "../src/docker-side.ts";
import type { Runner } from "../src/update.ts";
import { kindOf, nameOf, sideTarget, startOptIn } from "../src/side-kinds.ts";
import { addSshHost, checkSshSide, includeFiles, isWindowsHost, listSshHosts, parseSshCommand, parseSshConfig, prepareSshSide, sshArgs, sshConfigPath, sshError } from "../src/ssh-side.ts";
import { checkScript, setupMessage, setupScript } from "../src/sides.ts";

const dir = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const decode = (remote: string) => Buffer.from(/echo (\S+) \|/.exec(remote)![1]!, "base64").toString();

describe("side kinds", () => {
  it("kindOf, nameOf and sideTarget agree; only ssh is opt-in", () => {
    expect(["wsl:Ubuntu", "docker:dev", "ssh:box", "ssh:a:b", "other:x", "plain"].map(kindOf)).toEqual(["wsl", "docker", "ssh", "ssh", undefined, undefined]);
    expect(nameOf("ssh:a:b")).toBe("a:b");
    expect(sideTarget("ssh", "box")).toEqual({ id: "ssh:box", label: "SSH: box" });
    expect(sideTarget("docker", "dev")).toEqual({ id: "docker:dev", label: "Docker: dev" });
    expect([startOptIn("ssh:box"), startOptIn("docker:dev"), startOptIn("wsl:U")]).toEqual([true, false, false]);
  });
});

describe("parseSshConfig", () => {
  it("lists Host aliases: several per line, Host=, any case, comments, quotes, first occurrence only", () => {
    const text = ["# Host nope", "Host box other # trailing", "  host=third", "HOST   \"quoted\"", "Host box", "Hostname 1.2.3.4", "Match host x"].join("\n");
    expect(parseSshConfig(text)).toEqual(["box", "other", "third", "quoted"]);
  });
  it("skips wildcards, negations, option-like and spaced tokens", () => {
    expect(parseSshConfig("Host * *.corp ?x !bad -oProxyCommand=x \"a b\" good\r\nHost\tok")).toEqual(["good", "ok"]);
  });
  it("listSshHosts: no file reads as none", () => {
    expect(listSshHosts(undefined, { read: () => undefined })).toEqual([]);
    expect(listSshHosts(undefined, { read: () => "Host a\nHost b" })).toEqual(["a", "b"]);
  });
  it("CLAUDE_UI_SSH_CONFIG names the file the hosts are read from", () => {
    expect(sshConfigPath({ CLAUDE_UI_SSH_CONFIG: "/x/cfg" })).toBe("/x/cfg");
    expect(sshConfigPath({ CLAUDE_UI_SSH_CONFIG: "" })).toBeUndefined();
    expect(sshConfigPath({})).toBeUndefined();
    const f = join(dir("cfg-"), "config");
    writeFileSync(f, "Host only-here\n");
    expect(listSshHosts(f)).toEqual(["only-here"]);
    expect(listSshHosts(join(dir("cfg-"), "missing"))).toEqual([]);
  });
});

describe("sshArgs", () => {
  it("a config file goes in as -F before --; none: no -F", () => {
    const a = sshArgs("box", "x", [], "/s/ssh_config");
    expect(a.slice(6, 11)).toEqual(["ServerAliveCountMax=3", "-F", "/s/ssh_config", "--", "box"]);
    expect(sshArgs("box", "x")).not.toContain("-F");
  });
  it("has the fixed options, -- before the alias, and a script that round-trips through base64", () => {
    const script = "echo 'a b'\nexit 3";
    const a = sshArgs("box", script, ["x y", "it's"]);
    expect(a.slice(0, 8)).toEqual(["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "--"]);
    expect(a[8]).toBe("box");
    expect(a).toHaveLength(10);
    expect(decode(a[9]!)).toBe(script);
    expect(a[9]).not.toContain("\n");
    expect(a[9]!.endsWith(`sh 'x y' 'it'\\''s'`)).toBe(true);
  });
});

describe("sshError", () => {
  const e = (stderr: string, code: number | null = 255) => sshError("box", { code, stderr });
  it("auth and host key failures tell to run ssh once in a terminal", () => {
    expect(e("box: Permission denied (publickey).")).toBe("SSH: box: the host refused the login (key or password needed). Run `ssh box` once in a terminal, then retry.");
    expect(e("Too many authentication failures")).toContain("refused the login");
    expect(e("Host key verification failed.")).toBe("SSH: box: the host key is not trusted yet. Run `ssh box` once in a terminal to check and accept it, then retry.");
    expect(e("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!")).toContain("host key is not trusted");
    expect(e("No ED25519 host key is known for box and you have requested strict checking.")).toContain("host key is not trusted");
  });
  it("unreachable keeps the last stderr line; no answer; the remote's own exit is not ssh's", () => {
    expect(e("ssh: Could not resolve hostname box: nodename nor servname provided\n")).toBe("SSH: box is not reachable: ssh: Could not resolve hostname box: nodename nor servname provided.");
    expect(e("ssh: connect to host box port 22: Connection refused")).toContain("Connection refused");
    expect(e("")).toBe("SSH: box is not reachable: ssh failed.");
    expect(e("", null)).toBe("SSH: box did not answer in time.");
    expect(e("Permission denied", 1)).toBeUndefined();
  });
});

describe("prepareSshSide", () => {
  const probeOut = (arch: string, libc = "glibc") => ["arch=" + arch, "libc=" + libc, "glibc=2.36", "cxxrt=1"].map((l) => `CLAUDE_UI_CHECK ${l}`).join("\n");
  const pkg = () => {
    const d = dir("pkg-");
    mkdirSync(join(d, "dist", "side"), { recursive: true });
    mkdirSync(join(d, "dist", "web"));
    writeFileSync(join(d, "dist", "cli.js"), "");
    writeFileSync(join(d, "dist", "web", "index.html"), "");
    writeFileSync(join(d, "dist", "side", "cli.js"), "side");
    writeFileSync(join(d, "dist", "side", "side.json"), JSON.stringify({ sdk: "0.3.1" }));
    return d;
  };
  const sha = (b: string) => createHash("sha256").update(b).digest("hex");
  const parts = () => [{ file: "node.tar.gz", label: "Node.js", url: "https://n/node", sha256: sha("node") }];
  const okFetch = (async () => new Response("node")) as unknown as typeof fetch;
  function run(o: { probe?: { code: number | null; stdout?: string; stderr?: string }; copy?: (n: number, dest: string) => { code: number; stdout?: string; stderr?: string }; setup?: "never" | "needed" | "force"; pinned?: boolean; bundleOnly?: boolean; installed?: "current" | "other"; arch?: string; libc?: string; config?: string } = {}) {
    const calls: { cmd: string; args: string[]; script: string; stdin?: string }[] = [];
    let copies = 0;
    const exec: Exec = async (cmd, args, _t, stdin) => {
      const script = decode(args.at(-1)!);
      calls.push({ cmd, args, script, stdin });
      if (script.includes("uname -m")) return { code: 0, stdout: probeOut(o.arch ?? "x86_64", o.libc) + (o.installed ? `\nCLAUDE_UI_CHECK installed=${o.installed}` : ""), stderr: "", ...o.probe } as { code: number | null; stdout: string; stderr: string };
      const dest = /sh '([^']*)' '[^']*' '[^']*'$/.exec(args.at(-1)!)?.[1] ?? "";
      const r = o.copy?.(copies++, dest) ?? { code: 0, stdout: `${dest}/f\n` };
      return { stdout: "", stderr: "", ...r };
    };
    const phases: string[] = [];
    const cacheRoot = join(dir("home-"), "claude-ui", "side");
    const installs: unknown[] = [];
    const npm: Runner = async (_c, args) => {
      writeFileSync(join(args[args.indexOf("--pack-destination") + 1]!, "claude-code-ui-1.0.0.tgz"), "tgz");
      return { code: 0, output: "" };
    };
    const result = prepareSshSide({ alias: "box", pkgDir: pkg(), key: "1.0.0-1", cacheDir: join(dir("pack-"), "side-pack"), npm, exec, config: o.config, setup: o.setup, pinned: o.pinned, bundleOnly: o.bundleOnly, onPhase: (p) => phases.push(p), onInstall: (i) => installs.push(i), bundle: { cacheRoot, version: "1.0.0", fetch: okFetch, parts } });
    return { calls, phases, installs, result };
  }

  it("probes over ssh, then streams the assembled tar as stdin of ssh, with the phases", async () => {
    const r = run();
    const out = await r.result;
    expect(out.path).toBe("/tmp/f");
    expect(out.bundle?.target).toBe("linux-x64");
    expect(r.phases).toEqual(["downloading", "packing", "copying"]);
    expect(r.calls.every((c) => c.cmd === "ssh" && c.args.includes("BatchMode=yes"))).toBe(true);
    expect(r.calls[0]!.script).toContain("uname -m");
    expect(r.calls[0]!.stdin).toBeUndefined();
    expect(r.calls[1]!.stdin).toMatch(/bundle-.*\.tar$/);
    expect(r.calls[1]!.script).toContain("cat >");
  });
  it("with a config file every ssh run passes -F before --", async () => {
    const r = run({ config: "/s/cfg" });
    await r.result;
    expect(r.calls.length).toBeGreaterThan(1);
    for (const c of r.calls) expect(c.args.slice(c.args.indexOf("-F"), c.args.indexOf("--"))).toEqual(["-F", "/s/cfg"]);
  });
  it("a /tmp that fails moves on to /dev/shm", async () => {
    const r = run({ copy: (n, d) => (n === 0 ? { code: 1, stderr: "Read-only file system" } : { code: 0, stdout: `${d}/x.tar\n` }) });
    expect((await r.result).path).toBe("/dev/shm/x.tar");
  });
  it("auth failure at the probe rejects with the next step", async () => {
    const r = run({ probe: { code: 255, stdout: "", stderr: "box: Permission denied (publickey)." } });
    await expect(r.result).rejects.toThrow("Run `ssh box` once in a terminal");
    expect(r.calls).toHaveLength(1);
  });
  it("a host the bundle does not cover (musl) gets the npm tarball over ssh stdin, with the reason", async () => {
    const r = run({ libc: "musl" });
    const out = await r.result;
    expect(out.path).toBe("/tmp/f");
    expect(out.bundle).toBeUndefined();
    expect(r.installs).toEqual([{ fallback: expect.stringContaining("the host uses musl") }]);
    expect(r.phases).toEqual(["packing", "copying"]);
    expect(r.calls[1]!.stdin).toMatch(/\.tgz$/);
    expect(r.calls[1]!.script).toContain("cat >");
  });
  it("another arch and macOS-like hosts (no glibc) install with npm too", async () => {
    expect((await run({ arch: "riscv64" }).result).bundle).toBeUndefined();
    expect((await run({ arch: "arm64", libc: "unknown" }).result).path).toBe("/tmp/f");
  });
  it("an automatic update (bundleOnly) never uses npm: the installed build runs", async () => {
    const r = run({ libc: "musl", bundleOnly: true });
    expect(await r.result).toEqual({ path: "", never: true });
    expect(r.calls).toHaveLength(1);
  });
  it("a Windows host (its OS name, or a cmd.exe or PowerShell shell without sh) is refused", async () => {
    await expect(run({ probe: { code: 0, stdout: "CLAUDE_UI_CHECK os=MINGW64_NT-10.0" } }).result).rejects.toThrow("Windows SSH hosts are not supported yet");
    await expect(run({ probe: { code: 1, stdout: "", stderr: "'sh' is not recognized as an internal or external command," } }).result).rejects.toThrow("Windows SSH hosts are not supported yet");
    await expect(run({ probe: { code: 1, stdout: "", stderr: "sh : The term 'sh' is not recognized as the name of a cmdlet" } }).result).rejects.toThrow("Windows SSH hosts are not supported yet");
    expect(isWindowsHost({ stdout: "CLAUDE_UI_CHECK os=Linux", stderr: "" })).toBe(false);
  });
  it("this build already installed: nothing is packed or sent, one ssh run; force and a pinned Node.js install again", async () => {
    const same = run({ installed: "current" });
    expect(await same.result).toEqual({ path: "", never: true });
    expect(same.calls).toHaveLength(1);
    expect(same.phases).toEqual([]);
    expect((await run({ installed: "current", setup: "force" }).result).path).toBe("/tmp/f");
    expect((await run({ installed: "current", pinned: true }).result).path).toBe("/tmp/f");
    expect((await run({ installed: "other" }).result).path).toBe("/tmp/f");
  });
  it("setup never runs nothing over ssh", async () => {
    const r = run({ setup: "never" });
    expect(await r.result).toEqual({ path: "" });
    expect(r.calls).toEqual([]);
  });
});

describe("checkSshSide", () => {
  const check = (r: { code: number | null; stdout?: string; stderr?: string }) => checkSshSide({ alias: "box", pkgDir: dir("pkg-"), key: "k", exec: async () => ({ stdout: "", stderr: "", ...r }) as { code: number | null; stdout: string; stderr: string } });
  it("ssh failures are blocked as unreachable with the ssh message", async () => {
    const c = await check({ code: 255, stderr: "Host key verification failed." });
    expect(c).toMatchObject({ verdict: "blocked", reason: "unreachable" });
    expect(c.message).toContain("Run `ssh box` once in a terminal");
  });
  it("the check passes -F too", async () => {
    let args: string[] = [];
    await checkSshSide({ alias: "box", config: "/s/cfg", pkgDir: dir("pkg-"), key: "k", exec: async (_c, a) => ((args = a), { code: 255, stdout: "", stderr: "x" }) });
    expect(args.slice(args.indexOf("-F"), args.indexOf("--"))).toEqual(["-F", "/s/cfg"]);
  });
  it("an answer that is no check output is check_failed", async () => {
    expect(await check({ code: 0, stdout: "hello" })).toMatchObject({ verdict: "blocked", reason: "check_failed" });
  });
});

describe("prepareSshSide: ssh failing during the copy", () => {
  it("is reported as the ssh message, not retried as no writable path", async () => {
    const d = dir("pkg-");
    mkdirSync(join(d, "dist", "side"), { recursive: true });
    mkdirSync(join(d, "dist", "web"));
    for (const [f, c] of [["cli.js", ""], ["web/index.html", ""], ["side/cli.js", "side"], ["side/side.json", '{"sdk":"0.3.1"}']] as const) writeFileSync(join(d, "dist", f), c);
    let copies = 0;
    const exec: Exec = async (_c, args) => {
      const script = decode(args.at(-1)!);
      if (script.includes("uname -m")) return { code: 0, stdout: ["arch=x86_64", "libc=glibc", "glibc=2.36", "cxxrt=1"].map((l) => `CLAUDE_UI_CHECK ${l}`).join("\n"), stderr: "" };
      copies++;
      return { code: 255, stdout: "", stderr: "Connection reset by peer" };
    };
    const sha = createHash("sha256").update("node").digest("hex");
    await expect(prepareSshSide({ alias: "box", pkgDir: d, key: "k", cacheDir: join(dir("p-"), "pack"), exec, bundle: { cacheRoot: join(dir("h-"), "claude-ui", "side"), version: "1.0.0", fetch: (async () => new Response("node")) as unknown as typeof fetch, parts: () => [{ file: "node.tar.gz", label: "Node.js", url: "https://n/node", sha256: sha }] } })).rejects.toThrow("is not reachable: Connection reset by peer");
    expect(copies).toBe(1);
  });
});

describe("the side's version check", () => {
  it.skipIf(process.platform === "win32")("accepts a release number and the `dev` of a source checkout, nothing else", async () => {
    const { VER_FN } = await import("../src/side-bundle.ts");
    const { execFileSync } = await import("node:child_process");
    const ok = (out: string) => { try { execFileSync("sh", ["-c", `${VER_FN}\nv() { echo "$OUT"; }\nver v x`], { stdio: "ignore", env: { OUT: out } }); return true; } catch { return false; } };
    expect([ok("1.2.3"), ok("dev"), ok("error"), ok("")]).toEqual([true, true, false, false]);
  });
});

describe("Include", () => {
  const tree = () => {
    const home = dir("home-");
    const ssh = join(home, ".ssh");
    mkdirSync(join(ssh, "conf.d"), { recursive: true });
    const w = (f: string, t: string) => writeFileSync(join(ssh, f), t);
    return { home, ssh, w, cfg: join(ssh, "config") };
  };
  it("follows relative globs in order, wildcards skipped, the first alias wins, a missing include is ignored", () => {
    const t = tree();
    t.w("config", "Include conf.d/*.conf missing/*.conf\nHost main *.corp !x\nHost a");
    t.w("conf.d/a.conf", "Host a *.x ?y\n");
    t.w("conf.d/b.conf", "Host main b !neg\n");
    t.w("conf.d/skip.txt", "Host skipped\n");
    expect(listSshHosts(t.cfg, {}, t.home)).toEqual(["a", "main", "b"]);
  });
  it("follows ~ and absolute paths, nested includes, and stops on a cycle", () => {
    const t = tree();
    const other = join(dir("abs-"), "extra");
    writeFileSync(other, "Host abs\n");
    t.w("config", `Include ~/.ssh/more "${other}"\nHost top`);
    t.w("more", "Host mid\nInclude config conf.d/n\n");
    t.w("conf.d/n", "Host nested\n");
    expect(listSshHosts(t.cfg, {}, t.home)).toEqual(["mid", "nested", "abs", "top"]);
  });
  it("a custom config file resolves relative includes against its own folder", () => {
    const d = dir("cfg-");
    writeFileSync(join(d, "inc"), "Host inc\n");
    writeFileSync(join(d, "c"), "Include inc\n");
    expect(listSshHosts(join(d, "c"))).toEqual(["inc"]);
  });
  it("hand edits show on the next read", () => {
    const t = tree();
    t.w("config", "Host one\n");
    expect(listSshHosts(t.cfg, {}, t.home)).toEqual(["one"]);
    t.w("config", "Host one two\n");
    expect(listSshHosts(t.cfg, {}, t.home)).toEqual(["one", "two"]);
  });
  it("includeFiles: * and ? match within a segment, dot files only by a dot pattern", () => {
    const t = tree();
    for (const f of ["a1.conf", "a2.conf", "b.conf", ".hid.conf"]) t.w(`conf.d/${f}`, "");
    const names = (p: string) => includeFiles(p, t.ssh, t.home).map((f) => f.slice(t.ssh.length + 1));
    expect(names("conf.d/a?.conf")).toEqual(["conf.d/a1.conf", "conf.d/a2.conf"]);
    expect(names("conf.d/*.conf")).toEqual(["conf.d/a1.conf", "conf.d/a2.conf", "conf.d/b.conf"]);
    expect(names("conf.d/.*.conf")).toEqual(["conf.d/.hid.conf"]);
    expect(names("*/b.conf")).toEqual(["conf.d/b.conf"]);
  });
});

describe("parseSshCommand", () => {
  it("reads user@host with -p, -i, -J and -l, with or without the leading ssh and attached values", () => {
    expect(parseSshCommand("ssh dev@example.com -p 2222 -i ~/.ssh/key -J jump@bastion:22")).toEqual({ host: "example.com", user: "dev", port: 2222, identity: "~/.ssh/key", jump: "jump@bastion:22" });
    expect(parseSshCommand("example.com")).toEqual({ host: "example.com" });
    expect(parseSshCommand("-p2200 -l bob -Jj ssh-host")).toEqual({ host: "ssh-host", user: "bob", port: 2200, jump: "j" });
    expect(parseSshCommand('ssh -i "/Users/a b/key" box')).toMatchObject({ identity: "/Users/a b/key" });
    expect(parseSshCommand("ssh a@b@host")).toMatchObject({ user: "a@b", host: "host" });
  });
  it("refuses what it cannot write safely, with the reason", () => {
    expect(() => parseSshCommand("ssh")).toThrow("No host found");
    expect(() => parseSshCommand("ssh -p")).toThrow("needs a value");
    expect(() => parseSshCommand("ssh -p abc host")).toThrow('"abc" is not a port');
    expect(() => parseSshCommand("ssh -p 70000 host")).toThrow("not a port");
    expect(() => parseSshCommand("ssh -X host")).toThrow("-X is not supported");
    expect(() => parseSshCommand("ssh host ls -la")).toThrow('Unexpected "ls"');
    expect(() => parseSshCommand("ssh -oProxyCommand=x host")).toThrow("-o is not supported");
    expect(() => parseSshCommand("ssh bad/host")).toThrow("not a valid host name");
    expect(() => parseSshCommand("ssh -J -oX host")).toThrow("characters that are not allowed");
    expect(() => parseSshCommand('ssh -i "k\nProxyCommand x" host')).toThrow("not allowed");
  });
});

describe("addSshHost", () => {
  const files = () => {
    const home = dir("home-");
    return { home, cfg: join(home, ".ssh", "config") };
  };
  it("creates ~/.ssh/config with safe permissions and writes the Host block; the host is listed at once", () => {
    const { home, cfg } = files();
    expect(addSshHost({ command: "ssh dev@example.com -p 2222 -i ~/.ssh/key -J jump", home })).toBe("example.com");
    expect(readFileSync(cfg, "utf8")).toBe("# Added by Claude UI\nHost example.com\n  HostName example.com\n  User dev\n  Port 2222\n  IdentityFile ~/.ssh/key\n  ProxyJump jump\n");
    if (process.platform !== "win32") expect([statSync(cfg).mode & 0o777, statSync(join(home, ".ssh")).mode & 0o777]).toEqual([0o600, 0o700]);
    expect(listSshHosts(undefined, {}, home)).toEqual(["example.com"]);
  });
  it("a given alias is used; the file is appended to, not rewritten, and keeps its mode", () => {
    const { home, cfg } = files();
    addSshHost({ command: "ssh a.example.com", alias: "first", home });
    writeFileSync(cfg, "Host old\n  HostName x", { mode: 0o644 });
    addSshHost({ command: "ssh b.example.com -i '/p q/key'", alias: " second ", home });
    expect(readFileSync(cfg, "utf8")).toBe('Host old\n  HostName x\n\n# Added by Claude UI\nHost second\n  HostName b.example.com\n  IdentityFile "/p q/key"\n');
    expect(listSshHosts(undefined, {}, home)).toEqual(["old", "second"]);
  });
  it("refuses an alias that exists, also one of an included file, and writes nothing", () => {
    const { home, cfg } = files();
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "extra"), "Host inc\n");
    writeFileSync(cfg, "Include extra\nHost box\n");
    const before = readFileSync(cfg, "utf8");
    expect(() => addSshHost({ command: "ssh box", home })).toThrow('The host "box" already exists in the ssh config');
    expect(() => addSshHost({ command: "ssh other.example.com", alias: "inc", home })).toThrow('"inc" already exists');
    expect(readFileSync(cfg, "utf8")).toBe(before);
  });
  it("refuses a bad command or alias and creates no file", () => {
    const { home, cfg } = files();
    expect(() => addSshHost({ command: "ssh -X host", home })).toThrow("not supported");
    expect(() => addSshHost({ command: "ssh host", alias: "a b", home })).toThrow("cannot be a host alias");
    expect(() => addSshHost({ command: "ssh host", alias: "*", home })).toThrow("cannot be a host alias");
    expect(() => addSshHost({ command: "ssh host", alias: "-oX", home })).toThrow("cannot be a host alias");
    expect(existsSync(cfg)).toBe(false);
  });
  it("a custom config path (CLAUDE_UI_SSH_CONFIG) is the file written", () => {
    const f = join(dir("c-"), "sub", "cfg");
    addSshHost({ command: "ssh h.example.com", config: f });
    expect(listSshHosts(f)).toEqual(["h.example.com"]);
  });
});

describe("checkSshSide: hosts the bundle does not cover", () => {
  const out = (o: Record<string, string>) => Object.entries({ node: "24.1.0", foundnode: "1", make: "1", python3: "1", cxx: "1", writable: "/tmp,$HOME", arch: "arm64", libc: "unknown", cxxrt: "0", tar: "1", gzip: "1", git: "1", npm: "1", bundled: "0", installed: "none", os: "Darwin", ...o }).map(([k, v]) => `CLAUDE_UI_CHECK ${k}=${v}`).join("\n");
  const pkg = () => {
    const d = dir("pkg-");
    mkdirSync(join(d, "dist", "web"), { recursive: true });
    mkdirSync(join(d, "dist", "side"));
    for (const [f, c] of [["cli.js", ""], ["web/index.html", ""], ["side/cli.js", "x"], ["side/side.json", '{"sdk":"0.3.1"}']] as const) writeFileSync(join(d, "dist", f), c);
    return d;
  };
  const check = (o: Record<string, string>, raw?: { code: number; stdout: string; stderr: string }) => checkSshSide({ alias: "box", pkgDir: pkg(), key: "k", exec: async () => raw ?? { code: 0, stdout: out(o), stderr: "" } });
  it("macOS with Node.js and npm: install with npm, the reason says why", async () => {
    const c = await check({});
    expect(c).toMatchObject({ verdict: "install", facts: { install: { method: "npm" }, nodeOk: true } });
  });
  it("Windows is blocked with its message; no Node.js, no npm and no writable folder each name what is missing", async () => {
    expect(await check({ os: "MINGW64_NT" })).toMatchObject({ verdict: "blocked", reason: "windows_host", message: "SSH: box: Windows SSH hosts are not supported yet." });
    expect(await check({}, { code: 1, stdout: "", stderr: "'sh' is not recognized as an internal or external command" })).toMatchObject({ reason: "windows_host" });
    expect(await check({ node: "none", foundnode: "0" })).toMatchObject({ reason: "node_missing", message: expect.stringContaining("Node.js is not installed") });
    expect(await check({ npm: "0" })).toMatchObject({ reason: "npm_missing", message: expect.stringContaining("npm is not installed on SSH: box") });
    expect(await check({ writable: "" })).toMatchObject({ reason: "no_writable_path", message: expect.stringContaining("home folder are not writable") });
  });
  it("a macOS Node.js is usable (the posix rule): the check script asks for it", () => {
    expect(checkScript("k", "ssh")).toContain('usable_node "$na" posix &&');
    expect(checkScript("k", "docker")).not.toContain('"$na" posix');
    expect(checkScript("k", "ssh")).toContain("claude-agent-sdk-*-*");
    expect(checkScript("k", "ssh").trimEnd().endsWith('emit os "$(uname -s 2>/dev/null)"')).toBe(true);
  });
});

describe("setup script of a host", () => {
  it("npm install: the host's own Node.js (macOS and BSD allowed), npm and a writable home checked first, any platform's SDK binary", () => {
    const s = setupScript("/tmp/x.tgz", "1.0-abc", "ssh", "needed");
    expect(s).toContain('usable_node "" posix ||');
    expect(s).toContain("command -v npm >/dev/null 2>&1 || say npm_missing");
    expect(s).toContain('mkdir -p "$root" 2>/dev/null && [ -w "$root" ] || say home_not_writable');
    expect(s).toContain("claude-agent-sdk-*-*");
    expect(s).toContain('[ "$d" = "$dir" ] || rm -rf "$d"');
  });
  it("bundle install checks the home folder too; never reads only; Docker and WSL scripts are unchanged", () => {
    const b = { target: "linux-x64" as const, claudePackage: "claude-agent-sdk-linux-x64" };
    expect(setupScript("/tmp/x.tar", "k", "ssh", "needed", b)).toContain("say home_not_writable");
    expect(setupScript("", "k", "ssh", "never")).not.toContain("home_not_writable");
    for (const k of ["docker", "wsl"] as const) {
      const s = setupScript("/tmp/x.tgz", "k", k, "needed");
      expect(s).not.toContain("npm_missing");
      expect(s).not.toContain('usable_node "" posix');
      expect(s).not.toContain("home_not_writable");
    }
  });
  it("messages name what is missing on the host", () => {
    expect(setupMessage("node_missing", "", "SSH: box", "host")).toBe(`Node.js ${NODE_MIN} or newer is not installed on SSH: box. Install it there (e.g. nvm install ${NODE_MIN_MAJOR}), then retry.`);
    expect(setupMessage("npm_missing", "", "SSH: box", "host")).toContain("npm is not installed on SSH: box");
    expect(setupMessage("home_not_writable", "", "SSH: box", "host")).toContain("no writable home folder");
    expect(setupMessage("unpack_tools_missing", "", "SSH: box", "host")).toContain("on the host");
  });
});
