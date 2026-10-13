// GH-298: refs stamp and repository top never read the file system synchronously (UNC over 9P on the main thread).
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ on: false, names: [] as string[] }));
vi.mock("node:fs", async (orig) => {
  const fs = await orig<typeof import("node:fs")>();
  const wrap = <K extends keyof typeof fs>(k: K) => ((...a: unknown[]) => (seen.on && seen.names.push(k), (fs[k] as (...x: unknown[]) => unknown)(...a))) as (typeof fs)[K];
  const realpathSync = Object.assign(wrap("realpathSync"), { native: (...a: unknown[]) => (seen.on && seen.names.push("realpathSync.native"), (fs.realpathSync.native as (...x: unknown[]) => unknown)(...a)) });
  const m = { ...fs, statSync: wrap("statSync"), lstatSync: wrap("lstatSync"), readdirSync: wrap("readdirSync"), readFileSync: wrap("readFileSync"), existsSync: wrap("existsSync"), realpathSync };
  return { ...m, default: m };
});
const { gitRefs, gitStatus } = await import("../src/git.ts");

const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gh298f-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "1\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
};
const during = async <T>(fn: () => Promise<T> | T) => {
  seen.names = [];
  seen.on = true;
  try {
    return await fn();
  } finally {
    seen.on = false;
  }
};

describe("GH-298 refs stamp and repository top without sync fs", () => {
  it("git.refs reads no file synchronously", async () => {
    const dir = repo();
    const r = await during(() => gitRefs(dir, () => true));
    expect(typeof r).toBe("string");
    expect(seen.names).toEqual([]);
  });

  it("git.status (repository top, pin, refs stamp) reads no file synchronously", async () => {
    const dir = repo();
    const s = await during(() => gitStatus(dir));
    expect(s).toMatchObject({ branch: "main" });
    expect(seen.names).toEqual([]);
  });
});
