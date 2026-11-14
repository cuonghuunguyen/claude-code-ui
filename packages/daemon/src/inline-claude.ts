// The Claude runner of an inline task (docs/spec.md "Inline tasks (GH-734)"): one minimized SDK query on a small model whose steps
// go to the parent session as child parts of the `inline_task` call. ClaudeSession wires it (claude-engine.ts); tests use the `query` seam.
import { isAbsolute, relative } from "node:path";
import type { CanUseTool, McpServerConfig, Options, PermissionMode, PermissionResult, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAdapter, type Part } from "@claude-ui/protocol";
import { withoutApiKeys } from "./claude-env.ts";
import { ToolError } from "./daemon-mcp.ts";
import { runGit } from "./git-runner.ts";
import { INLINE_OUTPUT_TOKENS, INLINE_TEXT_CHARS, INLINE_TIMEOUT_MS, type InlineHooks, type InlineResult, type InlineSpec } from "./inline-types.ts";

export const INLINE_SYSTEM = "You run one task for another agent. Use the tools you have to do it. Do not ask questions: if something is unclear, decide and say what you assumed. Reply with only the result the task asks for, no preface.";

/** Servers a run never gets: the daemon's own and the orchestration server (no recursion). Both are `source: "sdk"`. */
const NEVER = "sdk";
const STEP_TYPES = new Set<Part["type"]>(["assistant_text", "thinking", "tool_call", "tool_result", "notice"]);
const FILE_TOOLS: Record<string, string> = { Edit: "file_path", Write: "file_path", NotebookEdit: "notebook_path" };

type ParentState = {
  cwd: string;
  permissionMode: PermissionMode;
  allowBypass: boolean;
  additionalDirectories?: string[];
  /** The parent's session grants as allow rules (`allowedTools`). */
  allowedTools?: string[];
  /** The parent's deny list (a read-only Aside blocks Edit, Write, NotebookEdit): never granted, always disallowed. */
  disallowedTools?: string[];
};
/** What ClaudeSession's own permission flow needs to run for a child step: the adapter that knows the step's call, and an emit that tags parts. */
export type InlineBridge = { adapter: ReturnType<typeof createAdapter>; emit: (part: Part) => void; /** Ends the run as stopped (the main session's Stop reached a pending step). */ stop: () => void };
export type InlineClaudeDeps = {
  /** The SDK `query` (test seam). */
  query: (p: { prompt: string; options: Options }) => Query;
  parent: () => ParentState;
  /** The parent's live query: its MCP servers and effective settings. Undefined: none (grants are refused, rules fall back to grants + mode). */
  parentQuery: () => Query | undefined;
  /** Whether a model supports auto mode (the parent's rule, claude-engine setModel): a parent in auto runs a model without it in default. */
  supportsAuto?: (model: string) => boolean;
  /** Setting `inlineTask.model`. */
  defaultModel: () => string;
  /** Parent session log. */
  emit: (part: Part) => void;
  /** The parent's permission flow (ClaudeSession.canUseTool) for a step of this run. */
  canUseTool: (tool: string, input: Record<string, unknown>, opts: Parameters<CanUseTool>[2], bridge: InlineBridge) => Promise<PermissionResult>;
  /** `git status` of the folder as path -> status code; undefined outside a repository. */
  gitDirty: (cwd: string) => Promise<Map<string, string> | undefined>;
  /** The CLI env of the daemon (account applied); API keys are removed here again. */
  env: () => NodeJS.ProcessEnv;
  /** Abort per running call id (ClaudeSession.stopSubagent, close). */
  runs: Map<string, () => void>;
  limits?: { timeoutMs?: number; outputTokens?: number };
};

/** `git status --porcelain=v1 -z` of the repository holding `cwd`, absolute paths; undefined outside a repository or when git fails. */
export async function gitDirty(cwd: string): Promise<Map<string, string> | undefined> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  try {
    const top = (await runGit({ cwd, args: ["rev-parse", "--show-toplevel"], env, idempotent: true })).stdout.toString().trim();
    const out = (await runGit({ cwd, args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"], env, idempotent: true })).stdout.toString();
    const map = new Map<string, string>();
    const items = out.split("\0");
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.length < 4) continue;
      const code = it.slice(0, 2);
      map.set(`${top}/${it.slice(3)}`, code);
      if (code[0] === "R" || code[0] === "C") i++; // the rename's source follows as its own item
    }
    return map;
  } catch {
    return undefined;
  }
}

type Granted = { servers: Record<string, McpServerConfig>; disallowed: string[] };
/** The parent's connected, non-sdk servers named by `grants`: a server name (all tools) or mcp__<server>__<tool>. */
async function grantServers(parent: Query | undefined, grants: string[]): Promise<Granted> {
  if (!grants.length) return { servers: {}, disallowed: [] };
  if (!parent) throw new ToolError("No MCP server can be granted now: this session has no running query.");
  const status = await parent.mcpServerStatus();
  const usable = status.filter((s) => s.status === "connected" && s.source !== NEVER && s.config);
  const list = () => (usable.length ? `Connected servers: ${usable.map((s) => s.name).join(", ")}.` : "No MCP server is connected.");
  const whole = new Set<string>();
  const some = new Map<string, Set<string>>();
  for (const g of grants) {
    const one = g.startsWith("mcp__") ? g.slice(5).split("__") : undefined;
    const name = one ? one[0]! : g;
    const server = usable.find((s) => s.name === name);
    if (!server) throw new ToolError(`MCP server ${name} cannot be granted: it is not connected, or it is the daemon's own. ${list()}`);
    if (!one) whole.add(name);
    else {
      const tool = one.slice(1).join("__");
      if (!(server.tools ?? []).some((t) => t.name === tool)) throw new ToolError(`MCP server ${name} has no tool ${tool}. Its tools: ${(server.tools ?? []).map((t) => t.name).join(", ") || "none listed"}.`);
      if (!some.has(name)) some.set(name, new Set());
      some.get(name)!.add(tool);
    }
  }
  const servers: Record<string, McpServerConfig> = {};
  const disallowed: string[] = [];
  for (const s of usable) {
    if (!whole.has(s.name) && !some.has(s.name)) continue;
    servers[s.name] = s.config as McpServerConfig;
    if (!whole.has(s.name)) for (const t of s.tools ?? []) if (!some.get(s.name)!.has(t.name)) disallowed.push(`mcp__${s.name}__${t.name}`);
  }
  return { servers, disallowed };
}

/** `allow`, `deny` and `ask` rules of the parent's effective settings (`Query.getSettings()`, in the SDK code but not its d.ts); undefined when it has none. */
async function parentPermissions(parent: Query | undefined) {
  if (!parent) return undefined;
  try {
    const s = (await (parent as Query & { getSettings(): Promise<unknown> }).getSettings()) as { effective?: { permissions?: unknown } } | undefined;
    const p = s?.effective?.permissions;
    if (!p || typeof p !== "object") return undefined;
    const out: { allow?: string[]; deny?: string[]; ask?: string[] } = {};
    for (const k of ["allow", "deny", "ask"] as const) {
      const v = (p as Record<string, unknown>)[k];
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** The SDK options of an inline run (exported for tests). */
export function inlineClaudeOptions(
  parent: ParentState,
  spec: InlineSpec,
  x: { model: string; mcpServers: Record<string, McpServerConfig>; disallowedTools: string[]; abort: AbortController; env: NodeJS.ProcessEnv; canUseTool: CanUseTool; permissions?: object },
): Options {
  const disallowed = [...new Set([...(parent.disallowedTools ?? []), ...x.disallowedTools])];
  return {
    model: x.model,
    systemPrompt: INLINE_SYSTEM,
    settingSources: [],
    skills: [],
    tools: spec.tools.filter((t) => !parent.disallowedTools?.includes(t)),
    mcpServers: x.mcpServers,
    strictMcpConfig: true,
    ...(disallowed.length && { disallowedTools: disallowed }),
    maxTurns: spec.maxTurns,
    persistSession: false,
    cwd: parent.cwd,
    ...(parent.additionalDirectories?.length && { additionalDirectories: parent.additionalDirectories }),
    permissionMode: parent.permissionMode,
    allowDangerouslySkipPermissions: parent.allowBypass,
    ...(parent.allowedTools?.length && { allowedTools: parent.allowedTools }),
    settings: { ...(x.permissions && { permissions: x.permissions }), disableAllHooks: true },
    env: x.env,
    includePartialMessages: false,
    abortController: x.abort,
    canUseTool: x.canUseTool,
  } as Options;
}

/** Thrown inside the run to skip the query: a stop or limit came during the setup awaits. */
class Halt extends Error {}
const rel = (cwd: string, p: string) => {
  const r = relative(cwd, p);
  return r === "" || r.startsWith("..") || isAbsolute(r) ? p : r.replace(/\\/g, "/");
};

export async function runInlineClaude(deps: InlineClaudeDeps, spec: InlineSpec, hooks: InlineHooks): Promise<InlineResult> {
  const t0 = Date.now();
  const parent = deps.parent();
  const model = spec.model ?? deps.defaultModel();
  const empty = (status: InlineResult["status"]): InlineResult => ({ status, text: "", model, turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, filesChanged: [], durationMs: Date.now() - t0 });
  if (hooks.signal.aborted) return empty("stopped");

  const callId = hooks.toolUseId;
  const adapter = createAdapter();
  const tag = (p: Part): Part => ({ ...p, parentId: callId });
  const emit = (p: Part) => {
    if (callId) deps.emit(tag(p));
  };
  const abort = new AbortController();
  let why: { status: "stopped" } | { status: "limit"; limit: "time" | "tokens" } | undefined;
  const stop = (reason: NonNullable<typeof why>) => {
    why ??= reason;
    abort.abort();
  };
  const key = callId ?? `inline-${t0}-${Math.random()}`;
  const onAbort = () => stop({ status: "stopped" });
  hooks.signal.addEventListener("abort", onAbort, { once: true });
  deps.runs.set(key, onAbort);
  const timer = setTimeout(() => stop({ status: "limit", limit: "time" }), deps.limits?.timeoutMs ?? INLINE_TIMEOUT_MS);
  const maxOutput = deps.limits?.outputTokens ?? INLINE_OUTPUT_TOKENS;

  const usages = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
  const changed = new Set<string>();
  const inputs = new Map<string, { tool: string; file?: string }>();
  let text = "";
  let usedModel: string | undefined;
  let final: Record<string, any> | undefined;
  let error: string | undefined;

  let q: Query | undefined;
  let before: Map<string, string> | undefined;
  try {
    // Registered before these awaits: a close() or Stop during them must end the run too.
    const parentQuery = deps.parentQuery();
    const granted = await grantServers(parentQuery, spec.mcp);
    const permissions = await parentPermissions(parentQuery);
    before = await deps.gitDirty(parent.cwd);
    if (why) throw new Halt();
    const options = inlineClaudeOptions(parent.permissionMode === "auto" && !deps.supportsAuto?.(model) ? { ...parent, permissionMode: "default" } : parent, spec, {
      model,
      mcpServers: granted.servers,
      disallowedTools: granted.disallowed,
      abort,
      env: withoutApiKeys(deps.env()),
      permissions,
      canUseTool: (tool, input, o) => deps.canUseTool(tool, input, o, { adapter, emit, stop: () => stop({ status: "stopped" }) }),
    });
    q = deps.query({ prompt: spec.text, options });
    for await (const m of q) {
      if (m.type === "assistant" && !m.parent_tool_use_id) {
        const msg = m.message as unknown as { id: string; model?: string; content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]; usage?: Record<string, number> };
        if (msg.model && !msg.model.startsWith("<")) usedModel ??= msg.model;
        const u = msg.usage;
        if (u) usages.set(msg.id, { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 });
        const t = (msg.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
        if (t.trim()) text = t;
        for (const b of msg.content ?? []) {
          if (b.type !== "tool_use" || !b.id || !b.name) continue;
          const field = FILE_TOOLS[b.name];
          const file = field ? b.input?.[field] : undefined;
          inputs.set(b.id, { tool: b.name, ...(typeof file === "string" && { file }) });
        }
      }
      if (m.type === "result") final = m as unknown as Record<string, any>;
      for (const p of adapter.convert(m)) {
        if (!STEP_TYPES.has(p.type)) continue;
        if (p.type === "tool_call" && p.status === "done") {
          const f = inputs.get(p.toolUseId)?.file;
          if (f) changed.add(f);
        }
        emit(p);
      }
      const out = [...usages.values()].reduce((n, u) => n + u.output, 0);
      if (!why && out > maxOutput) stop({ status: "limit", limit: "tokens" });
      if (why) break;
    }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    if (!why && !(e instanceof Halt)) error = (e as Error).message || String(e);
  } finally {
    clearTimeout(timer);
    hooks.signal.removeEventListener("abort", onAbort);
    deps.runs.delete(key);
    q?.close?.();
  }

  const after = await deps.gitDirty(parent.cwd);
  if (after) for (const [path, code] of after) if (before?.get(path) !== code) changed.add(path);

  const sum = [...usages.values()].reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cacheRead: a.cacheRead + u.cacheRead, cacheWrite: a.cacheWrite + u.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const ru = final?.usage as Record<string, number> | undefined;
  const tokens = ru ? { input: ru.input_tokens ?? 0, output: ru.output_tokens ?? 0, cacheRead: ru.cache_read_input_tokens ?? 0, cacheWrite: ru.cache_creation_input_tokens ?? 0 } : sum;
  const subtype = final?.subtype as string | undefined;
  const body = text || (typeof final?.result === "string" ? final.result : "");
  const result: InlineResult = {
    status: "done",
    text: body.length > INLINE_TEXT_CHARS ? body.slice(-INLINE_TEXT_CHARS) : body,
    ...(body.length > INLINE_TEXT_CHARS && { truncated: true }),
    model: usedModel ?? model,
    // The SDK counts the turn that hit the limit (num_turns 2 at maxTurns 1): shown as used of max, never above it.
    turns: Math.min(typeof final?.num_turns === "number" ? final.num_turns : usages.size, spec.maxTurns),
    tokens,
    ...(typeof final?.total_cost_usd === "number" && { costUsd: final.total_cost_usd }),
    filesChanged: [...changed].map((f) => rel(parent.cwd, f)),
    durationMs: Date.now() - t0,
  };
  if (why) return { ...result, ...why };
  if (subtype === "error_max_turns") return { ...result, status: "limit", limit: "turns" };
  if (error !== undefined) return { ...result, status: "error", error };
  if (final && (final.is_error || (subtype && subtype !== "success"))) {
    const errs = Array.isArray(final.errors) ? (final.errors as string[]).join("; ") : "";
    return { ...result, status: "error", error: errs || (typeof final.result === "string" && final.result) || subtype || "The run failed." };
  }
  return result;
}
