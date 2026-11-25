// Claude writes a commit message for the checked files (docs/spec.md, Commit box; wire `git.commitMessage`): one
// tool-less turn (model `git.commitMessageModel`, default Haiku) on the user's subscription login. OpenCode runs the same prompt through the
// catalogue's `oneShot` (area-git.ts); a Claude login error is `generate_auth`, the one case that falls back to it (GH-984). The diff comes from `gitCommitDiff`; nothing is logged.
import { tmpdir } from "node:os";
import { query as sdkQuery, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { WorktreeError } from "./git.ts";
import type { CommitDiff } from "./git-write.ts";
import { claudeEnv } from "./claude-env.ts";
import { DEFAULT_COMMIT_INSTRUCTION, type Settings } from "@claude-ui/protocol";

/** The Claude model when none is set (`git.commitMessageModel`, GH-984): one-shot, cheap and fast. */
export const DEFAULT_COMMIT_MODEL = "haiku";
/** Test seam: the generation timeout. */
export const generateConfig = { timeout: 120_000 };

export const DEFAULT_INSTRUCTION = DEFAULT_COMMIT_INSTRUCTION;
/** The system prompt of the generator, the same on every Engine. */
export const COMMIT_SYSTEM = "You write git commit messages. Reply with the commit message only: no preamble, no code fence, no quotes. Keep every length limit the instruction sets; count the characters of the subject line. Wrap body lines at 72 characters unless the instruction says otherwise.";

/** The project's own instruction, else the global one, else the built-in; a blank value counts as unset. */
export function instructionFor(git: Pick<Settings["git"], "commitMessageInstruction" | "commitMessageInstructions">, project?: string): string {
  const own = project !== undefined && Object.hasOwn(git.commitMessageInstructions, project) ? git.commitMessageInstructions[project]!.trim() : "";
  return own || git.commitMessageInstruction.trim() || DEFAULT_INSTRUCTION;
}

export function promptFor(instruction: string, d: CommitDiff): string {
  const note =
    d.cut === "chars" ? `\nThe diff was truncated to ${d.diff.length} of ${d.total} characters; the file list above is complete.`
    : d.cut === "patch" ? "\nThe patch was too large to include; only the file list is given."
    : "";
  return `${instruction}\n\nThe changes to commit (git diff):\n\n${d.diff}${note}`;
}

const LOGIN_TEXT = "Not logged in · Please run /login";
const LOGIN_RE = /not logged in|please run \/login|invalid api key/i;
/** The text of an assistant message (the CLI's own words for a login error). */
const textOf = (m: SDKMessage): string => {
  const c = (m as { message?: { content?: unknown } }).message?.content;
  return Array.isArray(c) ? c.map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : "")).join("").trim() : "";
};

/** The reply text: trimmed, one surrounding code fence removed. */
export const unfence = (text: string) => text.trim().replace(/^```[^\n]*\n([\s\S]*?)\n?```$/, "$1").trim();

const optionsFor = (cwd: string, abortController: AbortController, model: string, env: NodeJS.ProcessEnv = claudeEnv()) => ({ systemPrompt: COMMIT_SYSTEM, thinking: { type: "disabled" as const }, tools: [], maxTurns: 1, persistSession: false, model, cwd, env, settingSources: [], mcpServers: {}, strictMcpConfig: true, settings: { disableAllHooks: true }, abortController });

/** A started Claude CLI process that waits for its one message. */
type Spare = { messages: AsyncIterable<SDKMessage>; ctl: AbortController; send: (text: string) => void };

/**
 * The warm generator (GH-668): keeps one streaming-input Haiku process started and idle, so a click does not pay the CLI start.
 * Each process answers exactly one message and is then ended and replaced, so no earlier diff is ever in its context.
 * `cwd` is a neutral folder: the process reads no project file (no tools, no setting sources), the diff is in the prompt.
 */
export function createWarmCommitMessage(query: typeof sdkQuery = sdkQuery, model: () => string = () => DEFAULT_COMMIT_MODEL) {
  let spare: Spare | undefined;
  let on = true;
  const spawn = (): Spare => {
    const ctl = new AbortController();
    let send!: (text: string) => void;
    const first = new Promise<string>((r) => (send = r));
    async function* input() {
      const content = await first;
      yield { type: "user" as const, message: { role: "user" as const, content }, parent_tool_use_id: null };
    }
    return { messages: query({ prompt: input(), options: optionsFor(tmpdir(), ctl, model()) as never }), ctl, send };
  };
  return {
    /** The ready process (a new one when none is ready). The caller ends it with `release`. */
    take(): Spare {
      const s = spare ?? spawn();
      spare = undefined;
      return s;
    },
    /** Ends a taken process and starts the next ready one. */
    release(s: Spare) {
      s.ctl.abort();
      if (on && !spare) spare = spawn();
    },
    /** Starts the ready process now (the setting was switched on). */
    prewarm() {
      on = true;
      spare ??= spawn();
    },
    /** Ends the ready process; nothing restarts until `prewarm` or the next `take`. */
    stop() {
      on = false;
      spare?.ctl.abort();
      spare = undefined;
    },
  };
}
export type WarmCommitMessage = ReturnType<typeof createWarmCommitMessage>;

/** Asks Claude once. Throws WorktreeError `cancelled`, `timeout`, `generate_auth` (Claude is not logged in: the caller may fall back) or `generate_failed`. `warm`: a ready process answers (one retry on a crashed one). */
export async function generateCommitMessage(o: { cwd: string; prompt: string; signal: AbortSignal; /** Claude model; default `haiku`. A `warm` process runs on its own model: pass it only when that is this one. */ model?: string; query?: typeof sdkQuery; warm?: WarmCommitMessage; /** The CLI's env (the Project's Claude account); absent: the daemon's. A `warm` process always runs on the daemon's account: pass it only then. */ env?: NodeJS.ProcessEnv }): Promise<string> {
  if (o.signal.aborted) throw new WorktreeError("cancelled", "cancelled");
  let ctl = new AbortController();
  let timedOut = false;
  let stopped = false;
  const timer = setTimeout(() => ((timedOut = true), ctl.abort()), generateConfig.timeout);
  const stop = () => ((stopped = true), ctl.abort());
  o.signal.addEventListener("abort", stop, { once: true });
  const end = () => new WorktreeError(timedOut ? "timeout" : "cancelled", timedOut ? "Claude did not answer in time" : "cancelled");
  const read = async (messages: AsyncIterable<SDKMessage>): Promise<string | undefined> => {
    for await (const m of messages) {
      // Not logged in: the CLI answers with this assistant message, then an error result (probe, GH-984). No retry, the caller decides.
      if (m.type === "assistant" && m.error === "authentication_failed") throw new WorktreeError("generate_auth", textOf(m) || LOGIN_TEXT);
      if (m.type !== "result") continue;
      if (m.subtype !== "success" || m.is_error) {
        const text = ("result" in m && m.result) || `Claude failed (${m.subtype})`;
        throw new WorktreeError(LOGIN_RE.test(text) ? "generate_auth" : "generate_failed", text);
      }
      const text = unfence(m.result);
      if (!text) throw new WorktreeError("generate_failed", "Claude returned no message");
      return text;
    }
    return undefined;
  };
  try {
    if (!o.warm) {
      const q = (o.query ?? sdkQuery)({ prompt: o.prompt, options: optionsFor(o.cwd, ctl, o.model || DEFAULT_COMMIT_MODEL, o.env) as never });
      const text = await read(q);
      if (text !== undefined) return text;
      throw ctl.signal.aborted ? end() : new WorktreeError("generate_failed", "Claude returned no message");
    }
    let last = "Claude returned no message";
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = o.warm.take();
      ctl = s.ctl;
      if (stopped || timedOut) ctl.abort();
      try {
        s.send(o.prompt);
        const text = await read(s.messages);
        if (text !== undefined) return text;
        if (ctl.signal.aborted) throw end();
      } catch (e) {
        if (e instanceof WorktreeError) throw e;
        if (ctl.signal.aborted) throw end();
        last = (e as Error).message;
      } finally {
        o.warm.release(s);
      }
    }
    throw new WorktreeError("generate_failed", last);
  } catch (e) {
    if (e instanceof WorktreeError) throw e;
    throw ctl.signal.aborted ? end() : new WorktreeError("generate_failed", (e as Error).message);
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener("abort", stop);
  }
}

/** The ready process runs only while the setting is on and the global engine is Claude (GH-984). */
export const warmWanted = (s: Pick<Settings, "git">) => s.git.commitMessageWarm && s.git.commitMessageEngine === "claude";
