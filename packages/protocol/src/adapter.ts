// Adapter: converts raw SDK messages into parts (CONTEXT.md "Adapter").
// One adapter instance per session; it holds the accumulated text of streaming blocks and the known tool calls.
import type { SDKMessage, SlashCommand as SDKSlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { Part, TodoItem, ToolStatus } from "./parts.ts";

type Call = Extract<Part, { type: "tool_call" | "subagent" }>;

// Tools that run a subagent; they become `subagent` parts instead of tool cards.
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/** `startedAt`: a subagent run's start (ms), kept from an earlier part of the same call. */
function callPart(id: string, tool: string, input: unknown, status: ToolStatus, startedAt: number): Call {
  if (!SUBAGENT_TOOLS.has(tool)) return { type: "tool_call", id, toolUseId: id, tool, input, status };
  const description = (input as { description?: unknown }).description;
  return { type: "subagent", id, toolUseId: id, description: typeof description === "string" ? description : "", status, startedAt };
}

const ENDED = new Set<ToolStatus>(["done", "error", "denied"]);

// Known SDK messages the UI does not show. Anything else unhandled becomes a `raw` part.
const IGNORED = new Set([
  "rate_limit_event",
  "command_lifecycle",
  "system:status",
  "system:thinking_tokens",
  "system:task_progress",
  "system:task_updated",
  "system:background_tasks_changed",
  "system:hook_started",
  "system:hook_progress",
  "system:hook_response",
  "tool_progress",
]);
// After an interrupt the CLI sends this user text, then a result with an aborted terminal_reason (SDK 0.3.285).
const INTERRUPTED = /^\[Request interrupted by user( for tool use)?\]$/;
// CLI text that is no prompt (SDK 0.3.285): a local command's output (live an assistant message; the setModel() echo is
// shown by the session_model part).
// ponytail: output of a command run in the terminal CLI is dropped too; show it if terminal sessions need it.
const CLI_OUTPUT = /^<(local-command-stdout|local-command-stderr)>.*<\/\1>$/s;
// CLI text sent to the model, not typed by the user: flagged isSynthetic (live) or isMeta (transcript); the nudge after
// an empty response also matched by text, as its live flags are unverified (SDK 0.3.285).
const NUDGE = /^\[Your previous response had no visible output\./;
// A background subagent's placeholder tool_result names its agentId, which is the task ID of its notifications (SDK 0.3.285).
const ASYNC_LAUNCHED = /^Async agent launched successfully\.[\s\S]*?^agentId: (\w+)/m;
// A transcript records a background task's notification as this user text; a notice after the run resumed has no tool-use-id.
const NOTIFICATION_TAG = /<(task-id|tool-use-id|status)>(.*?)<\/\1>/g;
// A transcript records a slash command as these tags; live the prompt's own user_text shows it.
const COMMAND_TAG = /<(command-name|command-message|command-args)>(.*?)<\/\1>/gs;

/** The prompt `/name args` of a slash command record; undefined for other text. */
function commandPrompt(text: string): string | undefined {
  if (text.replace(COMMAND_TAG, "").trim()) return undefined;
  const tags = new Map([...text.matchAll(COMMAND_TAG)].map((t) => [t[1], t[2]!.trim()]));
  const name = tags.get("command-name");
  return name ? [name, tags.get("command-args")].filter(Boolean).join(" ") : undefined;
}

/** A user message's string content as parts; the /model record is dropped like its echo. */
function userString(id: string, content: string): Part[] {
  if (CLI_OUTPUT.test(content) || NUDGE.test(content)) return [];
  const command = commandPrompt(content);
  if (command?.split(" ")[0] === "/model") return [];
  return [{ type: "user_text", id, text: command ?? content, images: [] }];
}
const ABORTED = new Set(["aborted_streaming", "aborted_tools"]);

// Text/thinking part id = `<API message id>:<content block index>`. Streamed blocks know their index from the
// stream event. Complete assistant messages arrive split, one SDK message per content block with the
// same API message id (see test/fixtures), so their index is the count of blocks seen for that id.
// `resumed`: the session's query resumes a transcript, whose saved total the first result already includes.
export function createAdapter(opts: { resumed?: boolean } = {}) {
  let streamingMessageId = "";
  const streamedText = new Map<string, string>();
  const blocksSeen = new Map<string, number>();
  const calls = new Map<string, Call>();
  const denied = new Set<string>();
  // Subagents running in the background: their tool_result is a placeholder, task_notification ends them.
  const background = new Set<string>();
  // Background task ID -> its tool_use_id, for a notification that names only the task.
  const tasks = new Map<string, string>();
  // Paths whose original file was already sent: the changes tab needs only the first one.
  const originals = new Set<string>();
  // total_cost_usd is cumulative per query; a turn's cost is the difference to the previous result. Undefined = unknown.
  // ponytail: the first turn after a daemon restart shows no cost; the CLI saves the resumed total only in the transcript's cost-state.
  let costTotal: number | undefined = opts.resumed ? undefined : 0;
  // Live compact_boundary waiting for its summary, the synthetic user message that follows it (SDK 0.3.285).
  let compacting: Extract<Part, { type: "compaction" }> | undefined;

  // Time of the message being converted: its transcript timestamp, else now (live messages carry none).
  let now = 0;
  const startOf = (id: string) => {
    const call = calls.get(id);
    return call?.type === "subagent" ? call.startedAt : now;
  };

  /** `again`: a later end of a run that resumed moves its endedAt, even with the same status. */
  function setStatus(toolUseId: string, status: ToolStatus, again = false): Part[] {
    const call = calls.get(toolUseId);
    if (!call || (call.status === status && !(again && call.type === "subagent"))) return [];
    const next = call.type === "subagent" && ENDED.has(status) ? { ...call, status, endedAt: now } : { ...call, status };
    calls.set(toolUseId, next);
    return [next];
  }

  /** A background task's notification (live or from a transcript) ends its call. */
  function taskEnded(taskId: string | undefined, toolUseId: string | undefined, status: string | undefined): Part[] {
    const id = toolUseId ?? (taskId ? tasks.get(taskId) : undefined);
    return id ? setStatus(id, status === "completed" ? "done" : "error", true) : [];
  }

  function deny(toolUseId: string): Part[] {
    denied.add(toolUseId);
    return setStatus(toolUseId, "denied");
  }

  let knownCommands: SDKSlashCommand[] | undefined;
  // Terminal-only names arrive only with system/init, i.e. after the first prompt; until then use the
  // set seen from SDK 0.3.285. ponytail: hardcoded fallback goes stale on SDK upgrades; cache the last
  // init set daemon-wide if that happens.
  let terminalOnly = new Set(["doctor", "color", "focus", "reload-plugins"]);

  /** The full command list (supportedCommands() or a commands_changed push), minus terminal-only commands. */
  function commands(list: SDKSlashCommand[]): Part[] {
    knownCommands = list;
    // Rows can share a name; /name runs the builtin one.
    const byName = new Map<string, SDKSlashCommand>();
    for (const c of list) if (!terminalOnly.has(c.name) && (!byName.has(c.name) || c.builtin)) byName.set(c.name, c);
    const commands = [...byName.values()].map(({ name, description, argumentHint, aliases }) =>
      aliases?.length ? { name, description, argumentHint, aliases } : { name, description, argumentHint },
    );
    return [{ type: "commands", id: "commands", commands }];
  }

  /** Parts from inside a subagent get `parentId` = the subagent's toolUseId. */
  function convert(m: SDKMessage): Part[] {
    const timestamp = (m as { timestamp?: unknown }).timestamp;
    now = (typeof timestamp === "string" && Date.parse(timestamp)) || Date.now();
    const parts = convertMessage(m);
    const parentId = "parent_tool_use_id" in m ? m.parent_tool_use_id : null;
    if (!parentId) return parts;
    return parts.map((p) => {
      const tagged = { ...p, parentId };
      if (calls.get(p.id) === p) calls.set(p.id, tagged as Call);
      return tagged;
    });
  }

  function convertMessage(m: SDKMessage): Part[] {
    switch (m.type) {
      case "stream_event": {
        const e = m.event;
        if (e.type === "message_start") streamingMessageId = e.message.id;
        if (e.type === "content_block_start" && e.content_block.type === "tool_use") {
          const { id, name } = e.content_block;
          const call = callPart(id, name, {}, "pending", startOf(id));
          calls.set(id, call);
          return [call];
        }
        if (e.type !== "content_block_delta") return [];
        const id = `${streamingMessageId}:${e.index}`;
        if (e.delta.type === "text_delta") {
          const text = (streamedText.get(id) ?? "") + e.delta.text;
          streamedText.set(id, text);
          return [{ type: "assistant_text", id, text, streaming: true }];
        }
        if (e.delta.type === "thinking_delta") {
          const text = (streamedText.get(id) ?? "") + e.delta.thinking;
          streamedText.set(id, text);
          // With thinking display "omitted" the deltas are empty; nothing to show.
          return text ? [{ type: "thinking", id, text, streaming: true }] : [];
        }
        return [];
      }
      case "assistant": {
        const msgId = m.message.id;
        return m.message.content.flatMap((block): Part[] => {
          const index = blocksSeen.get(msgId) ?? 0;
          blocksSeen.set(msgId, index + 1);
          const id = `${msgId}:${index}`;
          if (block.type === "text") {
            streamedText.delete(id);
            return [{ type: "assistant_text", id, text: block.text, streaming: false }];
          }
          if (block.type === "thinking") {
            streamedText.delete(id);
            return block.thinking ? [{ type: "thinking", id, text: block.thinking, streaming: false }] : [];
          }
          if (block.type === "redacted_thinking") return [];
          if (block.type === "tool_use") {
            const call = callPart(block.id, block.name, block.input, denied.has(block.id) ? "denied" : "running", startOf(block.id));
            calls.set(block.id, call);
            const todos = (block.input as { todos?: TodoItem[] }).todos;
            if (block.name !== "TodoWrite" || m.parent_tool_use_id || !Array.isArray(todos)) return [call];
            return [call, { type: "todo_update", id: `${block.id}:todos`, items: todos }];
          }
          return [{ type: "raw", id, message: block }];
        });
      }
      case "user": {
        const content = m.message.content;
        const id = m.uuid ?? crypto.randomUUID();
        const synthetic = m.isSynthetic === true || (m as { isMeta?: boolean }).isMeta === true;
        const boundary = compacting;
        compacting = undefined;
        if (typeof content === "string") {
          // Transcript: isCompactSummary; live: the synthetic message right after the boundary.
          if ((m as { isCompactSummary?: boolean }).isCompactSummary) return [{ type: "compaction", id, summary: content }];
          if (synthetic && boundary) return [{ ...boundary, summary: content }];
          if (content.startsWith("<task-notification>")) {
            const tags = new Map([...content.matchAll(NOTIFICATION_TAG)].map((t) => [t[1], t[2]]));
            return taskEnded(tags.get("task-id"), tags.get("tool-use-id"), tags.get("status"));
          }
          return synthetic ? [] : userString(id, content);
        }
        const parts: Part[] = [];
        const rest = content.filter((b) => {
          if (b.type !== "tool_result") return true;
          const isError = b.is_error ?? false;
          const output =
            Array.isArray(b.content) && b.content.every((c) => c.type === "text")
              ? b.content.map((c) => c.text).join("\n")
              : b.content;
          const result: Part = { type: "tool_result", id: `${b.tool_use_id}:result`, toolUseId: b.tool_use_id, output, isError };
          const call = calls.get(b.tool_use_id);
          const path = call?.type === "tool_call" ? (call.input as { file_path?: unknown }).file_path : undefined;
          const original = (m.tool_use_result as { originalFile?: unknown } | undefined)?.originalFile;
          if (typeof path === "string" && (typeof original === "string" || original === null) && !originals.has(path)) {
            originals.add(path);
            result.original = original;
          }
          parts.push(result);
          const launched = typeof output === "string" ? ASYNC_LAUNCHED.exec(output) : null;
          if (launched) {
            background.add(b.tool_use_id);
            tasks.set(launched[1]!, b.tool_use_id);
          }
          if (!background.has(b.tool_use_id))
            parts.push(...setStatus(b.tool_use_id, denied.has(b.tool_use_id) ? "denied" : isError ? "error" : "done"));
          return false;
        });
        if (rest.length === 0 || synthetic) return parts;
        if (rest.length === 1 && rest[0]!.type === "text" && INTERRUPTED.test(rest[0]!.text)) return [...parts, { type: "turn_interrupted", id }];
        if (rest.every((b) => b.type === "text" || (b.type === "image" && b.source.type === "base64"))) {
          const text = rest.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
          const images = rest.flatMap((b) =>
            b.type === "image" && b.source.type === "base64" ? [`data:${b.source.media_type};base64,${b.source.data}`] : [],
          );
          return [...parts, { type: "user_text", id, text, images }];
        }
        return [...parts, { type: "raw", id, message: m }];
      }
      case "result": {
        const total = m.total_cost_usd;
        // A lower total: the CLI started over (a resume without a saved total, /clear).
        const costUsd = costTotal === undefined ? undefined : total >= costTotal ? total - costTotal : total;
        costTotal = total;
        const u = m.usage;
        // The CLI's own turn after a background task notification ends with a result of no tokens: no footer for it.
        const empty = !m.is_error && costUsd === 0 && !u.input_tokens && !u.output_tokens && !u.cache_read_input_tokens && !u.cache_creation_input_tokens;
        return [
          ...(m.permission_denials ?? []).flatMap((d) => deny(d.tool_use_id)),
          // An aborted turn has its turn_interrupted instead.
          ...(ABORTED.has(m.terminal_reason ?? "") || empty ? [] : [{
            type: "turn_result",
            id: m.uuid,
            durationMs: m.duration_ms,
            costUsd,
            usage: {
              inputTokens: m.usage.input_tokens,
              outputTokens: m.usage.output_tokens,
              cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
              cacheCreationTokens: m.usage.cache_creation_input_tokens ?? 0,
            },
            isError: m.is_error,
          } satisfies Part]),
        ];
      }
      default:
        if (m.type === "system" && m.subtype === "commands_changed") return commands(m.commands);
        if (m.type === "system" && m.subtype === "init") {
          terminalOnly = new Set(m.terminal_slash_commands);
          return knownCommands ? commands(knownCommands) : [];
        }
        if (m.type === "system" && m.subtype === "permission_denied") return deny(m.tool_use_id);
        if (m.type === "system" && m.subtype === "compact_boundary") {
          compacting = { type: "compaction", id: m.uuid, trigger: m.compact_metadata.trigger };
          return [compacting];
        }
        if (m.type === "system" && m.subtype === "task_started") {
          if (m.is_backgrounded && m.tool_use_id) background.add(m.tool_use_id);
          if (m.tool_use_id) tasks.set(m.task_id, m.tool_use_id);
          return [];
        }
        if (m.type === "system" && m.subtype === "task_notification") return taskEnded(m.task_id, m.tool_use_id, m.status);
        if (IGNORED.has(m.type) || IGNORED.has(`${m.type}:${"subtype" in m ? m.subtype : ""}`)) return [];
        return [{ type: "raw", id: ("uuid" in m && m.uuid) || crypto.randomUUID(), message: m }];
    }
  }

  /** The user edited the call's input before accepting it (permission panel); later updates keep the applied input. */
  function edit(toolUseId: string, input: unknown): Part[] {
    const call = calls.get(toolUseId);
    if (call?.type !== "tool_call") return [];
    const next = { ...call, input, editedByUser: true };
    calls.set(toolUseId, next);
    return [next];
  }

  /** deny: marks a tool call denied now; its later tool_result keeps status denied. */
  return { convert, commands, deny, edit };
}
