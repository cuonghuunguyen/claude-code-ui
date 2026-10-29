// GH-298: file search and the read-only git scan of a UNC WSL project go through the git runner, pinned (#317).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitRepo } from "@claude-ui/protocol";
import { setGitRunner, threadRunner, type GitRunOptions } from "../src/git-runner.ts";
import { repoSafetyAsync } from "../src/git-readonly.ts";
import { clearSearchCache, searchFiles } from "../src/search.ts";

const UNC = "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo";
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
afterEach(() => (setGitRunner(undefined), vi.restoreAllMocks()));
beforeEach(() => clearSearchCache());

describe("GH-298 search and git-readonly of a UNC WSL project", () => {
  it("file search of a UNC WSL cwd lists files through the git runner", async () => {
    const calls: GitRunOptions[] = [];
    setGitRunner(async (o) => (calls.push(o), { stdout: Buffer.from(o.args.includes("--deleted") ? "" : "src/a.ts\0"), stderr: "" }));
    const paths = await searchFiles(UNC, "");
    expect(calls.some((c) => c.cwd === UNC && c.args.includes("ls-files"))).toBe(true);
    expect(paths).toContain("src/a.ts");
  });

  it("file search of a UNC WSL cwd lists nested repositories through the runner, cached", async () => {
    const calls: GitRunOptions[] = [];
    setGitRunner(async (o) => (calls.push(o), { stdout: Buffer.from(o.args.includes("--deleted") ? "" : o.cwd === UNC ? "a.ts\0" : "x.ts\0"), stderr: "" }));
    const repos = [{ rel: "", path: UNC }, { rel: "api", path: `${UNC}\\api`, kind: "nested" }] as GitRepo[];
    expect(await searchFiles(UNC, "", 50, repos)).toEqual(expect.arrayContaining(["a.ts", "api/", "api/x.ts"]));
    expect(calls.filter((c) => c.cwd === `${UNC}\\api`)).toHaveLength(2);
    const n = calls.length;
    await searchFiles(UNC, "x", 50, repos);
    expect(calls.length).toBe(n);
  });

  it("file search pins the repository (#317): every ls-files gets GIT_DIR and GIT_WORK_TREE", async () => {
    const dir = tmp("gh298s-");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "x");
    const envs: NodeJS.ProcessEnv[] = [];
    setGitRunner((o) => (envs.push(o.env), threadRunner(o)));
    expect(await searchFiles(dir, "")).toContain("a.txt");
    expect(envs.length).toBeGreaterThan(0);
    expect(envs.every((e) => e.GIT_DIR === join(dir, ".git") && e.GIT_WORK_TREE === dir)).toBe(true);
  });

  // On Linux a UNC path is relative: one folder named like it under a mocked cwd stands for the distro folder.
  it.skipIf(process.platform === "win32")("the read-only git scan of a UNC WSL cwd runs git through the runner, pinned", async () => {
    const base = tmp("gh298r-");
    const repo = join(base, UNC);
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    vi.spyOn(process, "cwd").mockReturnValue(base);
    const calls: GitRunOptions[] = [];
    setGitRunner(async (o) => (calls.push(o), { stdout: Buffer.from(o.args.includes("config") ? "local\0file:.git/config\0core.hookspath\n.hooks\0" : ""), stderr: "" }));
    const s = await repoSafetyAsync(UNC, performance.now());
    const inRepo = calls.filter((c) => c.env.GIT_DIR !== undefined);
    expect(inRepo.some((c) => c.args.includes("config"))).toBe(true);
    expect(inRepo.every((c) => c.env.GIT_DIR === join(repo, ".git") && c.env.GIT_WORK_TREE === repo)).toBe(true);
    expect(s.why).toContain("local core.hookspath");
  });
  // The Bash tool of a UNC project may run the host's (Windows) git: its system and global config count too.
  it.skipIf(process.platform === "win32")("the scan of a UNC WSL cwd also reads the host git's system and global config", async () => {
    const base = tmp("gh298h-");
    mkdirSync(join(base, UNC));
    vi.spyOn(process, "cwd").mockReturnValue(base);
    setGitRunner(async (o) => ({ stdout: Buffer.from(o.cwd === homedir() && o.args.includes("config") ? "global\0file:C:/Users/me/.gitconfig\0core.fsmonitor\n.\\fsm.exe\0local\0file:.git/config\0core.hookspath\n.hooks\0" : ""), stderr: "" }));
    const s = await repoSafetyAsync(UNC, performance.now());
    expect(s.why).toContain("global core.fsmonitor");
    expect(s.why).not.toContain("local core.hookspath");
  });
});
