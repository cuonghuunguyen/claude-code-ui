import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listRepos } from "../src/git.ts";
import { DEFAULTS } from "../src/settings.ts";
import { fuzzyRank, preparedCount, searchFiles, searchLimits } from "../src/search.ts";

describe("fuzzyRank", () => {
  const paths = ["src/auth/AuthService.ts", "docs/author.md", "src/app.ts", "src/a/u/t/h.ts", "README.md"];

  it("keeps subsequence matches only, case-insensitive", async () => {
    expect(fuzzyRank(paths, "AUTH")).not.toContain("src/app.ts");
    expect(fuzzyRank(paths, "rdme")).toEqual(["README.md"]);
  });

  it("ranks like OpenCode (fuzzysort): contiguous and word-start matches first", async () => {
    const shop = ["src/server/notes-untracked.ts", "README.md", "docs/spec.md", "src/client/app.tsx", "src/client/searchbox.tsx", "src/server/search.ts", "src/server/session.ts"];
    expect(fuzzyRank(shop, "srvses")).toEqual(["src/server/session.ts", "src/server/search.ts", "src/server/notes-untracked.ts"]);
    expect(fuzzyRank(shop, "search")).toEqual(["src/server/search.ts", "src/client/searchbox.tsx"]);
    expect(fuzzyRank(shop, "cltapp")).toEqual(["src/client/app.tsx"]);
  });

  it("lists shallow paths first for an empty query", async () => {
    expect(fuzzyRank(paths, "")[0]).toBe("README.md");
  });
});

describe("searchFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "search-"));
  mkdirSync(join(dir, "src/deep"), { recursive: true });
  mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "src/deep/main.ts"), "");
  writeFileSync(join(dir, "node_modules/pkg/main.js"), "");
  writeFileSync(join(dir, ".git/main"), "");
  writeFileSync(join(dir, ".env.main"), "");
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "main.secret"), "");
  // A junction on Windows: a directory symlink needs admin rights there (the type is ignored elsewhere).
  symlinkSync(outside, join(dir, "linked"), "junction");

  it("returns paths relative to the directory, folders with a trailing slash", async () => {
    expect((await searchFiles(dir, "main")).sort()).toEqual([".env.main", "src/deep/main.ts"]);
    expect(await searchFiles(dir, "deep")).toEqual(["src/deep/", "src/deep/main.ts"]);
  });

  it("skips .git and node_modules and does not follow symlinked directories", async () => {
    const all = await searchFiles(dir, "");
    expect(all.some((p) => p.includes("node_modules") || p.startsWith(".git/") || p.includes("secret"))).toBe(false);
    expect(all).toContain("linked");
  });

  it("returns at most limit matches", async () => {
    expect(await searchFiles(dir, "", 2)).toHaveLength(2);
  });
});

describe("searchFiles in a git repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "search-git-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, ".gitignore"), "dist/\n*.log\n");
  writeFileSync(join(dir, "src/main.ts"), "");
  writeFileSync(join(dir, "dist/main.js"), "");
  writeFileSync(join(dir, "main.log"), "");

  it("leaves out gitignored files and folders, keeps untracked ones", async () => {
    const all = await searchFiles(dir, "");
    expect(all).toContain("src/main.ts");
    expect(all).toContain("src/");
    expect(all.some((p) => p.startsWith("dist") || p.endsWith(".log"))).toBe(false);
  });

  it("searched from a subfolder, paths stay relative to it", async () => {
    expect(await searchFiles(join(dir, "src"), "main")).toEqual(["main.ts"]);
  });
});

describe("prepared search targets", () => {
  it("are kept for the last two searched folders and only for their current paths (bounded, no global fuzzysort cache)", async () => {
    const dirs = [0, 1, 2].map(() => mkdtempSync(join(tmpdir(), "search-cache-")));
    for (const d of dirs) writeFileSync(join(d, "a.ts"), "");
    writeFileSync(join(dirs[0]!, "gone.ts"), "");
    await searchFiles(dirs[0]!, "a");
    await searchFiles(dirs[1]!, "a");
    expect(preparedCount()).toBe(3);
    await searchFiles(dirs[2]!, "a");
    expect(preparedCount()).toBe(2);
    rmSync(join(dirs[0]!, "gone.ts"));
    await searchFiles(dirs[0]!, "a");
    expect(preparedCount()).toBe(2);
  });
});

describe("searchFiles in nested repositories and submodules", () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "protocol.file.allow=always", ...args], { cwd, stdio: "pipe" });
  const repoWith = (dir: string, files: Record<string, string>) => {
    mkdirSync(dir, { recursive: true });
    sh(dir, "init", "-q", "-b", "main");
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), c);
    }
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "c");
  };
  const reposOf = async (dir: string, git: Partial<typeof DEFAULTS.git> = {}) => (await listRepos(realpathSync(dir), { settings: { ...DEFAULTS.git, ...git }, allowed: () => true })).repos;
  const api = (dir: string) => {
    repoWith(join(dir, "api"), { "src/handler.ts": "", ".gitignore": "dist/\n" });
    mkdirSync(join(dir, "api/dist"));
    writeFileSync(join(dir, "api/dist/x.js"), "");
  };

  it("finds files of an untracked embedded repository, minus its gitignored files, with the folder once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-nested-"));
    repoWith(dir, { "a.txt": "" });
    api(dir);
    const repos = await reposOf(dir);
    expect(await searchFiles(dir, "handler", 50, repos)).toEqual(["api/src/handler.ts"]);
    const all = await searchFiles(dir, "", 1000, repos);
    expect(all.filter((p) => p === "api/")).toHaveLength(1);
    expect(all.some((p) => p.includes("dist") || p.includes(".git/") || p === "api/.git")).toBe(false);
    expect(await searchFiles(dir, "handler")).toEqual([]);
  });

  it("replaces a submodule gitlink by its files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-sub-"));
    repoWith(join(dir, "lib-src"), { "a.txt": "" });
    repoWith(dir, { "s.txt": "" });
    sh(dir, "submodule", "add", "-q", "./lib-src", "libs/lib");
    sh(dir, "commit", "-q", "-m", "sub");
    const repos = await reposOf(dir);
    const all = await searchFiles(dir, "", 1000, repos);
    expect(all).toContain("libs/lib/a.txt");
    expect(all).toContain("libs/lib/");
    expect(all).not.toContain("libs/lib");
  });

  it("in a workspace folder (no repository) finds its own files and the git-listed files of each repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-ws-"));
    writeFileSync(join(dir, "README.md"), "");
    api(dir);
    repoWith(join(dir, "web"), { "index.ts": "" });
    const repos = await reposOf(dir);
    const all = await searchFiles(dir, "", 1000, repos);
    expect(all).toEqual(expect.arrayContaining(["README.md", "api/src/handler.ts", "web/index.ts"]));
    expect(all.some((p) => p.includes("dist"))).toBe(false);
  });

  it("finds a repository inside a repository once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-deep-"));
    repoWith(dir, { "a.txt": "" });
    repoWith(join(dir, "api"), { "x.ts": "" });
    repoWith(join(dir, "api/inner"), { "b.ts": "" });
    const repos = await reposOf(dir, { repositoryScanMaxDepth: 2 });
    expect(repos.map((r) => r.rel).sort()).toEqual(["", "api", "api/inner"]);
    const all = await searchFiles(dir, "", 1000, repos);
    expect(all.filter((p) => p === "api/inner/b.ts")).toHaveLength(1);
    expect(all).toContain("api/x.ts");
  });

  it("lists nothing of an outsideRoots repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-out-"));
    repoWith(dir, { "a.txt": "" });
    api(dir);
    const repos = (await reposOf(dir)).map((r) => (r.rel === "api" ? { ...r, outsideRoots: true as const } : r));
    expect((await searchFiles(dir, "", 1000, repos)).some((p) => p.startsWith("api/src"))).toBe(false);
  });

  it("stops at the shared entry cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-cap-"));
    repoWith(dir, { "a.txt": "", "b.txt": "" });
    repoWith(join(dir, "api"), { "c.txt": "", "d.txt": "", "e.txt": "" });
    const repos = await reposOf(dir);
    const was = searchLimits.entries;
    searchLimits.entries = 3;
    try {
      expect((await searchFiles(dir, "", 1000, repos)).length).toBeLessThanOrEqual(3);
    } finally {
      searchLimits.entries = was;
    }
  });

  it("from a subfolder of a repository, paths stay relative to it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-sub2-"));
    repoWith(dir, { "src/main.ts": "" });
    const repos = await reposOf(join(dir, "src"));
    expect(await searchFiles(join(dir, "src"), "main", 50, repos)).toEqual(["main.ts"]);
  });
});
