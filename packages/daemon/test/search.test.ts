import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fuzzyRank, preparedCount, searchFiles } from "../src/search.ts";

describe("fuzzyRank", () => {
  const paths = ["src/auth/AuthService.ts", "docs/author.md", "src/app.ts", "src/a/u/t/h.ts", "README.md"];

  it("keeps subsequence matches only, case-insensitive", () => {
    expect(fuzzyRank(paths, "AUTH")).not.toContain("src/app.ts");
    expect(fuzzyRank(paths, "rdme")).toEqual(["README.md"]);
  });

  it("ranks like OpenCode (fuzzysort): contiguous and word-start matches first", () => {
    const shop = ["src/server/notes-untracked.ts", "README.md", "docs/spec.md", "src/client/app.tsx", "src/client/searchbox.tsx", "src/server/search.ts", "src/server/session.ts"];
    expect(fuzzyRank(shop, "srvses")).toEqual(["src/server/session.ts", "src/server/search.ts", "src/server/notes-untracked.ts"]);
    expect(fuzzyRank(shop, "search")).toEqual(["src/server/search.ts", "src/client/searchbox.tsx"]);
    expect(fuzzyRank(shop, "cltapp")).toEqual(["src/client/app.tsx"]);
  });

  it("lists shallow paths first for an empty query", () => {
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
  symlinkSync(outside, join(dir, "linked"));

  it("returns paths relative to the directory, folders with a trailing slash", () => {
    expect(searchFiles(dir, "main").sort()).toEqual([".env.main", "src/deep/main.ts"]);
    expect(searchFiles(dir, "deep")).toEqual(["src/deep/", "src/deep/main.ts"]);
  });

  it("skips .git and node_modules and does not follow symlinked directories", () => {
    const all = searchFiles(dir, "");
    expect(all.some((p) => p.includes("node_modules") || p.startsWith(".git/") || p.includes("secret"))).toBe(false);
    expect(all).toContain("linked");
  });

  it("returns at most limit matches", () => {
    expect(searchFiles(dir, "", 2)).toHaveLength(2);
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

  it("leaves out gitignored files and folders, keeps untracked ones", () => {
    const all = searchFiles(dir, "");
    expect(all).toContain("src/main.ts");
    expect(all).toContain("src/");
    expect(all.some((p) => p.startsWith("dist") || p.endsWith(".log"))).toBe(false);
  });

  it("searched from a subfolder, paths stay relative to it", () => {
    expect(searchFiles(join(dir, "src"), "main")).toEqual(["main.ts"]);
  });
});

describe("prepared search targets", () => {
  it("are kept for the last two searched folders and only for their current paths (bounded, no global fuzzysort cache)", () => {
    const dirs = [0, 1, 2].map(() => mkdtempSync(join(tmpdir(), "search-cache-")));
    for (const d of dirs) writeFileSync(join(d, "a.ts"), "");
    writeFileSync(join(dirs[0]!, "gone.ts"), "");
    searchFiles(dirs[0]!, "a");
    searchFiles(dirs[1]!, "a");
    expect(preparedCount()).toBe(3);
    searchFiles(dirs[2]!, "a");
    expect(preparedCount()).toBe(2);
    rmSync(join(dirs[0]!, "gone.ts"));
    searchFiles(dirs[0]!, "a");
    expect(preparedCount()).toBe(2);
  });
});
