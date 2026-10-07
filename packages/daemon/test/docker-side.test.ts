import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listContainers, parseContainers, prepareDockerSide, type Exec } from "../src/docker-side.ts";
import type { Runner } from "../src/update.ts";

const dir = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
type Answer = { code: number | null; stdout?: string; stderr?: string };
function fake(answers: Record<string, Answer>) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => (calls.push([cmd, ...args]), { stdout: "", stderr: "", ...(answers[args[0]!] ?? { code: 0 }) } as { code: number | null; stdout: string; stderr: string });
  return { calls, exec };
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

  it("packs the package once per build and copies it into the container", async () => {
    const pkgDir = pkg();
    const cacheDir = dir("cache-");
    const n = fakeNpm();
    const f = fake({ inspect: { code: 0, stdout: "true\n" } });
    const run = (key: string) => prepareDockerSide({ name: "dev", pkgDir, key, cacheDir, exec: f.exec, npm: n.npm });
    expect(await run("0.2.0-1")).toBe("/tmp/claude-ui-side-0.2.0-1.tgz");
    expect(n.calls).toEqual([["npm", "pack", pkgDir, "--ignore-scripts", "--pack-destination", join(cacheDir, "0.2.0-1.partial"), "--loglevel=error"]]);
    expect(f.calls.filter((c) => c[1] === "cp")).toEqual([["docker", "cp", join(cacheDir, "0.2.0-1", "claude-code-ui-0.2.0.tgz"), "dev:/tmp/claude-ui-side-0.2.0-1.tgz"]]);
    await run("0.2.0-1");
    expect(n.calls).toHaveLength(1);
    expect(f.calls.filter((c) => c[1] === "cp")).toHaveLength(2);
    await run("0.2.0-2");
    expect(n.calls).toHaveLength(2);
    expect(readdirSync(cacheDir)).toEqual(["0.2.0-2"]);
  });

  it("two sides starting at once pack once", async () => {
    const pkgDir = pkg();
    const cacheDir = dir("cache-");
    const n = fakeNpm();
    const f = fake({ inspect: { code: 0, stdout: "true\n" } });
    const run = (name: string) => prepareDockerSide({ name, pkgDir, key: "0.2.0-1", cacheDir, exec: f.exec, npm: n.npm });
    await Promise.all([run("a"), run("b")]);
    expect(n.calls).toHaveLength(1);
  });

  it("a failed pack or copy says why", async () => {
    const cacheDir = dir("cache-");
    const f = fake({ inspect: { code: 0, stdout: "true\n" } });
    const bad = fakeNpm({ code: 1, output: "a\nb\nnpm error x\n" });
    await expect(prepareDockerSide({ name: "dev", pkgDir: pkg(), key: "k1", cacheDir, exec: f.exec, npm: bad.npm })).rejects.toThrow("Packing claude-ui for Docker: dev failed: a b npm error x");
    expect(existsSync(join(cacheDir, "k1.partial"))).toBe(false);
    await expect(prepareDockerSide({ name: "dev", pkgDir: dir("empty-"), key: "k2", cacheDir, exec: f.exec, npm: fakeNpm().npm })).rejects.toThrow(/no build \(dist\/cli\.js\)/);
    const cp = fake({ inspect: { code: 0, stdout: "true\n" }, cp: { code: 1, stderr: "Error: no space\n" } });
    await expect(prepareDockerSide({ name: "dev", pkgDir: pkg(), key: "k3", cacheDir, exec: cp.exec, npm: fakeNpm().npm })).rejects.toThrow("Copying claude-ui into Docker: dev failed: Error: no space.");
  });
});
