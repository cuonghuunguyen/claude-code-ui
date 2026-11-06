import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gitBlame, parseBlame } from "../src/git.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const Z = "0".repeat(40);
const S = "c".repeat(64);
const sample = [
  `${A} 1 1 2`, "author Ann", "author-mail <ann@x.test>", "author-time 1700000000", "author-tz +0000", "summary first\tcommit", "previous x f", "filename f.txt", "\tone",
  `${A} 2 2`, "\ttwo",
  `${B} 1 3 1`, "author Bob", "author-time 1700000100", "summary second", "filename f.txt", "\tthree",
  `${Z} 4 4 1`, "author Not Committed Yet", "author-time 1700000200", "summary Version of f.txt from f.txt", "filename f.txt", "\tfour",
  `${S} 5 5 1`, "author Cy", "author-time 1700000300", "summary wide", "filename f.txt", "\tfive",
].join("\n");

describe("parseBlame", () => {
  it("maps lines to hashes, keeps the first header of each commit, null for not committed", () => {
    expect(parseBlame(sample)).toEqual({
      commits: { [A]: { author: "Ann", time: 1700000000, summary: "first\tcommit" }, [B]: { author: "Bob", time: 1700000100, summary: "second" }, [S]: { author: "Cy", time: 1700000300, summary: "wide" } },
      lines: [A, A, B, null, S],
    });
  });
});

describe("gitBlame", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "blame-")));
  const repo = join(root, "r");
  mkdirSync(repo);
  const git = (who: string, ...a: string[]) => execFileSync("git", ["-c", `user.name=${who}`, "-c", `user.email=${who}@x.test`, ...a], { cwd: repo, encoding: "utf8" }).trim();
  git("Ann", "init", "-q", "-b", "main");
  writeFileSync(join(repo, "f.txt"), "one\ntwo\n");
  git("Ann", "add", ".");
  git("Ann", "commit", "-q", "-m", "first");
  const h1 = git("Ann", "rev-parse", "HEAD");
  writeFileSync(join(repo, "f.txt"), "one\ntwo\nthree\n");
  git("Bob", "commit", "-qam", "second");
  const h2 = git("Bob", "rev-parse", "HEAD");
  writeFileSync(join(repo, "f.txt"), "one\nTWO\nthree\n");
  writeFileSync(join(repo, "new.txt"), "x\n");
  const ok = (p: string) => p.startsWith(root);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("blames the working tree: authors per line, null for the edited line", async () => {
    const b = (await gitBlame(repo, "f.txt", ok, 1e6))!;
    expect(b.lines).toEqual([h1, null, h2]);
    expect(b.commits[h1]).toMatchObject({ author: "Ann", summary: "first" });
    expect(b.commits[h2]).toMatchObject({ author: "Bob", summary: "second" });
  });
  it("untracked file: untracked", async () => {
    expect(await gitBlame(repo, "new.txt", ok, 1e6)).toEqual({ commits: {}, lines: [], untracked: true });
  });
  it("no commit yet: untracked", async () => {
    const fresh = join(root, "fresh");
    mkdirSync(fresh);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: fresh });
    writeFileSync(join(fresh, "a"), "x\n");
    expect(await gitBlame(fresh, "a", ok, 1e6)).toMatchObject({ untracked: true });
  });
  it("outside a work tree: null", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(await gitBlame(plain, "a", ok, 1e6)).toBeNull();
  });
  it("too_large with size, bad_request, not_found, not_a_file", async () => {
    await expect(gitBlame(repo, "f.txt", ok, 3)).rejects.toMatchObject({ code: "too_large", size: 14 });
    await expect(gitBlame(repo, "../x", ok, 1e6)).rejects.toMatchObject({ code: "bad_request" });
    await expect(gitBlame(repo, "nope", ok, 1e6)).rejects.toMatchObject({ code: "not_found" });
    mkdirSync(join(repo, "d"));
    await expect(gitBlame(repo, "d", ok, 1e6)).rejects.toMatchObject({ code: "not_a_file" });
  });
  it("repository outside allowed: cwd_not_allowed; symlinked folder out of the roots too", async () => {
    await expect(gitBlame(repo, "f.txt", () => false, 1e6)).rejects.toMatchObject({ code: "cwd_not_allowed" });
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "blame-out-")));
    writeFileSync(join(outside, "s.txt"), "s\n");
    symlinkSync(outside, join(repo, "link"));
    await expect(gitBlame(repo, "link/s.txt", ok, 1e6)).rejects.toMatchObject({ code: "cwd_not_allowed" });
    rmSync(outside, { recursive: true, force: true });
  });
  it("does not run a textconv", async () => {
    const mark = join(root, "ran");
    writeFileSync(join(repo, ".gitattributes"), "f.txt diff=x\n");
    git("Ann", "config", "diff.x.textconv", `touch ${mark} #`);
    const b = (await gitBlame(repo, "f.txt", ok, 1e6))!;
    expect(b.lines).toEqual([h1, null, h2]);
    expect(existsSync(mark)).toBe(false);
  });
});
