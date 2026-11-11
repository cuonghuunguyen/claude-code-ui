// GH-298: a side lost after a git call was sent never re-runs a non-idempotent command via wsl.exe.
import { describe, expect, it, vi } from "vitest";
import type { GitRunOptions } from "../src/git-runner.ts";
import { SideGone, wslGitRunner } from "../src/wsl-git.ts";

const UNC = "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo";
const out = { stdout: Buffer.from("ok"), stderr: "" };
const ready = (d: string) => (d.toLowerCase() === "ubuntu" ? "wsl:Ubuntu" : undefined);
const add = (): GitRunOptions => ({ cwd: UNC, args: ["worktree", "add", "-b", "worktree-x", "--", "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\.claude\\worktrees\\x", "main"], env: {} });
const lost = () => new SideGone("Ubuntu stopped", true);

describe("GH-298 lost side", () => {
  it("worktree add sent to a side that then stops is not re-run through wsl.exe", async () => {
    const local = vi.fn(async () => out);
    await expect(wslGitRunner({ local, side: ready, sideRun: async () => Promise.reject(lost()) })(add())).rejects.toBeInstanceOf(SideGone);
    expect(local).not.toHaveBeenCalled();
  });

  it("worktree remove likewise", async () => {
    const local = vi.fn(async () => out);
    const r = { ...add(), args: ["worktree", "remove", "--force", "--", "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\.claude\\worktrees\\x"] };
    await expect(wslGitRunner({ local, side: ready, sideRun: async () => Promise.reject(lost()) })(r)).rejects.toBeInstanceOf(SideGone);
    expect(local).not.toHaveBeenCalled();
  });

  it("control: a side that was not ready (nothing sent) falls back once; an idempotent read lost in flight falls back once", async () => {
    const local = vi.fn(async () => out);
    await wslGitRunner({ local, side: ready, sideRun: async () => Promise.reject(new SideGone("not running")) })(add());
    expect(local).toHaveBeenCalledTimes(1);
    const local2 = vi.fn(async () => out);
    await wslGitRunner({ local: local2, side: ready, sideRun: async () => Promise.reject(lost()) })({ cwd: UNC, args: ["status"], env: {}, idempotent: true } as GitRunOptions);
    expect(local2).toHaveBeenCalledTimes(1);
  });
});
