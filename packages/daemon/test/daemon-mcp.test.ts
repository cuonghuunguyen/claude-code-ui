import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDaemonMcp, DAEMON_SERVER, ToolError, type DaemonToolGroup } from "../src/daemon-mcp.ts";

const SDK = { name: DAEMON_SERVER, source: "sdk" };
function group(over: Partial<DaemonToolGroup> = {}): DaemonToolGroup {
  return {
    id: "demo",
    enabled: () => true,
    instructions: "Demo tools.",
    timeoutMs: 90_000,
    tools: [
      { name: "demo_read", description: "read", shape: { n: z.number() }, permission: "allow", run: async (ctx, a: { n: number }) => ({ n: a.n, cwd: ctx.cwd, session: ctx.sessionId }) },
      {
        name: "demo_run",
        description: "run",
        shape: {},
        permission: "ask",
        title: (_c, input) => (input.fail ? undefined : `Run ${String(input.what)}`),
        run: async () => {
          throw new ToolError("busy");
        },
      },
    ],
    ...over,
  };
}
const make = (groups: DaemonToolGroup[], session: (id: string) => { cwd: string } | undefined = () => ({ cwd: "/p" })) => createDaemonMcp({ groups, session });

describe("createDaemonMcp", () => {
  it("serves one claude-ui server with the instructions of the enabled groups only", () => {
    const mcp = make([group(), group({ id: "off", enabled: () => false, instructions: "Off." }), group({ id: "two", instructions: "Two.", tools: [] })]);
    const servers = mcp.mcpServers("s")!;
    expect(Object.keys(servers)).toEqual([DAEMON_SERVER]);
    expect(servers[DAEMON_SERVER]!.type).toBe("sdk");
    expect(mcp.mcpServerFor("s")).toBeDefined();
  });
  it("a group with engines [claude] and no tools is in the Claude server only; the OpenCode route skips it (GH-718)", async () => {
    const only = group({ id: "fork", instructions: "Fork rules.", tools: [], engines: ["claude"] });
    const instructions = async (server: { connect: (t: never) => Promise<void> }) => {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a as never);
      const c = new Client({ name: "t", version: "1" });
      await c.connect(b);
      return c.getInstructions() ?? "";
    };
    const alone = make([only]);
    expect(await instructions(alone.mcpServers("s")![DAEMON_SERVER]!.instance as never)).toBe("Fork rules.");
    expect(alone.mcpServerFor("s")).toBeUndefined();
    // OpenCode asks which servers to attach: a Claude-only group alone gives it none.
    expect(alone.mcpServers("s", "opencode")).toBeUndefined();
    const mixed = make([group(), only]);
    expect(await instructions(mixed.mcpServers("s")![DAEMON_SERVER]!.instance as never)).toContain("Fork rules.");
    expect(await instructions(mixed.mcpServerFor("s") as never)).toBe("Demo tools.");
    expect(make([{ ...only, enabled: () => false }]).mcpServers("s")).toBeUndefined();
  });
  it("serves nothing while no group is enabled (read at each call)", () => {
    let on = false;
    const mcp = make([group({ enabled: () => on })]);
    expect(mcp.mcpServers("s")).toBeUndefined();
    expect(mcp.mcpServerFor("s")).toBeUndefined();
    on = true;
    expect(mcp.mcpServers("s")).toBeDefined();
  });

  it("toolPolicy allows an allow-tool of the sdk server only", () => {
    const mcp = make([group()]);
    expect(mcp.toolPolicy("mcp__claude-ui__demo_read", SDK)).toBe("allow");
    expect(mcp.toolPolicy("mcp__claude-ui__demo_run", SDK)).toBeUndefined();
    expect(mcp.toolPolicy("mcp__claude-ui__unknown", SDK)).toBeUndefined();
    // A user-configured server of the same name gets no policy.
    expect(mcp.toolPolicy("mcp__claude-ui__demo_read", { name: DAEMON_SERVER, source: "project" })).toBeUndefined();
    expect(mcp.toolPolicy("mcp__orchestration__demo_read", { name: "orchestration", source: "sdk" })).toBeUndefined();
  });
  it("a tool of a disabled group is not allowed", () => {
    expect(make([group({ enabled: () => false })]).toolPolicy("mcp__claude-ui__demo_read", SDK)).toBeUndefined();
  });

  it("permissionCard gives the title of an ask-tool and keeps the input", async () => {
    const mcp = make([group()]);
    expect(await mcp.permissionCard("s", "mcp__claude-ui__demo_run", { what: "x" }, SDK)).toEqual({ input: { what: "x" }, title: "Run x" });
    expect(await mcp.permissionCard("s", "mcp__claude-ui__demo_run", { fail: true }, SDK)).toBeUndefined();
    expect(await mcp.permissionCard("s", "mcp__claude-ui__demo_read", {}, SDK)).toBeUndefined();
    expect(await mcp.permissionCard("s", "mcp__claude-ui__demo_run", { what: "x" }, { name: DAEMON_SERVER, source: "user" })).toBeUndefined();
  });

  it("openCodeRules: allow-tools allow, ask-tools take the mode's action", () => {
    const mcp = make([group()]);
    expect(mcp.openCodeRules("claude-ui-abc", "ask")).toEqual([
      { permission: "claude-ui-abc_demo_read", pattern: "*", action: "allow" },
      { permission: "claude-ui-abc_demo_run", pattern: "*", action: "ask" },
    ]);
    expect(mcp.openCodeRules("claude-ui-abc", "allow")[1]!.action).toBe("allow");
  });
  it("timeoutMs is the longest of the enabled groups, at least a minute", () => {
    expect(make([group({ timeoutMs: 150_000 }), group({ id: "b", timeoutMs: 1 })]).timeoutMs()).toBe(150_000);
    expect(make([group({ enabled: () => false })]).timeoutMs()).toBe(60_000);
  });

  describe("tool calls over MCP", () => {
    async function client(mcp: ReturnType<typeof make>) {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await mcp.mcpServerFor("s")!.connect(a);
      const c = new Client({ name: "t", version: "1" });
      await c.connect(b);
      return c;
    }
    const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
    it("runs a tool with the session's folder, checks the input, maps a ToolError to a tool error", async () => {
      const c = await client(make([group()]));
      expect(JSON.parse(text(await c.callTool({ name: "demo_read", arguments: { n: 2 } })))).toEqual({ n: 2, cwd: "/p", session: "s" });
      const bad = (await c.callTool({ name: "demo_read", arguments: { n: "x" } })) as { isError?: boolean };
      expect(bad.isError).toBe(true);
      const err = (await c.callTool({ name: "demo_run", arguments: {} })) as { isError?: boolean };
      expect(err.isError).toBe(true);
      expect(text(err)).toBe("busy");
    });
    it("an unexpected error is logged and returned as a tool error", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const boom = group({ tools: [{ name: "boom", description: "d", shape: {}, permission: "allow", run: async () => Promise.reject(new Error("kaput")) }] });
      const r = (await (await client(make([boom]))).callTool({ name: "boom", arguments: {} })) as { isError?: boolean };
      expect(r.isError).toBe(true);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
    it("passes the calling tool_use id (_meta claudecode/toolUseId) and the abort signal to the tool's ctx", async () => {
      let seen: { toolUseId?: string; signal?: AbortSignal } = {};
      const g = group({ tools: [{ name: "who", description: "d", shape: {}, permission: "allow", run: async (ctx) => ((seen = ctx), "ok") }] });
      const c = await client(make([g]));
      await c.callTool({ name: "who", arguments: {}, _meta: { "claudecode/toolUseId": "toolu_42" } });
      expect(seen.toolUseId).toBe("toolu_42");
      expect(seen.signal).toBeInstanceOf(AbortSignal);
      await c.callTool({ name: "who", arguments: {} });
      expect(seen.toolUseId).toBeUndefined();
      await c.callTool({ name: "who", arguments: {}, _meta: { "claudecode/toolUseId": 7 } });
      expect(seen.toolUseId).toBeUndefined();
    });
    it("a gone session gives a tool error", async () => {
      const r = (await (await client(make([group()], () => undefined))).callTool({ name: "demo_read", arguments: { n: 1 } })) as { isError?: boolean };
      expect(r.isError).toBe(true);
    });
  });
});
