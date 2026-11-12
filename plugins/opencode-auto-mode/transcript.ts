// Encodes a session transcript and the action under decision into JSONL the classifier reads
// as data. One JSON.stringify'd record per line: embedded newlines are escaped, so tool output
// or file content inside a record can never forge a second record. Never includes assistant
// text or tool outputs — only user text and the *inputs* of assistant tool calls.
import type { MessagePart, TranscriptMessage } from "./types.ts";
import { compactKV, str, truncate } from "./text.ts";

export const DEFAULT_TRANSCRIPT_CHARS = 60_000;
export const DEFAULT_RECORD_CHARS = 2_000;

/** Per-tool projection of a tool call's input into one cheap, non-sensitive line. */
export function projectToolInput(tool: string, input: Record<string, unknown> | undefined, maxChars = DEFAULT_RECORD_CHARS): string {
  const i = input ?? {};
  switch (tool) {
    case "bash":
    case "shell":
      return truncate(str(i.command), maxChars);
    case "edit":
      return truncate(`${str(i.filePath)}: ${str(i.newString)}`, maxChars);
    case "write":
      return truncate(`${str(i.filePath)}: ${str(i.content)}`, maxChars);
    case "patch":
    case "apply_patch":
      return truncate(str(i.patchText ?? i.patch), maxChars);
    case "webfetch":
      return truncate(str(i.url), maxChars);
    case "websearch":
    case "codesearch":
      return truncate(str(i.query), maxChars);
    case "task":
      return truncate(`(${str(i.subagent_type)}): ${str(i.prompt)}`, maxChars);
    case "read":
      return truncate(str(i.filePath), maxChars);
    case "grep":
    case "glob":
    case "list":
      return truncate([str(i.path), str(i.pattern)].filter(Boolean).join(" "), maxChars);
    case "todowrite":
      return `${Array.isArray(i.todos) ? i.todos.length : 0} items`;
    default:
      return compactKV(i, maxChars);
  }
}

function isTextPart(part: MessagePart): part is { type: "text"; text: string; synthetic?: boolean; ignored?: boolean } {
  return part.type === "text" && typeof (part as { text?: unknown }).text === "string";
}

function isToolPart(part: MessagePart): part is { type: "tool"; callID: string; tool: string; state?: { status: string; input?: Record<string, unknown> } } {
  return part.type === "tool" && typeof (part as { tool?: unknown }).tool === "string";
}

export interface TranscriptOptions {
  transcriptChars?: number;
  maxRecordChars?: number;
}

/** User text and assistant tool-call inputs, oldest to newest, one JSON object per line. */
export function encodeMessages(messages: TranscriptMessage[], opts: TranscriptOptions = {}): string[] {
  const recordChars = opts.maxRecordChars ?? DEFAULT_RECORD_CHARS;
  const records: string[] = [];
  for (const m of messages) {
    for (const part of m.parts) {
      if (m.info.role === "user" && isTextPart(part)) {
        if (part.synthetic || part.ignored) continue;
        records.push(JSON.stringify({ user: truncate(part.text, recordChars) }));
      } else if (m.info.role === "assistant" && isToolPart(part)) {
        const projection = projectToolInput(part.tool, part.state?.input, recordChars);
        records.push(JSON.stringify({ [part.tool]: projection }));
      }
    }
  }
  return records;
}

/** `encodeMessages` records, kept within `transcriptChars`: always the first user message, then the most recent records that fit. */
export function truncateRecords(records: string[], opts: TranscriptOptions = {}): string[] {
  if (records.length === 0) return [];
  const budget = opts.transcriptChars ?? DEFAULT_TRANSCRIPT_CHARS;
  const [first, ...rest] = records;
  const kept: string[] = [];
  let total = first.length;
  for (let idx = rest.length - 1; idx >= 0; idx--) {
    const line = rest[idx];
    if (total + line.length + 1 > budget) break;
    kept.unshift(line);
    total += line.length + 1;
  }
  return [first, ...kept];
}

/** The transcript as JSONL text (possibly empty when there are no eligible messages). */
export function encodeTranscript(messages: TranscriptMessage[], opts: TranscriptOptions = {}): string {
  return truncateRecords(encodeMessages(messages, opts), opts).join("\n");
}

export interface CachedToolCall {
  tool: string;
  input: Record<string, unknown>;
}

/** The final `{"action": …}` record, built from the real tool input when known, else from permission metadata. */
export function buildActionRecord(
  permission: string,
  patterns: string[],
  metadata: Record<string, unknown>,
  cached?: CachedToolCall,
  maxChars = DEFAULT_RECORD_CHARS,
): string {
  const input = cached ? projectToolInput(cached.tool, cached.input, maxChars) : projectFromMetadata(permission, metadata, maxChars);
  return JSON.stringify({ action: { permission, patterns, input } });
}

function projectFromMetadata(permission: string, metadata: Record<string, unknown>, maxChars: number): string {
  switch (permission) {
    case "bash":
      return truncate(str(metadata.command), maxChars);
    case "edit": {
      const diff = str(metadata.diff);
      const added = diff
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .join("\n");
      return truncate(`${str(metadata.filepath)}: ${added}`, maxChars);
    }
    case "webfetch":
      return truncate(str(metadata.url), maxChars);
    case "external_directory":
      if (metadata.filepath) return truncate(`${str(metadata.filepath)} (outside ${str(metadata.parentDir)})`, maxChars);
      return compactKV(metadata, maxChars);
    case "doom_loop":
      return truncate(`${str(metadata.tool)}: ${compactKV(metadata.input as Record<string, unknown> | undefined, maxChars)}`, maxChars);
    default:
      return compactKV(metadata, maxChars);
  }
}
