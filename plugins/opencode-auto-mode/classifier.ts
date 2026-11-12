// Runs one classifier decision: builds the transcript, creates a fresh session (no parentID,
// so the claude-ui daemon doesn't treat it as its child), prompts the hidden classifier agent,
// reads the reply, then always deletes the session. Any failure resolves to `null` (do nothing).
import type { CachedToolCall } from "./transcript.ts";
import { buildActionRecord, encodeTranscript } from "./transcript.ts";
import { parseVerdict, type Verdict } from "./verdict.ts";
import type { MessageInfo, OpencodeClient, PermissionAskedProperties, TranscriptMessage } from "./types.ts";

export const CLASSIFIER_AGENT = "auto-mode-classifier";
export const CLASSIFIER_TITLE = "auto-mode classifier";

export interface ClassifyContext {
  client: OpencodeClient;
  directory: string;
  model?: string;
  transcriptChars?: number;
  timeoutMs: number;
  /** Mutated: the classifier session is added before prompting, removed once done. */
  classifierSessions: Set<string>;
  toolInputCache: Map<string, CachedToolCall>;
}

export interface ModelRef {
  providerID: string;
  modelID: string;
}

function parseModelOption(model: string | undefined): ModelRef | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash < 0) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/** The model of the asking session's latest assistant/user message, newest first. */
export function resolveSessionModel(messages: TranscriptMessage[]): ModelRef | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info: MessageInfo = messages[i].info;
    if (info.role === "assistant" && info.providerID && info.modelID) {
      return { providerID: info.providerID, modelID: info.modelID };
    }
    if (info.role === "user" && info.model) {
      return info.model;
    }
  }
  return undefined;
}

function isTextPart(part: { type: string }): part is { type: "text"; text: string } {
  return part.type === "text" && typeof (part as { text?: unknown }).text === "string";
}

export async function classify(permissionInfo: PermissionAskedProperties, ctx: ClassifyContext): Promise<Verdict | null> {
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, ctx.timeoutMs);
  let classifierSessionID: string | undefined;
  try {
    const transcriptResp = await ctx.client.session.messages({
      path: { id: permissionInfo.sessionID },
      query: { directory: ctx.directory },
      signal: abort.signal,
    });
    if (transcriptResp.error || !transcriptResp.data) return null;
    const messages = transcriptResp.data;

    const model = parseModelOption(ctx.model) ?? resolveSessionModel(messages);
    if (!model) return null;

    const cached = permissionInfo.tool ? ctx.toolInputCache.get(permissionInfo.tool.callID) : undefined;
    const actionLine = buildActionRecord(permissionInfo.permission, permissionInfo.patterns, permissionInfo.metadata, cached);
    const transcriptText = `## Transcript\n${encodeTranscript(messages, { transcriptChars: ctx.transcriptChars })}\n\n## Action\n${actionLine}`;

    const created = await ctx.client.session.create({ body: { title: CLASSIFIER_TITLE }, query: { directory: ctx.directory }, signal: abort.signal });
    if (created.error || !created.data) return null;
    classifierSessionID = created.data.id;
    ctx.classifierSessions.add(classifierSessionID);

    const prompted = await ctx.client.session.prompt({
      path: { id: classifierSessionID },
      body: { agent: CLASSIFIER_AGENT, model, parts: [{ type: "text", text: transcriptText }] },
      query: { directory: ctx.directory },
      signal: abort.signal,
    });
    if (prompted.error || !prompted.data) return null;

    const text = prompted.data.parts
      .filter(isTextPart)
      .map((p) => p.text)
      .join("");
    const verdict = parseVerdict(text);
    return verdict.decision ? verdict : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (classifierSessionID) {
      ctx.classifierSessions.delete(classifierSessionID);
      if (timedOut) {
        try {
          await ctx.client.session.abort({ path: { id: classifierSessionID }, query: { directory: ctx.directory } });
        } catch {
          // best-effort: the delete below still removes it
        }
      }
      try {
        await ctx.client.session.delete({ path: { id: classifierSessionID }, query: { directory: ctx.directory } });
      } catch {
        // best-effort cleanup
      }
    }
  }
}
