import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitStatus } from "../src/git.ts";

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

describe("gitStatus", () => {
  it("is null outside a git repository", async () => {
    expect(await gitStatus(mkdtempSync(join(tmpdir(), "nogit-")))).toBeNull();
  });

  it("returns the branch and the lines added and removed against HEAD, staged and unstaged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-"));
    run(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "1\n2\n3\n");
    run(dir, "add", ".");
    run(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    expect(await gitStatus(dir)).toEqual({ branch: "main", added: 0, removed: 0 });
    writeFileSync(join(dir, "a.txt"), "1\nx\ny\n");
    writeFileSync(join(dir, "b.txt"), "new\n");
    run(dir, "add", "b.txt");
    expect(await gitStatus(dir)).toEqual({ branch: "main", added: 3, removed: 2 });
  });

  it("works before the first commit and on a detached HEAD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-"));
    run(dir, "init", "-q", "-b", "dev");
    expect(await gitStatus(dir)).toEqual({ branch: "dev", added: 0, removed: 0 });
    writeFileSync(join(dir, "a.txt"), "1\n");
    run(dir, "add", ".");
    run(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    run(dir, "checkout", "-q", "--detach");
    expect((await gitStatus(dir))?.branch).toMatch(/^[0-9a-f]{7,}$/);
  });
});
