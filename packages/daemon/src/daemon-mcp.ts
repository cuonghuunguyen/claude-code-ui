// The `claude-ui` MCP server the daemon gives each session (CONTEXT.md "Daemon MCP server"): tool groups register into it.
// Claude sessions get it as an SDK server at each query start; OpenCode sessions reach the same tools through `/opencode-mcp`.
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const DAEMON_SERVER = "claude-ui";

/** A tool's own error: its text goes back to the agent as a tool error result. */
export class ToolError extends Error {}

export type DaemonToolCtx = { sessionId: string; cwd: string; signal?: AbortSignal };
export type DaemonTool<S extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  description: string;
  shape: S;
  /** "allow": no permission request. "ask": the normal flow (Claude: CLI rules, mode, auto classifier; OpenCode: the mode's bash action). */
  permission: "allow" | "ask";
  /** The card title of an "ask" tool; undefined keeps the engine's own. */
  title?: (ctx: Pick<DaemonToolCtx, "sessionId" | "cwd">, input: Record<string, unknown>) => Promise<string | undefined> | string | undefined;
  run: (ctx: DaemonToolCtx, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
};
export type DaemonToolGroup = {
  id: string;
  /** Read at each query start (a setting change applies to the next one). */
  enabled: () => boolean;
  instructions: string;
  tools: (Omit<DaemonTool, "run"> & { run: (ctx: DaemonToolCtx, args: any) => Promise<unknown> })[];
  /** OpenCode's MCP client timeout for this group's calls. */
  timeoutMs: number;
};
type Source = { name: string; source: string };
type Rule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" };

const ok = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 1) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

export function createDaemonMcp(deps: { groups: DaemonToolGroup[]; session: (id: string) => { cwd: string } | undefined }) {
  const active = () => deps.groups.filter((g) => g.enabled());
  const find = (name: string) => active().flatMap((g) => g.tools).find((t) => t.name === name);
  const own = (s?: Source) => s?.source === "sdk" && s.name === DAEMON_SERVER;
  const prefix = `mcp__${DAEMON_SERVER}__`;

  function tools(id: string, groups: DaemonToolGroup[]) {
    return groups.flatMap((g) =>
      g.tools.map((t) =>
        tool(t.name, t.description, t.shape, async (args, extra) => {
          const parsed = z.object(t.shape).safeParse(args);
          if (!parsed.success) return fail(`Invalid input: ${z.prettifyError(parsed.error)}`);
          const s = deps.session(id);
          if (!s) return fail("This session is gone.");
          try {
            return ok(await t.run({ sessionId: id, cwd: s.cwd, signal: (extra as { signal?: AbortSignal } | undefined)?.signal }, parsed.data));
          } catch (err) {
            if (err instanceof ToolError) return fail(err.message);
            console.error(`${DAEMON_SERVER}: ${t.name} failed:`, err);
            return fail(`${t.name} failed: ${(err as Error).message}`);
          }
        }),
      ),
    );
  }
  const build = (id: string) => {
    const groups = active();
    if (!groups.length) return undefined;
    return createSdkMcpServer({ name: DAEMON_SERVER, version: "1.0.0", instructions: groups.map((g) => g.instructions).join("\n\n"), tools: tools(id, groups) });
  };

  return {
    /** The server for a new query of session `id`; undefined while no group is enabled. */
    mcpServers(id: string): Record<string, McpSdkServerConfigWithInstance> | undefined {
      const server = build(id);
      return server && { [DAEMON_SERVER]: server };
    },
    /** A new server instance for session `id`'s OpenCode route (one per MCP client session). */
    mcpServerFor: (id: string) => build(id)?.instance,
    /** "allow" for a tool that needs no permission; keyed on the server's source: a configured server of the same name never gets it. */
    toolPolicy(toolName: string, mcpServer?: Source): "allow" | undefined {
      if (!own(mcpServer) || !toolName.startsWith(prefix)) return undefined;
      return find(toolName.slice(prefix.length))?.permission === "allow" ? "allow" : undefined;
    },
    /** The card of an "ask" tool: its title (the input stays). */
    async permissionCard(id: string, toolName: string, input: Record<string, unknown>, mcpServer?: Source): Promise<{ input: Record<string, unknown>; title: string } | undefined> {
      if (!own(mcpServer) || !toolName.startsWith(prefix)) return undefined;
      const t = find(toolName.slice(prefix.length));
      const s = deps.session(id);
      if (!t?.title || !s) return undefined;
      const title = await t.title({ sessionId: id, cwd: s.cwd }, input);
      return title === undefined ? undefined : { input, title };
    },
    /** OpenCode's rules for the session's own server `name` (its tool keys are `<name>_<tool>`): allow-tools allow, ask-tools take the mode's action. */
    openCodeRules(name: string, askAction: "ask" | "allow"): Rule[] {
      return deps.groups.flatMap((g) => g.tools).map((t) => ({ permission: `${name}_${t.name}`, pattern: "*", action: t.permission === "allow" ? ("allow" as const) : askAction }));
    },
    /** The longest timeout of the enabled groups (OpenCode's MCP client). */
    timeoutMs: () => Math.max(60_000, ...active().map((g) => g.timeoutMs)),
  };
}
export type DaemonMcp = ReturnType<typeof createDaemonMcp>;
