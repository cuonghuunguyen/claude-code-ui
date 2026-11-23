// What the OpenCode 1 and OpenCode 2 adapters share (ADR 0015): the daemon's MCP servers a session attaches to OpenCode (their names, which apply, their
// timeouts), the permission cards of their tools and the wait for a running call. Only code that is the same for both versions lives here.
import { ASIDE_NO_WORKERS } from "./aside.ts";
import { DAEMON_SERVER } from "./daemon-mcp.ts";
import { MAX_WAIT_MS } from "./orchestration.ts";
import type { SessionOpts } from "./session.ts";

/** The daemon's MCP servers a session attaches to OpenCode: orchestration, and `claude-ui` (daemon-mcp.ts). */
export type McpServerKey = "orchestration" | typeof DAEMON_SERVER;
export const MCP_KEYS: McpServerKey[] = ["orchestration", DAEMON_SERVER];
/** The name of a session's MCP server in OpenCode; its tool keys are `<name>_<tool>` (fit OpenCode's tool name limit). */
export const mcpName = (id: string, server: McpServerKey = "orchestration") => `${server}-${id.slice(-10)}`;
export const WORKER_START = "mcp__orchestration__worker_start";
export const ORCHESTRATION = { name: "orchestration", source: "sdk" };

/** The servers that apply to session `id`: the ones `mcpServers` binds to it (orchestration on, a claude-ui tool group enabled); an unkept Aside gets no orchestration. */
export function mcpKeys(opts: SessionOpts, id: string): McpServerKey[] {
  const noWorkers = !!opts.disallowedTools?.(id)?.some((t) => ASIDE_NO_WORKERS.includes(t));
  return Object.keys(opts.mcpServers?.(id, "opencode") ?? {}).filter((k): k is McpServerKey => (MCP_KEYS as string[]).includes(k) && !(k === "orchestration" && noWorkers));
}
/** OpenCode's MCP client timeout for a server's calls (`worker_wait` waits up to MAX_WAIT_MS). */
export const mcpTimeoutMs = (key: McpServerKey, opts: SessionOpts) => (key === "orchestration" ? MAX_WAIT_MS + 60_000 : (opts.daemonMcp?.timeoutMs() ?? 120_000));

/**
 * The card of a permission request for a daemon tool (`tool` as Claude names it): a claude-ui tool that asks gets its card title (terminal and command);
 * `worker_start` over a limit gets no card (`allowOnce`: the call runs and the tool repeats the refusal, orchestration.ts preflight), else the orchestration
 * card (title, `onAllow`). `show` runs only while `pending()`. False when the tool is neither: the caller shows its own card.
 */
export function showDaemonCard(o: { opts: SessionOpts; id: string; tool: string; input: Record<string, unknown>; pending: () => boolean; show: (title?: string, onAllow?: () => void) => void; allowOnce: () => void }): boolean {
  const { opts, id, tool, input } = o;
  const daemon = tool.startsWith(`mcp__${DAEMON_SERVER}__`);
  if (!daemon && tool !== WORKER_START) return false;
  if (!daemon && opts.preflight?.(id, tool, input, ORCHESTRATION) !== undefined) return (o.allowOnce(), true);
  void Promise.resolve(opts.permissionCard?.(id, tool, input, daemon ? { name: DAEMON_SERVER, source: "sdk" } : ORCHESTRATION))
    .catch(() => undefined)
    .then((card) => o.pending() && o.show(card?.title, card?.onAllow));
  return true;
}

/** The running call a run belongs to (`find` reads the mapper). Its event may come after the tool request, so it is awaited a moment. */
export async function findCall(find: () => string | undefined) {
  for (let i = 0; i < 20; i++) {
    const id = find();
    if (id || i === 19) return id;
    await new Promise((r) => setTimeout(r, 50));
  }
}
