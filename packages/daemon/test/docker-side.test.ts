import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { cpUsable, folderPath, listContainers, parseContainers, prepareDockerSide, underDist, type Exec } from "../src/docker-side.ts";
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
    const run = (key: string) => prepareDockerSide({ name: "dev", pkgDir, key, cacheDir, exec: f.exec, npm: n.npm });
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
    expect(await prepareDockerSide({ name: "esaca", pkgDir: pkg(), key: "k", cacheDir: dir("cache-"), exec: f.exec, npm: fakeNpm().npm })).toBe("/tmp/claude-ui-side-k.tgz");
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
    expect(await prepareDockerSide({ name: "esaca", pkgDir: pkg(), key: "k", cacheDir: dir("cache-"), exec, npm: fakeNpm().npm })).toBe("/home/esaca/claude-ui-side-k.tgz");
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
    const go = (f: { exec: Exec }, cacheDir = dir("cache-")) => prepareDockerSide({ name: "dev", pkgDir: pkg(), key: "k", cacheDir, exec: f.exec, npm: fakeNpm().npm });

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
      expect(await prepareDockerSide({ name: "dev", pkgDir: pkg(), key: "k", cacheDir: dir("cache-"), exec, npm: fakeNpm().npm })).toBe("/dev/shm/x.tgz");
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
    const run = (name: string) => prepareDockerSide({ name, pkgDir, key: "0.2.0-1", cacheDir, exec: f.exec, npm: n.npm });
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
