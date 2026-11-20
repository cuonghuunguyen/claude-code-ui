// The `inline` tool group of the claude-ui MCP server (docs/spec.md "Inline tasks (GH-734)"): the agent runs a mid-size task as one
// `inline_task` call on a small model with minimized context. The engine's `EngineSession.inlineTask` runs it; this group checks the input.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { DAEMON_SERVER, ToolError, type DaemonTool, type DaemonToolCtx, type DaemonToolGroup } from "./daemon-mcp.ts";
import { INLINE_BUILTINS, INLINE_DEFAULT_TOOLS, INLINE_MAX_PER_SESSION, INLINE_TIMEOUT_MS, type InlineBuiltin, type InlineResult, type InlineSpec } from "./inline-types.ts";

export const INLINE_INSTRUCTIONS = `inline_task runs a task in one tool call and keeps its steps out of your context. A small model with minimized context does the work with the tools you grant and returns only the result.

Prefer inline_task over Agent (haiku, Explore, general-purpose) when the task:
- is mechanical: search, read logs, run tests, extract, summarize, classify, format, small edit;
- needs no judgment or design, and no parent conversation context beyond what fits in prompt + files;
- needs only the result, not the raw output.

Use a subagent instead when the task needs judgment or design, long exploration, parallel runs, or parent context.
Do it directly when 1-2 tool calls suffice, or when the next step needs the raw output.

Grant the least: tools default to Read, Grep, Glob; add Bash, Write, Edit or an MCP server only when needed.

Examples:
- Test run: run the suite, return only the failures with message.
- CI failure triage: fetch the CI log, return failing test, error message, file:line.
- Log extraction: grep a large log, return the lines asked for.
- Mechanical edit: rename a symbol in a few files, return files changed and check result.`;

/** Bytes of `files` appended to the prompt. Assumption: the smallest default run context is 200k tokens; minus output, system and tools, and at 2-3 bytes per token for dense input (minified JSON, base64), 250,000 bytes stay inside it. A file that does not fit is not appended; the run reads it with Read or Grep. */
export const INLINE_FILES_BUDGET_BYTES = 250_000;
export const PROMPT_MAX = 20_000;
const REFUSED_SERVERS = [DAEMON_SERVER, "orchestration"];
const TITLE_CHARS = 60;

export type InlineTaskDeps = {
  /** Setting `inlineTask.enabled`. */
  enabled: () => boolean;
  /** Setting `inlineTask`: the default `maxTurns` (read at each call). */
  settings: () => { maxTurns: number };
  /** Runs the task in the session's engine; throws a ToolError when the engine cannot. */
  run: (sessionId: string, spec: InlineSpec, signal: AbortSignal, toolUseId: string | undefined, input: Record<string, unknown>) => Promise<InlineResult>;
  /** The canonical form of a path (symlinks resolved); the path itself when it does not exist. */
  real?: (path: string) => string;
};

const within = (root: string, p: string) => {
  const r = relative(root, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
const slash = (p: string) => p.replace(/\\/g, "/");
const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

const shape = {
  prompt: z.string().min(1).max(PROMPT_MAX).describe("The complete task: goal, where to look, and the format of the reply."),
  files: z.array(z.string().min(1)).max(20).optional().describe("Files of the project (relative or absolute) appended to the prompt; one that is too large for the prompt is left out, the run reads it with Read or Grep."),
  tools: z.array(z.enum(INLINE_BUILTINS)).max(INLINE_BUILTINS.length).optional().describe("Built-in tools the run may use. Default: Read, Grep, Glob."),
  mcp: z.array(z.string().min(1)).max(10).optional().describe("MCP servers of this session to grant: a server name (all its tools) or mcp__<server>__<tool> (one tool)."),
  model: z.string().min(1).max(100).optional().describe("Model of the run. Default: the Inline tasks setting."),
  maxTurns: z.number().int().min(1).max(30).optional().describe("Most model turns. Default: the Inline tasks setting."),
};
type Args = { prompt: string; files?: string[]; tools?: InlineBuiltin[]; mcp?: string[]; model?: string; maxTurns?: number };

/** Reads at most `max` bytes: a file that grew after its stat does not go over the budget. */
function readUpTo(path: string, max: number) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(max);
    let got = 0;
    while (got < max) {
      const r = readSync(fd, buf, got, max - got, got);
      if (r === 0) break;
      got += r;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

const withReadGrep = (tools: InlineBuiltin[], left: boolean): InlineBuiltin[] => (left ? [...tools, ...(["Read", "Grep"] as const).filter((t) => !tools.includes(t))] : tools);

export function createInlineTask(deps: InlineTaskDeps): DaemonToolGroup {
  const real = deps.real ?? ((p: string) => p);
  const running = new Map<string, number>();

  /** Appends files in input order while they fit the budget; the rest are named in a trailer and the run gets Read and Grep for them. */
  function readFiles(cwd: string, files: string[]) {
    const root = real(cwd);
    const found = files.map((f) => {
      const abs = real(resolve(cwd, f));
      if (!within(root, abs)) throw new ToolError(`${f} is outside the project folder.`);
      try {
        const st = statSync(abs);
        if (!st.isFile()) throw new ToolError(`${f} is not a file.`);
        return { abs, size: st.size };
      } catch (e) {
        if (e instanceof ToolError) throw e;
        throw new ToolError(`${f} cannot be read: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : (e as Error).message}`);
      }
    });
    let used = 0;
    let left = false;
    const parts = found.map(({ abs, size: n }, i) => {
      const path = slash(relative(root, abs));
      if (used + n > INLINE_FILES_BUDGET_BYTES) {
        left = true;
        return `<file path="${path}" size="${size(n)}" not-included>Too large to include: read it with Grep or Read.</file>`;
      }
      const buf = readUpTo(abs, n);
      if (buf.includes(0)) throw new ToolError(`${files[i]} is a binary file.`);
      used += n;
      return `<file path="${path}">\n${buf.toString("utf8")}\n</file>`;
    });
    return { parts, left };
  }

  function checkMcp(mcp: string[]) {
    for (const g of mcp) {
      const one = g.startsWith("mcp__") ? g.slice(5).split("__") : undefined;
      if (one && (one.length < 2 || !one[0] || !one.slice(1).join("__"))) throw new ToolError(`${g} is not a server name or mcp__<server>__<tool>.`);
      const server = one ? one[0]! : g;
      if (REFUSED_SERVERS.includes(server)) throw new ToolError(`${server} cannot be granted to an inline task (no recursion).`);
    }
  }

  const inlineTask = {
    name: "inline_task",
    description:
      "Run a mechanical task (search, read logs, run tests, extract, summarize, small edit) in one call without filling your context: a small model does the steps and only the result comes back, {status, text, model, turns, tokens, filesChanged}. Prefer it over Agent when the task needs no judgment and only the result matters: about 5k tokens to start against 25-30k for a subagent, median 6.6 s.",
    shape,
    alwaysLoad: true,
    permission: "allow",
    async run({ sessionId, cwd, signal, toolUseId }: DaemonToolCtx, a: Args) {
      const mcp = a.mcp ?? [];
      checkMcp(mcp);
      const { parts: files, left } = readFiles(cwd, a.files ?? []);
      if ((running.get(sessionId) ?? 0) >= INLINE_MAX_PER_SESSION) throw new ToolError(`At most ${INLINE_MAX_PER_SESSION} inline tasks run at once in a session: wait for one to finish.`);
      const spec: InlineSpec = {
        text: files.length ? `${a.prompt}\n\n${files.join("\n")}` : a.prompt,
        title: (a.prompt.split("\n")[0] ?? "").trim().slice(0, TITLE_CHARS),
        tools: withReadGrep(a.tools ?? [...INLINE_DEFAULT_TOOLS], left),
        mcp,
        model: a.model,
        maxTurns: a.maxTurns ?? deps.settings().maxTurns,
      };
      running.set(sessionId, (running.get(sessionId) ?? 0) + 1);
      try {
        return await deps.run(sessionId, spec, signal ?? new AbortController().signal, toolUseId, a as Record<string, unknown>);
      } finally {
        const n = (running.get(sessionId) ?? 1) - 1;
        if (n > 0) running.set(sessionId, n);
        else running.delete(sessionId);
      }
    },
  } satisfies DaemonTool<typeof shape>;

  return { id: "inline", enabled: deps.enabled, instructions: INLINE_INSTRUCTIONS, tools: [inlineTask], timeoutMs: INLINE_TIMEOUT_MS + 60_000 };
}
