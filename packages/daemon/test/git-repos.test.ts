import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/settings.ts";
import { gitDiff, gitStatus, listRepos, parseGitmodules, type ListReposOptions } from "../src/git.ts";
import { setGitRunner, threadRunner } from "../src/git-runner.ts";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, env: ENV, stdio: "pipe" }).toString();
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "repos-")));
const repo = (dir: string, commit = true) => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  if (commit) {
    writeFileSync(join(dir, "f.txt"), "1\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
  }
  return dir;
};
const fakeRepo = (dir: string) => mkdirSync(join(dir, ".git"), { recursive: true });
const cfg = (git: Partial<ListReposOptions["settings"]> = {}): ListReposOptions["settings"] => ({ ...DEFAULTS.git, ...git });
const list = (cwd: string, git: Partial<ListReposOptions["settings"]> = {}, o: Partial<ListReposOptions> = {}) => listRepos(cwd, { settings: cfg(git), allowed: () => true, ...o });
const rels = async (...a: Parameters<typeof list>) => (await list(...a)).repos.map((r) => `${r.kind}:${r.rel}`);
afterEach(() => setGitRunner(undefined));

describe("parseGitmodules", () => {
  it("keeps sections with path and url, with git's quoting, comments, continuation, case and last-value rules", () => {
    const text = [
      '[submodule "a"]', "\tpath = libs/a ; trailing comment", "\turl = https://x/a",
      '[Submodule "b \\"q\\""]', '\tPATH = "libs/b c"', "\tURL = u",
      '[submodule "abs"]', "\tpath = /etc", "\turl = u",
      '[submodule "dup"]', "\tpath = first", "\tpath = second", "\turl = u",
      '[submodule "esc"]', "\tpath = libs/e\\", "x", "\turl = u",
      '[submodule "nourl"]', "\tpath = n",
      "[submodule.legacy]", "\tpath = l", "\turl = u",
      "[core]", "\tpath = c", "\turl = u",
    ].join("\n");
    expect(parseGitmodules(text)).toEqual([
      { name: "a", path: "libs/a", url: "https://x/a" },
      { name: 'b "q"', path: "libs/b c", url: "u" },
      { name: "abs", path: "/etc", url: "u" },
      { name: "dup", path: "second", url: "u" },
      { name: "esc", path: "libs/ex", url: "u" },
    ]);
  });
});

describe("listRepos", () => {
  it("the cwd's own repository is first; a top above the cwd only with always or prompt", async () => {
    const mono = repo(tmp());
    const pa = join(mono, "pa");
    mkdirSync(pa);
    for (const m of ["always", "prompt"] as const) expect((await list(pa, { openRepositoryInParentFolders: m })).repos).toEqual([{ path: mono, rel: "..", kind: "main", branch: "main" }]);
    expect((await list(pa, { openRepositoryInParentFolders: "never" })).repos).toEqual([]);
    expect(await rels(mono)).toEqual(["main:"]);
  });

  it("breadth-first scan to the max depth, continuing below a found repository", async () => {
    const d = tmp();
    for (const r of ["a", "a/b", "c/d"]) fakeRepo(join(d, r));
    expect(await rels(d, { repositoryScanMaxDepth: 1 })).toEqual(["nested:a"]);
    expect(await rels(d, { repositoryScanMaxDepth: 2 })).toEqual(["nested:a", "nested:a/b", "nested:c/d"]);
    expect((await list(d, { repositoryScanMaxDepth: 2 })).repos[1]!.parent).toBe(join(d, "a"));
    expect(await rels(d, { repositoryScanMaxDepth: -1 })).toEqual(["nested:a", "nested:a/b", "nested:c/d"]);
    expect(await rels(d, { repositoryScanMaxDepth: 0 })).toEqual([]);
  });

  it("the scan enters hidden and git-ignored folders, never .git, an ignored name or a symlinked folder", async () => {
    const d = tmp();
    const outside = tmp();
    fakeRepo(join(outside, "r"));
    fakeRepo(join(d, ".hidden/r"));
    fakeRepo(join(d, "node_modules/r"));
    fakeRepo(join(d, "vendor/r"));
    fakeRepo(join(d, "ignored-by-git/r"));
    writeFileSync(join(d, ".gitignore"), "ignored-by-git\n");
    symlinkSync(outside, join(d, "link"));
    const base = await rels(d, { repositoryScanMaxDepth: 2 });
    expect(base).toEqual(["nested:.hidden/r", "nested:ignored-by-git/r", "nested:vendor/r"]);
    expect(await rels(d, { repositoryScanMaxDepth: 2, repositoryScanIgnoredFolders: ["vendor"] })).toEqual(["nested:.hidden/r", "nested:ignored-by-git/r", "nested:node_modules/r"]);
    const upper = await rels(d, { repositoryScanMaxDepth: 2, repositoryScanIgnoredFolders: ["NODE_MODULES", "vendor"] });
    expect(upper.includes("nested:node_modules/r")).toBe(process.platform === "linux");
  });

  it("autoRepositoryDetection: false and openEditors scan no subfolders; subFolders ignores open files", async () => {
    const d = tmp();
    fakeRepo(join(d, "a"));
    fakeRepo(join(d, "x/y/z"));
    const f = join(d, "x/y/z/f.txt");
    writeFileSync(f, "");
    const run = (autoRepositoryDetection: ListReposOptions["settings"]["autoRepositoryDetection"]) => rels(d, { autoRepositoryDetection }, { openFiles: [f] });
    expect(await run(true)).toEqual(["nested:a", "nested:x/y/z"]);
    expect(await run(false)).toEqual([]);
    expect(await run("openEditors")).toEqual(["nested:x/y/z"]);
    expect(await run("subFolders")).toEqual(["nested:a"]);
  });

  it("open files under the cwd add their repository; a file outside the cwd is ignored", async () => {
    const d = tmp();
    const other = tmp();
    fakeRepo(join(d, "deep/x"));
    fakeRepo(join(other, "o"));
    writeFileSync(join(d, "deep/x/f.txt"), "");
    writeFileSync(join(other, "o/f.txt"), "");
    expect(await rels(d, {}, { openFiles: [join(d, "deep/x/f.txt"), join(other, "o/f.txt"), join(d, "missing.txt")] })).toEqual(["nested:deep/x"]);
  });

  it("scanRepositories candidates are added; an entry through a link out of the cwd is skipped", async () => {
    const d = tmp();
    const out = tmp();
    fakeRepo(join(d, "vendor/deep/lib"));
    fakeRepo(join(out, "r"));
    symlinkSync(out, join(d, "out"));
    expect(await rels(d, { scanRepositories: ["vendor/deep/lib", "out/r", "nothing"] })).toEqual(["nested:vendor/deep/lib"]);
    expect(await rels(d, { autoRepositoryDetection: "openEditors", scanRepositories: ["vendor/deep/lib"] })).toEqual([]);
  });

  it("ignoredRepositories leaves out an absolute and a relative repository root, never the cwd's own repository", async () => {
    const d = repo(tmp());
    fakeRepo(join(d, "a"));
    fakeRepo(join(d, "b"));
    fakeRepo(join(d, "c"));
    expect(await rels(d, { ignoredRepositories: [join(d, "a"), "b", d] })).toEqual(["main:", "nested:c"]);
  });

  it("linked worktrees are never listed; a cwd that is a linked worktree has it as main", async () => {
    const d = repo(tmp());
    const w = join(d, ".claude/worktrees/w1");
    git(d, "worktree", "add", "-q", w, "-b", "w1");
    expect(await rels(d, { repositoryScanMaxDepth: -1 })).toEqual(["main:"]);
    const r = (await list(realpathSync(w), { repositoryScanMaxDepth: -1 })).repos;
    expect(r[0]).toMatchObject({ kind: "main", path: realpathSync(w) });
    expect(r).toHaveLength(1);
  });

  const superproject = () => {
    const base = tmp();
    const lib = repo(join(base, "lib"));
    const deep = repo(join(base, "deep"));
    git(lib, "submodule", "add", "-q", "../deep", "sub/deep");
    git(lib, "commit", "-qm", "sub");
    const sup = repo(join(base, "sup"));
    git(sup, "submodule", "add", "-q", "../lib", "libs/lib");
    git(sup, "commit", "-qm", "add lib");
    git(sup, "submodule", "update", "--init", "--recursive", "-q");
    return { base, sup, lib, deep };
  };

  it("submodules from .gitmodules: listed under their parent, recursive, uninitialised left out", async () => {
    const { sup, base } = superproject();
    const none = repo(join(base, "none"));
    git(sup, "submodule", "add", "-q", "../none", "libs/none");
    git(sup, "commit", "-qm", "none");
    execFileSync("rm", ["-rf", join(sup, "libs/none"), join(sup, ".git/modules/libs/none")]);
    mkdirSync(join(sup, "libs/none"));
    const r = (await list(sup, { repositoryScanMaxDepth: 0 })).repos;
    expect(r.map((x) => `${x.kind}:${x.rel}:${x.parent ? relative(sup, x.parent) : ""}`)).toEqual(["main::", "submodule:libs/lib:", "submodule:libs/lib/sub/deep:libs/lib"]);
    expect(none).toBeTruthy();
  });

  it("the scan finding a submodule keeps it a submodule", async () => {
    const { sup } = superproject();
    const r = (await list(sup, { repositoryScanMaxDepth: 3 })).repos;
    expect(r.map((x) => `${x.kind}:${x.rel}`)).toEqual(["main:", "submodule:libs/lib", "submodule:libs/lib/sub/deep"]);
  });

  it("a .gitmodules path that is absolute, has .., or leaves the top through a link is skipped", async () => {
    const base = tmp();
    const d = repo(join(base, "top"));
    const out = tmp();
    fakeRepo(join(out, "x"));
    symlinkSync(out, join(d, "ln"));
    fakeRepo(join(base, "x"));
    const e = (name: string, path: string) => `[submodule "${name}"]\n\tpath = ${path}\n\turl = u\n`;
    writeFileSync(join(d, ".gitmodules"), e("a", out + "/x") + e("b", "../x") + e("c", "ln/x"));
    expect(await rels(d, { repositoryScanMaxDepth: 0 })).toEqual(["main:"]);
  });

  it("detectSubmodules off lists none; limit 1 lists the first and reports truncated.submodules; limit 0 lists none and reports", async () => {
    const d = repo(tmp());
    fakeRepo(join(d, "m/a"));
    fakeRepo(join(d, "m/b"));
    const e = (name: string) => `[submodule "${name}"]\n\tpath = m/${name}\n\turl = u\n`;
    writeFileSync(join(d, ".gitmodules"), e("a") + e("b"));
    const s = { repositoryScanMaxDepth: 0 };
    expect(await rels(d, { ...s, detectSubmodules: false })).toEqual(["main:"]);
    const one = await list(d, { ...s, detectSubmodulesLimit: 1 });
    expect(one.repos.map((r) => r.rel)).toEqual(["", "m/a"]);
    expect(one.truncated).toEqual({ submodules: [{ repo: d, count: 2 }] });
    const zero = await list(d, { ...s, detectSubmodulesLimit: 0 });
    expect(zero.repos.map((r) => r.rel)).toEqual([""]);
    expect(zero.truncated).toEqual({ submodules: [{ repo: d, count: 2 }] });
    expect((await list(d, { ...s })).truncated).toBeUndefined();
  });

  it("a repository whose gitdir or alternates are outside the roots is listed outsideRoots, without branch, and its .gitmodules is not read", async () => {
    const d = tmp();
    const outside = repo(tmp());
    mkdirSync(join(d, "x"));
    writeFileSync(join(d, "x/.git"), `gitdir: ${join(outside, ".git")}\n`);
    writeFileSync(join(d, "x/.gitmodules"), '[submodule "s"]\n\tpath = s\n\turl = u\n');
    fakeRepo(join(d, "x/s"));
    const y = repo(join(d, "y"));
    mkdirSync(join(y, ".git/objects/info"), { recursive: true });
    writeFileSync(join(y, ".git/objects/info/alternates"), join(outside, ".git/objects") + "\n");
    fakeRepo(join(d, "ok"));
    const r = (await list(d, { repositoryScanMaxDepth: 1 }, { allowed: (p) => p === d || p.startsWith(d + "/") })).repos;
    expect(r.map((x) => [x.rel, !!x.outsideRoots, x.branch])).toEqual([["ok", false, undefined], ["x", true, undefined], ["y", true, undefined]]);
  });

  it("a bare-repo layout or an unresolvable .git is never listed", async () => {
    const d = tmp();
    mkdirSync(join(d, "bare/objects"), { recursive: true });
    mkdirSync(join(d, "bare/refs"));
    writeFileSync(join(d, "bare/HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(d, "bad"));
    writeFileSync(join(d, "bad/.git"), "");
    expect(await rels(d)).toEqual([]);
  });

  it("caps: entries, time and count stop the scan with truncated.scan", async () => {
    const d = tmp();
    for (let i = 0; i < 10; i++) fakeRepo(join(d, `r${i}`));
    const caps = { entries: 20_000, ms: 2_000, count: 50 };
    expect((await list(d, {}, { caps: { ...caps, entries: 5 } })).truncated).toEqual({ scan: "entries" });
    let t = 0;
    expect((await list(d, {}, { now: () => (t += 3000) })).truncated).toEqual({ scan: "time" });
    const c = await list(d, {}, { caps: { ...caps, count: 2 } });
    expect(c.truncated).toEqual({ scan: "count" });
    expect(c.repos).toHaveLength(2);
  });

  it("order is the depth-first tree: root, its submodules by path, its nested repositories by path", async () => {
    const d = repo(tmp());
    const e = (p: string) => `[submodule "${p}"]\n\tpath = ${p}\n\turl = u\n`;
    writeFileSync(join(d, ".gitmodules"), e("libs/z") + e("libs/a"));
    for (const p of ["libs/z", "libs/a", "b", "a", "libs/a/inner"]) fakeRepo(join(d, p));
    const r = (await list(d, { repositoryScanMaxDepth: 3 })).repos;
    expect(r.map((x) => `${x.rel}<${x.parent ? relative(d, x.parent) : ""}`)).toEqual(["<", "libs/a<", "libs/a/inner<libs/a", "libs/z<", "a<", "b<"]);
  });

  it("a workspace folder that is not a repository lists its top-level repositories as roots", async () => {
    const d = tmp();
    fakeRepo(join(d, "web"));
    fakeRepo(join(d, "api"));
    const r = (await list(d)).repos;
    expect(r.map((x) => [x.rel, x.kind, x.parent])).toEqual([["api", "nested", undefined], ["web", "nested", undefined]]);
  });

  it("branch comes from HEAD: the branch name, or 7 hex when detached", async () => {
    const d = repo(tmp());
    expect((await list(d)).repos[0]!.branch).toBe("main");
    const sha = git(d, "rev-parse", "HEAD").trim();
    git(d, "checkout", "-q", "--detach");
    expect((await list(d)).repos[0]!.branch).toBe(sha.slice(0, 7));
  });

  it("no git process runs during listRepos", async () => {
    const { sup } = superproject();
    fakeRepo(join(sup, "n"));
    const calls: string[][] = [];
    setGitRunner((o) => (calls.push(o.args), threadRunner(o)));
    const r = await list(sup, { repositoryScanMaxDepth: 2 });
    expect(r.repos.length).toBeGreaterThan(2);
    expect(calls).toEqual([]);
  });
});

describe("ignoreSubmodules", () => {
  it("gitDiff and gitStatus pass --ignore-submodules with ignoreSubmodules, --ignore-submodules=dirty without", async () => {
    const d = repo(tmp());
    const calls: string[][] = [];
    setGitRunner((o) => (calls.push(o.args), threadRunner(o)));
    const flags = () => calls.filter((a) => a.includes("--raw")).map((a) => a.find((x) => x.startsWith("--ignore-submodules")));
    await gitDiff(d, { base: "head", allowed: () => true });
    await gitStatus(d);
    expect(flags()).toEqual(["--ignore-submodules=dirty", "--ignore-submodules=dirty"]);
    calls.length = 0;
    await gitDiff(d, { base: "head", allowed: () => true, ignoreSubmodules: true });
    await gitStatus(d, { ignoreSubmodules: true });
    expect(flags()).toEqual(["--ignore-submodules", "--ignore-submodules"]);
  });
});
