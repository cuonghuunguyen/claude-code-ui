import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addLocalAllowRule, localSettingsFile, localSettingsFiles } from "../src/local-settings.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "local-settings-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=a@example.com", "-c", "user.name=a", ...args], { cwd, stdio: "pipe" });
const env = (over: Partial<{ platform: NodeJS.Platform; home: string; uid: number | undefined }> = {}) => ({ platform: "linux" as const, home: "/nonexistent-home", uid: process.getuid?.(), ...over });
const repo = () => {
  const dir = join(root, "repo");
  mkdirSync(dir);
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
};

describe("localSettingsFile", () => {
  it("is the repository root", async () => {
    const dir = repo();
    expect(await localSettingsFile(dir, env())).toBe(join(dir, ".claude", "settings.local.json"));
  });
  it("is the repository root from a subdirectory", async () => {
    const dir = repo();
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    expect(await localSettingsFile(join(dir, "a", "b"), env())).toBe(join(dir, ".claude", "settings.local.json"));
  });
  it("is the main checkout from a worktree", async () => {
    const dir = repo();
    const wt = join(root, "wt");
    git(dir, "worktree", "add", "-q", wt, "-b", "feature");
    expect(await localSettingsFile(wt, env())).toBe(join(dir, ".claude", "settings.local.json"));
  });
  it("is the cwd outside a repository", async () => {
    const dir = join(root, "plain");
    mkdirSync(dir);
    expect(await localSettingsFile(dir, env())).toBe(join(dir, ".claude", "settings.local.json"));
  });
  it("is the cwd on Windows and when the root is the home directory", async () => {
    const dir = repo();
    mkdirSync(join(dir, "sub"));
    expect(await localSettingsFile(join(dir, "sub"), env({ platform: "win32" }))).toBe(join(dir, "sub", ".claude", "settings.local.json"));
    expect(await localSettingsFile(join(dir, "sub"), env({ home: dir }))).toBe(join(dir, "sub", ".claude", "settings.local.json"));
  });
  it("is the cwd when the root belongs to another user", async () => {
    const dir = repo();
    mkdirSync(join(dir, "sub"));
    expect(await localSettingsFile(join(dir, "sub"), env({ uid: (process.getuid?.() ?? 0) + 1 }))).toBe(join(dir, "sub", ".claude", "settings.local.json"));
  });
});

describe("localSettingsFiles", () => {
  const f = (dir: string) => join(dir, ".claude", "settings.local.json");
  it("is the root file alone for a cwd at the repository root", async () => {
    const dir = repo();
    expect(await localSettingsFiles(dir, env())).toEqual([f(dir)]);
  });
  it("adds the cwd's own file under the root file for a subdirectory", async () => {
    const dir = repo();
    mkdirSync(join(dir, "sub"));
    expect(await localSettingsFiles(join(dir, "sub"), env())).toEqual([f(dir), f(join(dir, "sub"))]);
  });
  it("is the main checkout's file, then the worktree's own, for a worktree", async () => {
    const dir = repo();
    const wt = join(root, "wt");
    git(dir, "worktree", "add", "-q", wt, "-b", "feature");
    expect(await localSettingsFiles(wt, env())).toEqual([f(dir), f(wt)]);
  });
  it("is the own file alone outside a repository and on Windows", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(await localSettingsFiles(plain, env())).toEqual([f(plain)]);
    const dir = repo();
    expect(await localSettingsFiles(dir, env({ platform: "win32" }))).toEqual([f(dir)]);
  });
});

describe("addLocalAllowRule", () => {
  const file = () => join(root, "p", ".claude", "settings.local.json");
  const read = () => JSON.parse(readFileSync(file(), "utf8"));
  beforeEach(() => mkdirSync(join(root, "p")));

  it("creates the file", () => {
    addLocalAllowRule(file(), "Bash(ls)");
    expect(read()).toEqual({ permissions: { allow: ["Bash(ls)"] } });
  });
  it("appends without a duplicate and keeps other keys and the mode", () => {
    mkdirSync(join(root, "p", ".claude"));
    writeFileSync(file(), JSON.stringify({ model: "x", permissions: { allow: ["Read"], deny: ["Bash(rm)"] } }), { mode: 0o600 });
    chmodSync(file(), 0o600);
    addLocalAllowRule(file(), "Bash(ls)");
    addLocalAllowRule(file(), "Bash(ls)");
    expect(read()).toEqual({ model: "x", permissions: { allow: ["Read", "Bash(ls)"], deny: ["Bash(rm)"] } });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });
  it("refuses a file that is not a JSON object", () => {
    mkdirSync(join(root, "p", ".claude"));
    writeFileSync(file(), "[1]");
    expect(() => addLocalAllowRule(file(), "Bash(ls)")).toThrow(/not a JSON object/);
    expect(readFileSync(file(), "utf8")).toBe("[1]");
  });
  it("refuses a .claude symlink that points outside the project", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "p", ".claude"));
    expect(() => addLocalAllowRule(file(), "Bash(ls)")).toThrow(/points outside/);
  });
});
