import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { checkDockerSide, cpUsable, dockerStatus, folderPath, listContainers, parseContainers, prepareDockerSide, underDist, type Exec } from "../src/docker-side.ts";
import type { Runner } from "../src/update.ts";

// `docker inspect -f` output of the mounts check: read-only root flag, `<dest> <rw>` lines, the tmpfs map as JSON.
const RO_ROOT = "true\n\nnull\n";
const WRITABLE = "false\n/data true\nnull\n";
const isMounts = (args: string[]) => args[0] === "inspect" && String(args[2]).includes("ReadonlyRootfs");
const dir =(p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
type Answer = { code: number | null; stdout?: string; stderr?: string };
function fake(answers: Record<string, Answer>) {
  const calls: string[][] = [];
  const stdin: (string | undefined)[] = [];
  const exec: Exec = async (cmd, args, _t, stdinFile) => (calls.push([cmd, ...args]), stdin.push(stdinFile), { stdout: "", stderr: "", ...(answers[isMounts(args) ? "mounts" : args[0]!] ?? (isMounts(args) ? { code: 0, stdout: RO_ROOT } : { code: 0 })) } as { code: number | null; stdout: string; stderr: string });
  return { calls, stdin, exec };
}
function fakeNpm(result: { code: number | null; output: string } = { code: 0, output: "" }) {
  const calls: string[][] = [];
  const npm: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (result.code === 0) writeFileSync(join(args[args.indexOf("--pack-destination") + 1]!, "claude-code-ui-0.2.0.tgz"), "tgz");
    return result;
  };
  return { calls, npm };
}
const pkg = () => {
  const d = dir("pkg-");
  mkdirSync(join(d, "dist"));
  writeFileSync(join(d, "dist", "cli.js"), "");
  mkdirSync(join(d, "dist", "web"));
  writeFileSync(join(d, "dist", "web", "index.html"), "");
  return d;
};

describe("docker sides", () => {
  it("parses docker ps names: first name per line, no k8s pod containers, no blank or invalid lines", () => {
    expect(parseContainers("dev\r\nweb,web-alias\nk8s_POD_x\n\n bad name\napi\n")).toEqual(["dev", "web", "api"]);
  });

  it("no Docker sides without the CLI, with the engine down or with Windows containers", async () => {
    for (const version of [{ code: null, stderr: "spawn docker ENOENT" }, { code: 1 }, { code: 0, stdout: "windows\n" }]) {
      const f = fake({ version });
      expect(await listContainers(f.exec)).toEqual([]);
      expect(f.calls.some((c) => c[1] === "ps")).toBe(false);
    }
  });

  it("tells the Docker state: down (no CLI, engine down, Windows containers, ps fails), empty (nothing runs, only k8s_*), ok", async () => {
    for (const version of [{ code: null, stderr: "spawn docker ENOENT" }, { code: 1 }, { code: 0, stdout: "windows\n" }]) expect((await dockerStatus(fake({ version }).exec)).state).toBe("down");
    const linux = { code: 0, stdout: "linux\n" };
    expect(await dockerStatus(fake({ version: linux, ps: { code: 1 } }).exec)).toEqual({ state: "down", containers: [] });
    expect(await dockerStatus(fake({ version: linux, ps: { code: 0, stdout: "" } }).exec)).toEqual({ state: "empty", containers: [] });
    expect(await dockerStatus(fake({ version: linux, ps: { code: 0, stdout: "k8s_POD_a\nk8s_b\n" } }).exec)).toEqual({ state: "empty", containers: [] });
    expect(await dockerStatus(fake({ version: linux, ps: { code: 0, stdout: "k8s_POD_a\ndev\n" } }).exec)).toEqual({ state: "ok", containers: ["dev"] });
  });

  it("lists running Linux containers", async () => {
    const f = fake({ version: { code: 0, stdout: "linux\n" }, ps: { code: 0, stdout: "dev\nk8s_x\n" } });
    expect(await listContainers(f.exec)).toEqual(["dev"]);
    expect(f.calls).toEqual([
      ["docker", "version", "--format", "{{.Server.Os}}"],
      ["docker", "ps", "--filter", "status=running", "--format", "{{.Names}}"],
    ]);
  });

  it("a stopped or missing container fails before anything is copied", async () => {
    const n = fakeNpm();
    const base = { pkgDir: pkg(), key: "0.2.0-1", cacheDir: dir("cache-"), npm: n.npm };
    const stopped = fake({ inspect: { code: 0, stdout: "false\n" } });
    await expect(prepareDockerSide({ ...base, name: "dev", exec: stopped.exec })).rejects.toThrow("Docker: dev is not running. Start it (docker start dev), then retry.");
    const gone = fake({ inspect: { code: 1, stderr: "Error: No such object: dev" } });
    await expect(prepareDockerSide({ ...base, name: "dev", exec: gone.exec })).rejects.toThrow("Docker: dev no longer exists. Pick another container.");
    expect([...stopped.calls, ...gone.calls].some((c) => c[1] === "cp")).toBe(false);
    expect(n.calls).toEqual([]);
  });

  const execs = (f: { calls: string[][] }) => f.calls.filter((c) => c[1] === "exec");
  const tgzOf = (cacheDir: string, key: string) => join(cacheDir, key, "claude-code-ui-0.2.0.tgz");

  it("packs the package once per build and streams it into the container through docker exec stdin, not docker cp", async () => {
    const pkgDir = pkg();
    const cacheDir = dir("cache-");
    const n = fakeNpm();
    const f = fake({ inspect: { code: 0, stdout: "true\n" }, exec: { code: 0, stdout: "/tmp/claude-ui-side-0.2.0-1.tgz\n" } });
    const run = (key: string) => prepareDockerSide({ name: "dev", pkgDir, key, cacheDir, exec: f.exec, npm: n.npm }).then((r) => r.path);
    expect(await run("0.2.0-1")).toBe("/tmp/claude-ui-side-0.2.0-1.tgz");
    expect(n.calls).toEqual([["npm", "pack", pkgDir, "--ignore-scripts", "--pack-destination", join(cacheDir, "0.2.0-1.partial"), "--loglevel=error"]]);
    expect(f.calls.some((c) => c[1] === "cp")).toBe(false);
    expect(execs(f)).toHaveLength(1);
    expect(execs(f)[0]!.slice(0, 5)).toEqual(["docker", "exec", "-i", "dev", "sh"]);
    expect(execs(f)[0]!.join(" ")).toContain("cat >");
    expect(execs(f)[0]!.slice(-3, -1)).toEqual(["/tmp", "claude-ui-side-0.2.0-1.tgz"]);
    expect(f.stdin[f.calls.findIndex((c) => c[1] === "exec")]).toBe(tgzOf(cacheDir, "0.2.0-1"));
    await run("0.2.0-1");
    expect(n.calls).toHaveLength(1);
    expect(execs(f)).toHaveLength(2);
    await run("0.2.0-2");
    expect(n.calls).toHaveLength(2);
    expect(readdirSync(cacheDir)).toEqual(["0.2.0-2"]);
  });

  it("a read-only root file system with a tmpfs /tmp: the tarball goes to /tmp", async () => {
    const f = fake({ inspect: { code: 0, stdout: "true\n" }, exec: { code: 0, stdout: "/tmp/claude-ui-side-k.tgz\n" } });
    expect((await prepareDockerSide({ name: "esaca", pkgDir: pkg(), key: "k", cacheDir: dir("cache-"), exec: f.exec, npm: fakeNpm().npm })).path).toBe("/tmp/claude-ui-side-k.tgz");
  });

  it("when /tmp is not writable it tries /dev/shm, then $HOME, and answers with the path that took the tarball", async () => {
    const tried: string[] = [];
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "inspect") return { code: 0, stdout: isMounts(args) ? RO_ROOT : "true\n", stderr: "" };
      const dirArg = args[args.length - 3]!;
      tried.push(dirArg);
      return dirArg === "HOME" ? { code: 0, stdout: "/home/esaca/claude-ui-side-k.tgz\n", stderr: "" } : { code: 1, stdout: "", stderr: `sh: 1: cannot create ${dirArg}/claude-ui-side-k.tgz: Read-only file system
` };
    };
    expect((await prepareDockerSide({ name: "esaca", pkgDir: pkg(), key: "k", cacheDir: dir("cache-"), exec, npm: fakeNpm().npm })).path).toBe("/home/esaca/claude-ui-side-k.tgz");
    expect(tried).toEqual(["/tmp", "/dev/shm", "HOME"]);
  });

  it("no writable path: the message names the tried paths; a fully read-only file system is said so", async () => {
    const ro = fake({ inspect: { code: 0, stdout: "true\n" }, exec: { code: 1, stderr: "sh: 1: cannot create /tmp/x.tgz: Read-only file system\n" } });
    const err = await prepareDockerSide({ name: "dev", pkgDir: pkg(), key: "k", cacheDir: dir("cache-"), exec: ro.exec, npm: fakeNpm().npm }).catch((e: Error) => e.message);
    expect(err).toContain("Copying claude-ui into Docker: dev failed");
    expect(err).toContain("/tmp, /dev/shm, $HOME");
    expect(err).toMatch(/file system is read-only/);
    const other = fake({ inspect: { code: 0, stdout: "true\n" }, exec: { code: 1, stderr: "cat: write error: No space left on device\n" } });
    const err2 = await prepareDockerSide({ name: "dev", pkgDir: pkg(), key: "k", cacheDir: dir("cache-"), exec: other.exec, npm: fakeNpm().npm }).catch((e: Error) => e.message);
    expect(err2).toContain("/tmp, /dev/shm, $HOME");
    expect(err2).toContain("No space left on device");
    expect(err2).not.toMatch(/file system is read-only/);
  });

  describe("docker cp first, docker exec stdin as the fallback", () => {
    const cps = (f: { calls: string[][] }) => f.calls.filter((c) => c[1] === "cp");
    const mountCalls = (f: { calls: string[][] }) => f.calls.filter((c) => isMounts(c.slice(1)));
    const go = (f: { exec: Exec }, cacheDir = dir("cache-")) => prepareDockerSide({ name: "dev", pkgDir: pkg(), key: "k", cacheDir, exec: f.exec, npm: fakeNpm().npm }).then((r) => r.path);

    it("the check prints only the needed fields, never the environment", async () => {
      const f = fake({ inspect: { code: 0, stdout: "true\n" }, mounts: { code: 0, stdout: WRITABLE } });
      await go(f);
      expect(mountCalls(f)).toHaveLength(1);
      const format = mountCalls(f)[0]![3]!;
      expect(format).toContain("{{.HostConfig.ReadonlyRootfs}}");
      expect(format).toContain("{{range .Mounts}}{{.Destination}} {{.RW}}");
      expect(format).toContain("{{json .HostConfig.Tmpfs}}");
      expect(format).not.toMatch(/Env/);
      expect(format).not.toContain("{{json .}}");
    });

    it("everything writable: only docker cp is called", async () => {
      const cacheDir = dir("cache-");
      const f = fake({ inspect: { code: 0, stdout: "true\n" }, mounts: { code: 0, stdout: WRITABLE } });
      expect(await go(f, cacheDir)).toBe("/tmp/claude-ui-side-k.tgz");
      expect(cps(f)).toEqual([["docker", "cp", tgzOf(cacheDir, "k"), "dev:/tmp/claude-ui-side-k.tgz"]]);
      expect(execs(f)).toEqual([]);
    });

    it("a read-only mount, a read-only root or a mount or tmpfs on /tmp: docker cp is never called, exec is used", async () => {
      for (const stdout of ["false\n/data false\nnull\n", "true\n\nnull\n", "false\n/tmp true\nnull\n", 'false\n\n{"/tmp":"rw,size=64m"}\n']) {
        const f = fake({ inspect: { code: 0, stdout: "true\n" }, mounts: { code: 0, stdout }, exec: { code: 0, stdout: "/tmp/x.tgz\n" } });
        expect(await go(f)).toBe("/tmp/x.tgz");
        expect(cps(f)).toEqual([]);
        expect(execs(f)).toHaveLength(1);
      }
    });

    it("cpUsable reads the inspect output", () => {
      expect(cpUsable(WRITABLE)).toBe(true);
      expect(cpUsable("false\n/var/lib/data true\n/tmp/sub true\nnull\n")).toBe(true);
      expect(cpUsable('false\n\n{"/run":"rw"}\n')).toBe(true);
      expect(cpUsable("false\n/tmp/sub false\nnull\n")).toBe(false);
      expect(cpUsable("")).toBeUndefined();
      expect(cpUsable("false\n\nnot json\n")).toBeUndefined();
    });

    it("docker cp fails: the exec fallback takes the file", async () => {
      const f = fake({ inspect: { code: 0, stdout: "true\n" }, mounts: { code: 0, stdout: WRITABLE }, cp: { code: 1, stderr: "Error: unlinkat /tmp: device or resource busy\n" }, exec: { code: 0, stdout: "/tmp/claude-ui-side-k.tgz\n" } });
      expect(await go(f)).toBe("/tmp/claude-ui-side-k.tgz");
      expect(cps(f)).toHaveLength(1);
      expect(execs(f)).toHaveLength(1);
    });

    it("the check fails: docker cp is tried anyway, then the fallback", async () => {
      const ok = fake({ inspect: { code: 0, stdout: "true\n" }, mounts: { code: 1, stderr: "boom" } });
      expect(await go(ok)).toBe("/tmp/claude-ui-side-k.tgz");
      expect(cps(ok)).toHaveLength(1);
      expect(execs(ok)).toHaveLength(0);
      const bad = fake({ inspect: { code: 0, stdout: "true\n" }, mounts: { code: 1, stderr: "boom" }, cp: { code: 1, stderr: "cp: no" }, exec: { code: 0, stdout: "/dev/shm/x.tgz\n" } });
      expect(await go(bad)).toBe("/dev/shm/x.tgz");
      expect(cps(bad)).toHaveLength(1);
      expect(execs(bad)).toHaveLength(1);
    });

    it("both fail: the message says docker cp was tried first and why it failed, then the exec reason", async () => {
      const f = fake({ inspect: { code: 0, stdout: "true\n" }, mounts: { code: 0, stdout: WRITABLE }, cp: { code: 1, stderr: "Error response from daemon: rootfs is marked read-only\n" }, exec: { code: 1, stderr: "cat: write error: No space left on device\n" } });
      const err = await go(f).catch((e: Error) => e.message);
      expect(err).toContain("docker cp was tried first and failed (Error response from daemon: rootfs is marked read-only)");
      expect(err).toContain("No space left on device");
      expect(err).toContain("/tmp, /dev/shm, $HOME");
      expect(execs(f)).toHaveLength(3);
    });

    it("exec: a size mismatch (cut-off stream) fails that dir and the next one is tried; the expected size is passed", async () => {
      const calls: string[][] = [];
      const exec: Exec = async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[0] === "inspect") return { code: 0, stdout: isMounts(args) ? RO_ROOT : "true\n", stderr: "" };
        return args[args.length - 3] === "/tmp" ? { code: 4, stdout: "", stderr: "size mismatch: wrote 1 of 3 bytes to /tmp/x\n" } : { code: 0, stdout: "/dev/shm/x.tgz\n", stderr: "" };
      };
      expect((await prepareDockerSide({ name: "dev", pkgDir: pkg(), key: "k", cacheDir: dir("cache-"), exec, npm: fakeNpm().npm })).path).toBe("/dev/shm/x.tgz");
      const ex = calls.filter((c) => c[1] === "exec");
      expect(ex.map((c) => c[c.length - 3])).toEqual(["/tmp", "/dev/shm"]);
      expect(ex[0]![ex[0]!.length - 1]).toBe("3"); // the tarball is "tgz"
      expect(ex[0]![ex[0]!.indexOf("-c") + 1]).toMatch(/wc -c.*rm -f/);
    });
  });

  it("two sides starting at once pack once", async () => {
    const pkgDir = pkg();
    const cacheDir = dir("cache-");
    const n = fakeNpm();
    const f = fake({ inspect: { code: 0, stdout: "true\n" }, exec: { code: 0, stdout: "/tmp/x.tgz\n" } });
    const run = (name: string) => prepareDockerSide({ name, pkgDir, key: "0.2.0-1", cacheDir, exec: f.exec, npm: n.npm }).then((r) => r.path);
    await Promise.all([run("a"), run("b")]);
    expect(n.calls).toHaveLength(1);
  });

  it("a failed pack names the missing file and the last lines of npm's output", async () => {
    const cacheDir = dir("cache-");
    const f = fake({ inspect: { code: 0, stdout: "true\n" } });
    const pkgDir = pkg();
    const gone = join(pkgDir, "dist", "web", "assets", "a.js");
    const bad = fakeNpm({ code: 1, output: `npm error code ENOENT\nnpm error syscall open\nnpm error path ${gone}\nnpm error errno -2\nnpm error enoent ENOENT: no such file or directory, open '${gone}'\n\n` });
    const err = await prepareDockerSide({ name: "dev", pkgDir, key: "k1", cacheDir, exec: f.exec, npm: bad.npm }).catch((e: Error) => e.message);
    expect(err).toContain("Packing claude-ui for Docker: dev failed");
    expect(err).toContain(gone);
    expect(err).toContain("wait for the build to finish, then retry");
    expect(existsSync(join(cacheDir, "k1.partial"))).toBe(false);
    // A missing file outside dist (a bad argument) is no build in progress: no wait hint.
    const elsewhere = join(dir("else-"), "claude-ui");
    const arg = fakeNpm({ code: 1, output: `npm error code ENOENT\nnpm error path ${elsewhere}\nnpm error enoent ENOENT: no such file or directory, open '${elsewhere}'\n` });
    const err3 = await prepareDockerSide({ name: "dev", pkgDir: pkg(), key: "k6", cacheDir, exec: f.exec, npm: arg.npm }).catch((e: Error) => e.message);
    expect(err3).toContain(`(missing: ${elsewhere})`);
    expect(err3).not.toContain("wait for the build");
    const plain = fakeNpm({ code: 1, output: "1\n2\n3\n4\n5\n6\n7\n8\n9\nnpm error x\n" });
    const err2 = await prepareDockerSide({ name: "dev", pkgDir: pkg(), key: "k4", cacheDir, exec: f.exec, npm: plain.npm }).catch((e: Error) => e.message);
    expect(err2).toContain("3 4 5 6 7 8 9 npm error x");
    expect(err2).not.toContain("2 3");
    expect(err2).not.toContain("wait for the build");
  });

  it("no build or an unfinished build says to wait for it to finish", async () => {
    const cacheDir = dir("cache-");
    const f = fake({ inspect: { code: 0, stdout: "true\n" } });
    await expect(prepareDockerSide({ name: "dev", pkgDir: dir("empty-"), key: "k2", cacheDir, exec: f.exec, npm: fakeNpm().npm })).rejects.toThrow(/wait for the build to finish, then retry/);
    const half = dir("half-");
    mkdirSync(join(half, "dist"));
    writeFileSync(join(half, "dist", "cli.js"), "");
    await expect(prepareDockerSide({ name: "dev", pkgDir: half, key: "k5", cacheDir, exec: f.exec, npm: fakeNpm().npm })).rejects.toThrow(/dist\/web.*wait for the build to finish/s);
  });
});

describe("folderPath / underDist", () => {
  it("a folder URL has no trailing separator", () => {
    const p = folderPath(pathToFileURL(join(tmpdir(), "claude-ui") + sep));
    expect(p.endsWith(sep)).toBe(false);
    expect(p).toBe(join(tmpdir(), "claude-ui"));
  });
  it("only files under the package's dist count as a build in progress", () => {
    const pkgDir = join(tmpdir(), "p");
    expect(underDist(join(pkgDir, "dist", "cli.js"), pkgDir)).toBe(true);
    expect(underDist(join(pkgDir, "dist"), pkgDir)).toBe(false);
    expect(underDist(join(pkgDir, "src", "a.js"), pkgDir)).toBe(false);
    expect(underDist(join(tmpdir(), "other", "dist", "a.js"), pkgDir)).toBe(false);
  });
});

describe("checkDockerSide (side.check of a container)", () => {
  const out = (lines: string[]) => lines.map((l) => `CLAUDE_UI_CHECK ${l}`).join("\n");
  const ALL = ["node=22.4.0", "foundnode=1", "make=1", "python3=1", "cxx=1", "credentials=1", "writable=/tmp", "installed=none"];
  const running = { inspect: { code: 0, stdout: "true\n" } };
  const run = (answers: Record<string, Answer>, pkgDir = pkg()) => {
    const f = fake({ ...running, ...answers });
    const npm = fakeNpm();
    return { f, npm, result: checkDockerSide({ name: "dev", pkgDir, key: "0.5.0-1", exec: f.exec }) };
  };

  it("a container that is gone, not running or not answering is blocked, nothing else runs", async () => {
    const gone = run({ inspect: { code: 1, stderr: "Error: No such object: dev" } });
    expect(await gone.result).toMatchObject({ verdict: "blocked", reason: "gone", facts: { reachable: false } });
    expect(gone.f.calls).toHaveLength(1);
    const stopped = run({ inspect: { code: 0, stdout: "false\n" } });
    expect(await stopped.result).toMatchObject({ verdict: "blocked", reason: "not_running", message: expect.stringContaining("docker start dev"), facts: { reachable: true, running: false } });
    expect(stopped.f.calls).toHaveLength(1);
    expect(await run({ inspect: { code: 1, stderr: "Cannot connect to the Docker daemon" } }).result).toMatchObject({ verdict: "blocked", reason: "unreachable" });
    expect(await run({ inspect: { code: null } }).result).toMatchObject({ verdict: "blocked", reason: "unreachable" });
  });

  it("a running container: inspect, the mounts and network inspects and one docker exec of the check script; nothing is packed, copied or written", async () => {
    const r = run({ exec: { code: 0, stdout: out(ALL) } });
    expect(await r.result).toMatchObject({ verdict: "install", key: "0.5.0-1", facts: { reachable: true, running: true, node: "22.4.0", installed: "none", writable: ["/tmp"] } });
    const kinds = r.f.calls.map((c) => c[1]);
    expect(kinds).toEqual(["inspect", "inspect", "inspect", "exec"]);
    expect(r.f.calls.some((c) => c[1] === "cp")).toBe(false);
    const exec = r.f.calls[3]!;
    expect(exec.slice(0, 4)).toEqual(["docker", "exec", "dev", "sh"]);
    expect(exec).not.toContain("-i");
    expect(exec[5]).toContain("CLAUDE_UI_CHECK");
    expect(exec[5]).not.toMatch(/\bcat\b/);
    expect(r.f.stdin.every((s) => s === undefined)).toBe(true);
    expect(r.npm.calls).toEqual([]);
  });

  it("never reads the environment: no inspect format names Config.Env, and no packing folder is made", async () => {
    const cacheDir = join(dir("never-"), "side-pack");
    const r = run({ exec: { code: 0, stdout: out(ALL) } });
    await r.result;
    for (const c of r.f.calls) expect(c.join(" ")).not.toMatch(/Config\.Env|\.Env\b/);
    expect(existsSync(cacheDir)).toBe(false);
  });

  it("no writable path only when neither docker cp nor a writable folder can take the package", async () => {
    const nothing = [...ALL.filter((l) => !l.startsWith("writable")), "writable="];
    expect(await run({ exec: { code: 0, stdout: out(nothing) }, mounts: { code: 0, stdout: RO_ROOT } }).result).toMatchObject({ verdict: "blocked", reason: "no_writable_path", message: expect.not.stringMatching(/docker cp|docker exec|\bcp\b/i) });
    expect(await run({ exec: { code: 0, stdout: out(nothing) }, mounts: { code: 0, stdout: WRITABLE } }).result).toMatchObject({ verdict: "install" });
    expect(await run({ exec: { code: 0, stdout: out(ALL) }, mounts: { code: 0, stdout: RO_ROOT } }).result).toMatchObject({ verdict: "install" });
    // Already installed: nothing is copied, so a read-only file system is no block.
    const current = [...nothing.filter((l) => !l.startsWith("installed")), "installed=current"];
    expect(await run({ exec: { code: 0, stdout: out(current) }, mounts: { code: 0, stdout: RO_ROOT } }).result).toMatchObject({ verdict: "installed" });
  });

  it("the facts never carry a copy method", async () => {
    const r = await run({ exec: { code: 0, stdout: out(ALL) } }).result;
    expect(JSON.stringify(r)).not.toMatch(/"copy"|docker cp/);
  });

  it("no build is blocked; an exec that fails or prints nothing is check_failed, a timeout unreachable", async () => {
    expect(await run({ exec: { code: 0, stdout: out(ALL) } }, dir("nobuild-")).result).toMatchObject({ verdict: "blocked", reason: "no_build" });
    expect(await run({ exec: { code: 126, stderr: "OCI runtime exec failed: exec failed: sh: no such file" } }).result).toMatchObject({ verdict: "blocked", reason: "check_failed", facts: { running: true } });
    expect(await run({ exec: { code: null } }).result).toMatchObject({ verdict: "blocked", reason: "unreachable" });
  });

  it("prepareDockerSide with setup never only inspects: nothing packed or copied; needed reports its phases", async () => {
    const cacheDir = join(dir("prep-"), "cache");
    const f = fake({ inspect: { code: 0, stdout: "true\n" } });
    const n = fakeNpm();
    expect((await prepareDockerSide({ name: "dev", pkgDir: pkg(), key: "k", cacheDir, exec: f.exec, npm: n.npm, setup: "never" })).path).toBe("");
    expect(f.calls).toEqual([["docker", "inspect", "-f", "{{.State.Running}}", "dev"]]);
    expect(n.calls).toEqual([]);
    expect(existsSync(cacheDir)).toBe(false);
    const phases: string[] = [];
    const g = fake({ inspect: { code: 0, stdout: "true\n" }, mounts: { code: 0, stdout: WRITABLE }, cp: { code: 0 } });
    await prepareDockerSide({ name: "dev", pkgDir: pkg(), key: "k", cacheDir, exec: g.exec, npm: fakeNpm().npm, onPhase: (p) => phases.push(p) });
    expect(phases).toEqual(["packing", "copying"]);
  });
});

describe("prepareDockerSide: the host-assembled bundle", () => {
  const probeOut = (arch: string, libc = "glibc") => ["arch=" + arch, "libc=" + libc, "glibc=2.36", "cxxrt=1"].map((l) => `CLAUDE_UI_CHECK ${l}`).join("\n");
  const sideBuildPkg = (withSide = true) => {
    const d = pkg();
    if (withSide) {
      mkdirSync(join(d, "dist", "side"));
      writeFileSync(join(d, "dist", "side", "cli.js"), "side");
      writeFileSync(join(d, "dist", "side", "side.json"), JSON.stringify({ sdk: "0.3.1" }));
    }
    return d;
  };
  const sha = (b: string) => createHash("sha256").update(b).digest("hex");
  const parts = () => [{ file: "node.tar.gz", label: "Node.js", url: "https://n/node", sha256: sha("node") }];
  const okFetch = (async () => new Response("node")) as unknown as typeof fetch;
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  function docker(arch = "x86_64", libc = "glibc", probe?: Answer) {
    const calls: string[][] = [];
    const exec: Exec = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === "inspect") return { code: 0, stdout: isMounts(args) ? WRITABLE : "true\n", stderr: "" };
      if (args[0] === "exec" && args.some((a) => a.includes("uname -m"))) return probe ? ({ stdout: "", stderr: "", ...probe } as { code: number | null; stdout: string; stderr: string }) : { code: 0, stdout: probeOut(arch, libc), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    return { calls, exec };
  }
  // The cache root is named like the real one: pruneCache only touches claude-ui's side cache.
  const sideRoot = () => join(dir("home-"), "claude-ui", "side");
  const go = (o: { arch?: string; libc?: string; fetch?: typeof fetch; cacheRoot?: string; withSide?: boolean; probe?: Answer }) => {
    const d = docker(o.arch, o.libc, o.probe);
    const phases: string[] = [];
    const installs: unknown[] = [];
    const cacheRoot = o.cacheRoot ?? sideRoot();
    const result = prepareDockerSide({ name: "dev", pkgDir: sideBuildPkg(o.withSide), key: "1.0.0-1", cacheDir: dir("cache-"), exec: d.exec, npm: fakeNpm().npm, onPhase: (p) => phases.push(p), onInstall: (i) => installs.push(i), bundle: { cacheRoot, version: "1.0.0", fetch: o.fetch ?? okFetch, parts } });
    return { ...d, phases, installs, result, cacheRoot };
  };

  it("x86_64 glibc: downloads, packs and copies one tar; the second container downloads nothing", async () => {
    const a = go({});
    const r = await a.result;
    expect(r.path).toBe("/tmp/claude-ui-side-1.0.0-1.tar");
    expect(r.bundle).toEqual({ target: "linux-x64", nodeDir: expect.stringMatching(/^node-v[\d.]+-linux-x64$/), claudePackage: "claude-agent-sdk-linux-x64" });
    expect(a.phases).toEqual(["downloading", "packing", "copying"]);
    expect(a.installs).toEqual([{ bundle: true }]);
    expect(existsSync(join(a.cacheRoot, "1.0.0", "linux-x64", "node.tar.gz"))).toBe(true);
    // The assembled tar is removed after the copy.
    expect(readdirSync(join(a.cacheRoot, "1.0.0", ".tmp"))).toEqual([]);
    const b = go({ cacheRoot: a.cacheRoot, fetch: offline });
    expect((await b.result).bundle?.target).toBe("linux-x64");
    expect(b.phases).toEqual(["packing", "copying"]);
  });

  it.skipIf(process.platform === "win32")("a container with Node.js 22+: the probe sources nvm, the tar has no node.tar.gz, nothing is fetched from nodejs.org", async () => {
    const scripts: string[] = [];
    const listed: string[] = [];
    const exec: Exec = async (_cmd, args) => {
      if (args[0] === "inspect") return { code: 0, stdout: isMounts(args) ? WRITABLE : "true\n", stderr: "" };
      if (args[0] === "exec" && args.some((x) => x.includes("uname -m"))) return scripts.push(args.at(-1)!), { code: 0, stdout: `${probeOut("x86_64")}\nCLAUDE_UI_CHECK foundnode=1`, stderr: "" };
      if (args[0] === "cp") listed.push(...execFileSync("tar", ["-tf", args[1]!], { encoding: "utf8" }).split("\n").filter(Boolean));
      return { code: 0, stdout: "", stderr: "" };
    };
    const urls: string[] = [];
    const fetched = (async (u: string) => (urls.push(String(u)), new Response("x"))) as unknown as typeof fetch;
    const seen: unknown[] = [];
    const r = await prepareDockerSide({ name: "dev", pkgDir: sideBuildPkg(), key: "1.0.0-1", cacheDir: dir("cache-"), exec, npm: fakeNpm().npm, bundle: { cacheRoot: sideRoot(), version: "1.0.0", fetch: fetched, parts: (_t, o) => (seen.push(o.node), []) } });
    expect(scripts[0]).toMatch(/^nvm=/);
    expect(seen).toEqual(["found"]);
    expect(r.bundle).toEqual({ target: "linux-x64", claudePackage: "claude-agent-sdk-linux-x64" });
    expect(listed).not.toContain("node.tar.gz");
    expect(urls.filter((u) => u.includes("nodejs.org"))).toEqual([]);
  });

  it("aarch64 picks the arm64 bundle", async () => {
    expect((await go({ arch: "aarch64" }).result).bundle?.target).toBe("linux-arm64");
  });

  it("musl, no side build, or offline with an empty cache: the npm tarball, with the reason", async () => {
    for (const [o, why] of [
      [{ libc: "musl" }, /musl/],
      [{ withSide: false }, /no container bundle/],
      [{ fetch: offline }, /^the host could not download Node\.js \(fetch failed\) and has no verified copy of it$/],
    ] as const) {
      const g = go(o);
      const r = await g.result;
      expect(r.bundle).toBeUndefined();
      expect(r.path).toMatch(/\.tgz$/);
      expect(g.installs).toEqual([{ fallback: expect.stringMatching(why) }]);
      expect(g.phases.slice(-2)).toEqual(["packing", "copying"]);
    }
  });

  const DAY = 24 * 3_600_000;
  const oldVersion = (cacheRoot: string, name: string, daysOld: number) => {
    const d = join(cacheRoot, name);
    mkdirSync(join(d, "linux-x64"), { recursive: true });
    writeFileSync(join(d, ".used"), "");
    const t = new Date(Date.now() - daysOld * DAY);
    utimesSync(join(d, ".used"), t, t);
  };

  it("another version's parts used within 7 days survive a start; one unused for 8 days is removed; this version is marked used", async () => {
    const cacheRoot = sideRoot();
    oldVersion(cacheRoot, "0.9.0", 2);
    oldVersion(cacheRoot, "0.8.0", 8);
    await go({ cacheRoot }).result;
    expect(readdirSync(cacheRoot).sort()).toEqual(["0.9.0", "1.0.0"]);
    expect(existsSync(join(cacheRoot, "1.0.0", ".used"))).toBe(true);
  });

  it("two concurrent cold-cache starts of the same target both install from the bundle: one download per part, two tars copied, no .partial", async () => {
    const cacheRoot = sideRoot();
    const urls: string[] = [];
    const counted = (async (u: string) => (urls.push(String(u)), new Response("node"))) as unknown as typeof fetch;
    const a = go({ cacheRoot, fetch: counted });
    const b = go({ cacheRoot, fetch: counted });
    const [ra, rb] = await Promise.all([a.result, b.result]);
    expect(ra.bundle?.target).toBe("linux-x64");
    expect(rb.bundle?.target).toBe("linux-x64");
    expect(urls).toEqual(["https://n/node"]);
    expect([a, b].map((x) => x.calls.filter((c) => c[0] === "cp").length)).toEqual([1, 1]);
    expect([a.installs, b.installs]).toEqual([[{ bundle: true }], [{ bundle: true }]]);
    expect(readdirSync(join(cacheRoot, "1.0.0", "linux-x64")).filter((f) => f.includes(".partial"))).toEqual([]);
    expect(readdirSync(join(cacheRoot, "1.0.0", ".tmp"))).toEqual([]);
  });

  it("the target probe docker exec fails: the fallback says the container did not answer the probe, with the cause", async () => {
    for (const [probe, why] of [
      [{ code: 1, stderr: "OCI runtime exec failed: exec failed" }, "the container did not answer the target probe (OCI runtime exec failed: exec failed)"],
      [{ code: null }, "the container did not answer the target probe (no answer in time)"],
      [{ code: 126 }, "the container did not answer the target probe (exit code 126)"],
    ] as const) {
      const g = go({ probe });
      const r = await g.result;
      expect(r.bundle).toBeUndefined();
      expect(g.installs).toEqual([{ fallback: why }]);
    }
  });

  it("a checksum mismatch falls back with the full sentence", async () => {
    const g = go({ fetch: (async () => new Response("evil")) as unknown as typeof fetch });
    await g.result;
    expect(g.installs).toEqual([{ fallback: "the Node.js the host downloaded does not match its checksum (it was not used) and the host has no verified copy of it" }]);
  });

  it("a cache the host cannot write falls back with could not keep, naming the folder", async () => {
    const home = dir("home-");
    mkdirSync(join(home, "claude-ui"), { recursive: true });
    writeFileSync(join(home, "claude-ui", "side"), "a file where the cache folder should be");
    const g = go({ cacheRoot: join(home, "claude-ui", "side") });
    const r = await g.result;
    expect(r.bundle).toBeUndefined();
    expect(g.installs).toEqual([{ fallback: expect.stringMatching(/^the host could not keep .* in its cache /) }]);
  });

  it("a .tmp tar older than an hour is removed before assembling; a fresh one stays", async () => {
    const cacheRoot = sideRoot();
    const tmpDir = join(cacheRoot, "1.0.0", ".tmp");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "bundle-1-1.tar"), "x");
    writeFileSync(join(tmpDir, "bundle-2-2.tar"), "x");
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(join(tmpDir, "bundle-1-1.tar"), old, old);
    await go({ cacheRoot }).result;
    expect(readdirSync(tmpDir).sort()).toEqual(["bundle-2-2.tar"]);
  });
});

describe("checkDockerSide: the bundle's parts fact", () => {
  const lines = (l: string[]) => l.map((x) => `CLAUDE_UI_CHECK ${x}`).join("\n");
  const stdout = lines(["arch=x86_64", "libc=glibc", "glibc=2.36", "cxxrt=1", "foundnode=0", "credentials=1", "writable=/tmp", "installed=none"]);
  const pkgSide = (side = true) => {
    const d = pkg();
    if (side) {
      mkdirSync(join(d, "dist", "side"));
      writeFileSync(join(d, "dist", "side", "cli.js"), "side");
      writeFileSync(join(d, "dist", "side", "side.json"), JSON.stringify({ sdk: "0.3.1" }));
    }
    return d;
  };
  const check = (o: { cacheRoot?: string; side?: boolean; stdout?: string }) => {
    const f = fake({ inspect: { code: 0, stdout: "true\n" }, exec: { code: 0, stdout: o.stdout ?? stdout } });
    return checkDockerSide({ name: "dev", pkgDir: pkgSide(o.side), key: "1.0.0-1", exec: f.exec, bundle: o.cacheRoot ? { cacheRoot: o.cacheRoot, version: "1.0.0", parts: () => [{ file: "node.tar.gz", label: "Node.js", url: "https://n/node", sha256: "x" }] } : undefined });
  };

  it("every part file in the cache: cached; a cold cache: download; nothing is downloaded or written", async () => {
    const cacheRoot = join(dir("home-"), "claude-ui", "side");
    const cold = await check({ cacheRoot });
    expect(cold.facts.install).toEqual({ method: "bundle", parts: "download" });
    expect(existsSync(cacheRoot)).toBe(false);
    mkdirSync(join(cacheRoot, "1.0.0", "linux-x64"), { recursive: true });
    writeFileSync(join(cacheRoot, "1.0.0", "linux-x64", "node.tar.gz"), "x");
    expect((await check({ cacheRoot })).facts.install).toEqual({ method: "bundle", parts: "cached" });
  });

  it("no bundle source or the npm method: no parts field", async () => {
    expect((await check({})).facts.install).toEqual({ method: "bundle" });
    const npm = await check({ cacheRoot: dir("home-"), side: false });
    expect(npm.facts.install).toMatchObject({ method: "npm" });
    expect(npm.facts.install).not.toHaveProperty("parts");
  });
});

