import { describe, expect, it, vi } from "vitest";
import { DAEMON_SERVER } from "../src/daemon-mcp.ts";
import { INLINE_TIMEOUT_MS, type ForkResult } from "../src/inline-types.ts";
import { createForkGroup, createForkGroups, FORK_GUIDANCE, FORK_GUIDANCE_OPENCODE } from "../src/fork-guidance.ts";

describe("fork guidance group (GH-718)", () => {
  it("is a tool-less, Claude-only group that follows the setting", () => {
    let on = true;
    const g = createForkGroup(() => on);
    expect(g).toMatchObject({ id: "fork", engines: ["claude"], tools: [], instructions: FORK_GUIDANCE });
    expect(g.enabled()).toBe(true);
    on = false;
    expect(g.enabled()).toBe(false);
  });
  it("adds the OpenCode group with the fork tool, following the same setting; the tool refuses a fork without a result and returns the status and text", async () => {
    let on = true;
    const run = vi.fn(async (): Promise<ForkResult> => ({ status: "done", text: "answer", filesChanged: ["a.ts"], durationMs: 1 }));
    const [claude, opencode] = createForkGroups(() => on, run);
    expect(claude).toMatchObject({ id: "fork", engines: ["claude"], tools: [] });
    expect(opencode).toMatchObject({ engines: ["opencode"], instructions: FORK_GUIDANCE_OPENCODE });
    expect(opencode!.tools.map((t) => t.name)).toEqual(["fork"]);
    expect(opencode!.tools[0]).toMatchObject({ permission: "allow" });
    expect(opencode!.timeoutMs).toBeGreaterThanOrEqual(INLINE_TIMEOUT_MS);
    on = false;
    expect(opencode!.enabled()).toBe(false);
    const ctl = new AbortController();
    const args = { description: "d", prompt: "p" };
    expect(await opencode!.tools[0]!.run({ sessionId: "ses_a", cwd: "/p", signal: ctl.signal }, args)).toEqual({ status: "done", text: "answer", filesChanged: ["a.ts"] });
    expect(run).toHaveBeenCalledWith("ses_a", args, ctl.signal, args);
    run.mockResolvedValueOnce({ status: "error", error: "no message", text: "", filesChanged: [], durationMs: 1 });
    await expect(opencode!.tools[0]!.run({ sessionId: "ses_a", cwd: "/p" }, args)).rejects.toThrow("no message");
  });
  it("carries the do-not-fork rules, the budget rule and the fresh-subagent model hint, in at most 1000 characters", () => {
    expect(FORK_GUIDANCE.length).toBeLessThanOrEqual(1000);
    expect(FORK_GUIDANCE).toMatch(/5 file reads/);
    expect(FORK_GUIDANCE).toMatch(/Do not fork/i);
    expect(FORK_GUIDANCE).toMatch(/edits files the main thread also edits/i);
    expect(FORK_GUIDANCE).toMatch(/`model`/);
    expect(FORK_GUIDANCE).toMatch(/unbiased view/);
    expect(FORK_GUIDANCE).toMatch(/little of a large conversation/);
    expect(DAEMON_SERVER).toBe("claude-ui");
  });
});
