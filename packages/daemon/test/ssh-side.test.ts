import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "../src/docker-side.ts";
import { kindOf, nameOf, sideTarget, startOptIn } from "../src/side-kinds.ts";
import { checkSshSide, listSshHosts, parseSshConfig, prepareSshSide, sshArgs, sshError } from "../src/ssh-side.ts";

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
    expect(listSshHosts(() => { throw new Error("ENOENT"); })).toEqual([]);
    expect(listSshHosts(() => "Host a\nHost b")).toEqual(["a", "b"]);
  });
});

describe("sshArgs", () => {
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
  function run(o: { probe?: { code: number | null; stdout?: string; stderr?: string }; copy?: (n: number, dest: string) => { code: number; stdout?: string; stderr?: string }; setup?: "never" | "needed"; arch?: string; libc?: string } = {}) {
    const calls: { cmd: string; args: string[]; script: string; stdin?: string }[] = [];
    let copies = 0;
    const exec: Exec = async (cmd, args, _t, stdin) => {
      const script = decode(args.at(-1)!);
      calls.push({ cmd, args, script, stdin });
      if (script.includes("uname -m")) return { code: 0, stdout: probeOut(o.arch ?? "x86_64", o.libc), stderr: "", ...o.probe } as { code: number | null; stdout: string; stderr: string };
      const dest = /sh '([^']*)' '[^']*' '[^']*'$/.exec(args.at(-1)!)?.[1] ?? "";
      const r = o.copy?.(copies++, dest) ?? { code: 0, stdout: `${dest}/f\n` };
      return { stdout: "", stderr: "", ...r };
    };
    const phases: string[] = [];
    const cacheRoot = join(dir("home-"), "claude-ui", "side");
    const result = prepareSshSide({ alias: "box", pkgDir: pkg(), key: "1.0.0-1", exec, setup: o.setup, onPhase: (p) => phases.push(p), onInstall: () => {}, bundle: { cacheRoot, version: "1.0.0", fetch: okFetch, parts } });
    return { calls, phases, result };
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
  it("a /tmp that fails moves on to /dev/shm", async () => {
    const r = run({ copy: (n, d) => (n === 0 ? { code: 1, stderr: "Read-only file system" } : { code: 0, stdout: `${d}/x.tar\n` }) });
    expect((await r.result).path).toBe("/dev/shm/x.tar");
  });
  it("auth failure at the probe rejects with the next step", async () => {
    const r = run({ probe: { code: 255, stdout: "", stderr: "box: Permission denied (publickey)." } });
    await expect(r.result).rejects.toThrow("Run `ssh box` once in a terminal");
    expect(r.calls).toHaveLength(1);
  });
  it("a host the bundle does not cover (musl) rejects; the npm fallback is a later ticket", async () => {
    await expect(run({ libc: "musl" }).result).rejects.toThrow("SSH: box: this host is not covered by the claude-ui bundle yet (the host uses musl");
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
  it("an answer that is no check output is check_failed", async () => {
    expect(await check({ code: 0, stdout: "hello" })).toMatchObject({ verdict: "blocked", reason: "check_failed" });
  });
});
