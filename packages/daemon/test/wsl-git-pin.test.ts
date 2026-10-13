// GH-275 x #317: the repository pin (GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE) must reach git in the distro.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGit, type GitRunOptions } from "../src/git-runner.ts";
import { wslEnv, wslExeEnv, wslGitRunner, wslGitScript } from "../src/wsl-git.ts";

const out = { stdout: Buffer.from("ok"), stderr: "" };
const decode = (b64arg: string) => Buffer.from(/echo (\S+) \|/.exec(b64arg)![1]!, "base64").toString();
const ready = (d: string) => (d.toLowerCase() === "ubuntu" ? "wsl:Ubuntu" : undefined);
const R = "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo";
const pin = { GIT_DIR: `${R}\\.git`, GIT_COMMON_DIR: `${R}\\.git`, GIT_WORK_TREE: R, GIT_CEILING_DIRECTORIES: "\\\\wsl.localhost\\Ubuntu\\home\\me" };

describe("wsl-git keeps the #317 pin", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("wslEnv maps the pin to POSIX paths of the distro", () => {
    expect(wslEnv({ GIT_TERMINAL_PROMPT: "0", ...pin }, "ubuntu")).toEqual({ GIT_TERMINAL_PROMPT: "0", GIT_DIR: "/home/me/repo/.git", GIT_COMMON_DIR: "/home/me/repo/.git", GIT_WORK_TREE: "/home/me/repo", GIT_CEILING_DIRECTORIES: "/home/me" });
  });

  it("the side and the wsl.exe fallback both get the pin", async () => {
    const sideRun = vi.fn(async () => out);
    await wslGitRunner({ local: vi.fn(async () => out), side: ready, sideRun })({ cwd: R, args: ["status"], env: pin });
    expect(sideRun).toHaveBeenCalledWith("wsl:Ubuntu", expect.objectContaining({ env: expect.objectContaining({ GIT_DIR: "/home/me/repo/.git", GIT_WORK_TREE: "/home/me/repo" }) }));
    const local = vi.fn(async (_: GitRunOptions) => out);
    await wslGitRunner({ local, side: () => undefined })({ cwd: R, args: ["status"], env: pin });
    expect(decode(local.mock.calls[0]![0].args[5]!)).toContain("export GIT_DIR='/home/me/repo/.git'");
  });

  it.each([
    ["a Windows drive path", "C:\\x\\.git"],
    ["another distro", "\\\\wsl$\\Debian\\home\\me\\repo\\.git"],
    ["another UNC share", "\\\\server\\share\\repo\\.git"],
    ["a relative path", "..\\other\\.git"],
  ])("a pin value outside the distro (%s) fails closed: no git runs", async (_, bad) => {
    const local = vi.fn(async () => out);
    const sideRun = vi.fn(async () => out);
    await expect(wslGitRunner({ local, side: ready, sideRun })({ cwd: R, args: ["status"], env: { ...pin, GIT_COMMON_DIR: bad } })).rejects.toThrow();
    expect(local).not.toHaveBeenCalled();
    expect(sideRun).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("real git: a .git swapped after the check does not redirect git in the distro", async () => {
    // The distro is this Linux host: \\wsl$\Ubuntu<posix> maps back to <posix>.
    const unc = (p: string) => "\\\\wsl$\\Ubuntu" + p.replace(/\//g, "\\");
    const t = realpathSync(mkdtempSync(join(tmpdir(), "wslpin-")));
    temps.push(t);
    const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
    const main = join(t, "main");
    const secret = join(t, "secret");
    for (const d of [main, secret]) {
      mkdirSync(d);
      git(d, "init", "-q", "-b", "main");
      git(d, "-c", "user.name=a", "-c", "user.email=a@x.test", "commit", "-q", "--allow-empty", "-m", d === main ? "main" : "secret");
    }
    const wt = join(t, "wt");
    git(main, "worktree", "add", "-q", "--detach", wt);
    // Pin as git.ts pinFor builds it at check time (own = main/.git/worktrees/wt).
    const own = join(main, ".git", "worktrees", "wt");
    const env = { GIT_DIR: unc(own), GIT_COMMON_DIR: unc(join(main, ".git")), GIT_WORK_TREE: unc(wt), GIT_CEILING_DIRECTORIES: unc(t) };
    // Swap after the check: wt/.git now points to a repository outside the roots.
    writeFileSync(join(wt, ".git"), `gitdir: ${join(secret, ".git")}\n`);
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    const sideRun = (_: string, o: GitRunOptions) => runGit({ ...o, env: { ...clean, ...o.env } });
    const r = await wslGitRunner({ local: async () => out, side: ready, sideRun })({ cwd: unc(wt), args: ["log", "-1", "--format=%s"], env: env });
    expect(r.stdout.toString().trim()).toBe("main");
  });
});

it("wslGitScript is unchanged for an env without a pin", () => {
  expect(wslGitScript("/t", ["status"], {})).toBe("cd -- '/t' || exit 128\nexec git 'status'");
});

it("wsl.exe gets no GIT_* variable through WSLENV, other entries stay", async () => {
  expect(wslExeEnv({ WSLENV: "GIT_DIR/p:FOO/u:git_work_tree:BAR", A: "1" })).toEqual({ WSLENV: "FOO/u:BAR", A: "1" });
  expect(wslExeEnv({ WSLENV: "GIT_DIR/p:GIT_EXEC_PATH" })).toEqual({});
  expect(wslExeEnv({ A: "1" })).toEqual({ A: "1" });
  const prev = process.env.WSLENV;
  process.env.WSLENV = "GIT_DIR/p:FOO";
  try {
    const local = vi.fn(async (_: GitRunOptions) => out);
    await wslGitRunner({ local, side: () => undefined })({ cwd: R, args: ["status"], env: pin });
    expect(local.mock.calls[0]![0].env.WSLENV).toBe("FOO");
  } finally {
    if (prev === undefined) delete process.env.WSLENV;
    else process.env.WSLENV = prev;
  }
});
