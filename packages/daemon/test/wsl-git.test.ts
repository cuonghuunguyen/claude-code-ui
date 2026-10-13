import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { GitRunOptions } from "../src/git-runner.ts";
import { SideGone, wslGitRunner, wslGitScript } from "../src/wsl-git.ts";

const UNC = "\\\\wsl.localhost\\ubuntu\\home\\me\\repo";
const out = { stdout: Buffer.from("ok"), stderr: "" };
const decode = (b64arg: string) => Buffer.from(/echo (\S+) \|/.exec(b64arg)![1]!, "base64").toString();

describe("wsl-git runner", () => {
  const base = (): GitRunOptions => ({ cwd: UNC, args: ["worktree", "remove", "--force", "--", "\\\\wsl$\\Ubuntu\\home\\me\\wt", "\\\\wsl$\\Other\\x"], env: { PATH: "C:\\x", GIT_SSH: "C:\\ssh.exe", GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: "\\\\wsl.localhost\\Ubuntu\\home\\me;C:\\win;\\\\wsl$\\Other\\q" } });
  const ready = (d: string) => (d.toLowerCase() === "ubuntu" ? "wsl:Ubuntu" : undefined);

  it("a UNC WSL cwd goes to the ready side with the POSIX path and the same-distro path args translated", async () => {
    const local = vi.fn(async () => out);
    const sideRun = vi.fn(async () => out);
    await wslGitRunner({ local, side: ready, sideRun })(base());
    expect(local).not.toHaveBeenCalled();
    expect(sideRun).toHaveBeenCalledTimes(1);
    expect(sideRun).toHaveBeenCalledWith("wsl:Ubuntu", expect.objectContaining({ cwd: "/home/me/repo", args: ["worktree", "remove", "--force", "--", "/home/me/wt", "\\\\wsl$\\Other\\x"], env: { GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: "/home/me" } }));
  });

  it("no ready side: one wsl.exe process through the local runner, never git with a UNC cwd", async () => {
    const local = vi.fn(async (_: GitRunOptions) => out);
    const r = base();
    await wslGitRunner({ local, side: () => undefined })(r);
    expect(local).toHaveBeenCalledTimes(1);
    const o = local.mock.calls[0]![0];
    expect(o.file).toBe("wsl.exe");
    expect(o.cwd).toBe(homedir());
    expect(o.args.slice(0, 5)).toEqual(["-d", "ubuntu", "--exec", "bash", "-c"]);
    const args = ["worktree", "remove", "--force", "--", "/home/me/wt", "\\\\wsl$\\Other\\x"];
    expect(decode(o.args[5]!)).toBe(wslGitScript("/home/me/repo", args, { GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: "/home/me" }));
    expect(local.mock.calls.every(([c]) => c.file === "wsl.exe")).toBe(true);
  });

  it("a side gone during the call falls back to wsl.exe once; a git failure from the side does not", async () => {
    const local = vi.fn(async (_: GitRunOptions) => out);
    await wslGitRunner({ local, side: ready, sideRun: async () => Promise.reject(new SideGone("x")) })(base());
    expect(local).toHaveBeenCalledTimes(1);
    expect(local.mock.calls[0]![0].file).toBe("wsl.exe");
    const fail = Object.assign(new Error("git"), { code: 128, stderr: "fatal" });
    const local2 = vi.fn(async () => out);
    await expect(wslGitRunner({ local: local2, side: ready, sideRun: async () => Promise.reject(fail) })(base())).rejects.toBe(fail);
    expect(local2).not.toHaveBeenCalled();
  });

  it("other cwds use the local runner unchanged", async () => {
    const local = vi.fn(async (_: GitRunOptions) => out);
    const sideRun = vi.fn(async () => out);
    const run = wslGitRunner({ local, side: ready, sideRun });
    for (const cwd of ["C:\\repo", "/home/me"]) {
      const o = { cwd, args: ["status"], env: { A: "1" } };
      await run(o);
      expect(local).toHaveBeenLastCalledWith(o);
    }
    expect(sideRun).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("the script quotes every argument", () => {
    const args = ["a'b", "x  y", "$(id)", "é", "*"];
    expect(wslGitScript("/t", ["a'b"], {})).toContain("exec git 'a'\\''b'");
    const script = wslGitScript("/", args, { K: "v w" }).replace("exec git", "exec printf '%s\\0'");
    const res = execFileSync("bash", ["-c", script], { encoding: "utf8" });
    expect(res.split("\0").slice(0, -1)).toEqual(args);
  });
});

describe("wslEnv remote switches", () => {
  it("forwards the no-prompt switches and only our BatchMode ssh command", async () => {
    const { wslEnv } = await import("../src/wsl-git.ts");
    const { BATCH_SSH } = await import("../src/git-runner.ts");
    expect(wslEnv({ GIT_ASKPASS: "", SSH_ASKPASS: "", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: BATCH_SSH }, "Ubuntu")).toEqual({ GIT_ASKPASS: "", SSH_ASKPASS: "", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: BATCH_SSH });
    expect(wslEnv({ GIT_SSH_COMMAND: "C:\\ssh.exe" }, "Ubuntu")).toEqual({});
  });

  it("a wsl project's fetch still routes through the wsl runner with the no-prompt env", async () => {
    const { wslGitRunner } = await import("../src/wsl-git.ts");
    const { BATCH_SSH } = await import("../src/git-runner.ts");
    const seen: GitRunOptions[] = [];
    const r = wslGitRunner({ local: async () => ({ stdout: Buffer.alloc(0), stderr: "" }), side: () => "s1", sideRun: async (_id, o) => (seen.push(o), { stdout: Buffer.alloc(0), stderr: "" }) });
    await r({ cwd: "\\\\wsl$\\Ubuntu\\home\\u\\p", args: ["fetch", "--all"], env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_SSH_COMMAND: BATCH_SSH } });
    expect(seen[0]).toMatchObject({ cwd: "/home/u/p", args: ["fetch", "--all"], env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_SSH_COMMAND: BATCH_SSH } });
  });
});
