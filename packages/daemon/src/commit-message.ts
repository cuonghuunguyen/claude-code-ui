// Claude writes a commit message for the checked files (docs/spec.md, Commit box; wire `git.commitMessage`): one
// tool-less Haiku turn on the user's subscription login. The diff comes from `gitCommitDiff`; nothing is logged.
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { WorktreeError } from "./git.ts";
import type { CommitDiff } from "./git-write.ts";
import { withoutApiKeys } from "./session.ts";
import { DEFAULT_COMMIT_INSTRUCTION, type Settings } from "@claude-ui/protocol";

/** One-shot, cheap and fast; the only place the model is chosen. */
export const COMMIT_MESSAGE_MODEL = "haiku";
/** Test seam: the generation timeout. */
export const generateConfig = { timeout: 120_000 };

export const DEFAULT_INSTRUCTION = DEFAULT_COMMIT_INSTRUCTION;
const SYSTEM = "You write git commit messages. Reply with the commit message only: no preamble, no code fence, no quotes.";

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

/** The reply text: trimmed, one surrounding code fence removed. */
export const unfence = (text: string) => text.trim().replace(/^```[^\n]*\n([\s\S]*?)\n?```$/, "$1").trim();

/** Asks Claude once. Throws WorktreeError `cancelled`, `timeout` or `generate_failed`. */
export async function generateCommitMessage(o: { cwd: string; prompt: string; signal: AbortSignal; query?: typeof sdkQuery }): Promise<string> {
  if (o.signal.aborted) throw new WorktreeError("cancelled", "cancelled");
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => ((timedOut = true), ctl.abort()), generateConfig.timeout);
  const stop = () => ctl.abort();
  o.signal.addEventListener("abort", stop, { once: true });
  const end = () => new WorktreeError(timedOut ? "timeout" : "cancelled", timedOut ? "Claude did not answer in time" : "cancelled");
  try {
    const q = (o.query ?? sdkQuery)({
      prompt: o.prompt,
      options: { systemPrompt: SYSTEM, tools: [], maxTurns: 1, persistSession: false, model: COMMIT_MESSAGE_MODEL, cwd: o.cwd, env: withoutApiKeys(process.env), settingSources: [], mcpServers: {}, strictMcpConfig: true, settings: { disableAllHooks: true }, abortController: ctl },
    });
    for await (const m of q) {
      if (m.type !== "result") continue;
      if (m.subtype !== "success" || m.is_error) throw new WorktreeError("generate_failed", ("result" in m && m.result) || `Claude failed (${m.subtype})`);
      const text = unfence(m.result);
      if (!text) throw new WorktreeError("generate_failed", "Claude returned no message");
      return text;
    }
    throw ctl.signal.aborted ? end() : new WorktreeError("generate_failed", "Claude returned no message");
  } catch (e) {
    if (e instanceof WorktreeError) throw e;
    throw ctl.signal.aborted ? end() : new WorktreeError("generate_failed", (e as Error).message);
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener("abort", stop);
  }
}
