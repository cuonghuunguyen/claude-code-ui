// The `inline` tool group of the claude-ui MCP server (docs/spec.md "Inline tasks (GH-734)"): the agent runs a mid-size task as one
// `inline_task` call on a small model with minimized context. The engine's `EngineSession.inlineTask` runs it; this group checks the input.
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { DAEMON_SERVER, ToolError, type DaemonTool, type DaemonToolCtx, type DaemonToolGroup } from "./daemon-mcp.ts";
import { INLINE_BUILTINS, INLINE_DEFAULT_TOOLS, INLINE_MAX_PER_SESSION, INLINE_TIMEOUT_MS, type InlineBuiltin, type InlineResult, type InlineSpec } from "./inline-types.ts";

export const INLINE_INSTRUCTIONS = `inline_task runs a mid-size task in one tool call. A small model with minimized context does the work with the tools you grant and returns only the result.

Use inline_task when the task:
- needs 3-10 tool calls and only the result matters;
- needs no parent conversation context beyond what fits in prompt + files;
- is mechanical: run, extract, summarize, classify, format, small edit.

Use a subagent instead when the task needs judgment or design, long exploration, parallel runs, or parent context.
Do it directly when 1-2 tool calls suffice, or when the next step needs the raw output.

Grant the least: tools default to Read, Grep, Glob; add Bash, Write, Edit or an MCP server only when needed.

Examples:
- Test run: run the suite, return only the failures with message.
- CI failure triage: fetch the CI log, return failing test, error message, file:line.
- Log extraction: grep a large log, return the lines asked for.
- Mechanical edit: rename a symbol in a few files, return files changed and check result.`;

export const FILE_MAX_BYTES = 64 * 1024;
export const FILES_TOTAL_BYTES = 256 * 1024;
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
const kb = (n: number) => `${n / 1024} KB`;

const shape = {
  prompt: z.string().min(1).max(PROMPT_MAX).describe("The complete task: goal, where to look, and the format of the reply."),
  files: z.array(z.string().min(1)).max(20).optional().describe("Files of the project (relative or absolute) appended to the prompt; each up to 64 KB, 256 KB together."),
  tools: z.array(z.enum(INLINE_BUILTINS)).max(INLINE_BUILTINS.length).optional().describe("Built-in tools the run may use. Default: Read, Grep, Glob."),
  mcp: z.array(z.string().min(1)).max(10).optional().describe("MCP servers of this session to grant: a server name (all its tools) or mcp__<server>__<tool> (one tool)."),
  model: z.string().min(1).max(100).optional().describe("Model of the run. Default: the Inline tasks setting."),
  maxTurns: z.number().int().min(1).max(30).optional().describe("Most model turns. Default: the Inline tasks setting."),
};
type Args = { prompt: string; files?: string[]; tools?: InlineBuiltin[]; mcp?: string[]; model?: string; maxTurns?: number };

export function createInlineTask(deps: InlineTaskDeps): DaemonToolGroup {
  const real = deps.real ?? ((p: string) => p);
  const running = new Map<string, number>();

  function readFiles(cwd: string, files: string[]) {
    const root = real(cwd);
    let total = 0;
    return files.map((f) => {
      const abs = real(resolve(cwd, f));
      if (!within(root, abs)) throw new ToolError(`${f} is outside the project folder.`);
      let size: number;
      try {
        const st = statSync(abs);
        if (!st.isFile()) throw new ToolError(`${f} is not a file.`);
        size = st.size;
      } catch (e) {
        if (e instanceof ToolError) throw e;
        throw new ToolError(`${f} cannot be read: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : (e as Error).message}`);
      }
      if (size > FILE_MAX_BYTES) throw new ToolError(`${f} is larger than ${kb(FILE_MAX_BYTES)}.`);
      total += size;
      if (total > FILES_TOTAL_BYTES) throw new ToolError(`The files together are larger than ${kb(FILES_TOTAL_BYTES)}.`);
      const buf = readFileSync(abs);
      if (buf.includes(0)) throw new ToolError(`${f} is a binary file.`);
      return `<file path="${slash(relative(root, abs))}">\n${buf.toString("utf8")}\n</file>`;
    });
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
    description: "Run one self-contained task on a small, cheaper model with a minimal context; returns {status, text, model, turns, tokens, filesChanged}. The steps stay out of your context.",
    shape,
    permission: "allow",
    async run({ sessionId, cwd, signal, toolUseId }: DaemonToolCtx, a: Args) {
      const mcp = a.mcp ?? [];
      checkMcp(mcp);
      const files = readFiles(cwd, a.files ?? []);
      if ((running.get(sessionId) ?? 0) >= INLINE_MAX_PER_SESSION) throw new ToolError(`At most ${INLINE_MAX_PER_SESSION} inline tasks run at once in a session: wait for one to finish.`);
      const spec: InlineSpec = {
        text: files.length ? `${a.prompt}\n\n${files.join("\n")}` : a.prompt,
        title: (a.prompt.split("\n")[0] ?? "").trim().slice(0, TITLE_CHARS),
        tools: a.tools ?? [...INLINE_DEFAULT_TOOLS],
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
