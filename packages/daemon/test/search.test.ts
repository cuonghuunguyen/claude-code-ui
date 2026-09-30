import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fuzzyRank, searchFiles } from "../src/search.ts";

describe("fuzzyRank", () => {
  const paths = ["src/auth/AuthService.ts", "docs/author.md", "src/app.ts", "src/a/u/t/h.ts", "README.md"];

  it("keeps subsequence matches only, case-insensitive", () => {
    expect(fuzzyRank(paths, "AUTH")).not.toContain("src/app.ts");
    expect(fuzzyRank(paths, "rdme")).toEqual(["README.md"]);
  });

  it("puts file name matches before path matches before scattered matches", () => {
    expect(fuzzyRank(paths, "auth")).toEqual(["docs/author.md", "src/auth/AuthService.ts", "src/a/u/t/h.ts"]);
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
    expect(searchFiles(dir, "main")).toEqual(["src/deep/main.ts", ".env.main"]);
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
