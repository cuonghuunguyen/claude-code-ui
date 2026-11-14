import { describe, expect, it } from "vitest";
import { DAEMON_SERVER } from "../src/daemon-mcp.ts";
import { createForkGroup, FORK_GUIDANCE } from "../src/fork-guidance.ts";

describe("fork guidance group (GH-718)", () => {
  it("is a tool-less, Claude-only group that follows the setting", () => {
    let on = true;
    const g = createForkGroup(() => on);
    expect(g).toMatchObject({ id: "fork", engines: ["claude"], tools: [], instructions: FORK_GUIDANCE });
    expect(g.enabled()).toBe(true);
    on = false;
    expect(g.enabled()).toBe(false);
  });
  it("carries the do-not-fork rules, the budget rule and the fresh-subagent model hint, in at most 900 characters", () => {
    expect(FORK_GUIDANCE.length).toBeLessThanOrEqual(900);
    expect(FORK_GUIDANCE).toMatch(/5 file reads/);
    expect(FORK_GUIDANCE).toMatch(/Do not fork/i);
    expect(FORK_GUIDANCE).toMatch(/edits files the main thread also edits/i);
    expect(FORK_GUIDANCE).toMatch(/`model`/);
    expect(DAEMON_SERVER).toBe("claude-ui");
  });
});
