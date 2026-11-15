import { describe, expect, it } from "vitest";
import { WorktreeError } from "../src/git.ts";
import { GitRequestError, gitRequest, read, write, type GitRequestContext } from "../src/git-request.ts";

const context = () => {
  const marked: string[] = [];
  const ctx: GitRequestContext = { allowed: (p) => (typeof p === "string" ? p : undefined), inside: () => true, topOf: async (cwd) => cwd, markStale: (cwd) => void marked.push(cwd) };
  return { ctx, marked };
};

describe("gitRequest error map", () => {
  it.each([
    ["WorktreeError keeps code and size", new WorktreeError("too_large", "file too large", 99), { code: "too_large", message: "file too large", size: 99 }],
    ["GitRequestError keeps code and size", new GitRequestError("binary", "binary file: a.png", 12), { code: "binary", message: "binary file: a.png", size: 12 }],
    ["other errors become git_failed", new Error("boom"), { code: "git_failed", message: "boom", size: undefined }],
  ])("%s", async (_name, error, expected) => {
    const { ctx } = context();
    expect(await gitRequest(ctx, { cwd: "/r" }, read(async () => { throw error; }))).toEqual({ error: expected });
  });
});

describe("gitRequest stale marking", () => {
  it.each([
    ["write succeeded", write, undefined, true],
    ["write failed: git_failed", write, new WorktreeError("git_failed", "hook"), true],
    ["write failed: stale", write, new WorktreeError("stale", "moved"), true],
    ["write failed: bad_request", write, new GitRequestError("bad_request", "bad"), false],
    ["read succeeded", read, undefined, false],
    ["read failed: git_failed", read, new WorktreeError("git_failed", "x"), false],
  ])("%s", async (_name, op, error, marks) => {
    const { ctx, marked } = context();
    await gitRequest(ctx, { cwd: "/r" }, op(async () => { if (error) throw error; return {}; }));
    expect(marked).toEqual(marks ? ["/r"] : []);
  });
});
