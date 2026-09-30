// Adapter: converts raw SDK messages into parts (CONTEXT.md "Adapter").
// One adapter instance per session; it holds the accumulated text of streaming blocks and the known tool calls.
import type { SDKMessage, SlashCommand as SDKSlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { Part, ToolStatus } from "./parts.ts";

type ToolCall = Extract<Part, { type: "tool_call" }>;

// Known SDK messages the UI does not show. Anything else unhandled becomes a `raw` part.
const IGNORED = new Set(["rate_limit_event", "command_lifecycle", "system:status", "system:thinking_tokens"]);

// Text/thinking part id = `<API message id>:<content block index>`. Streamed blocks know their index from the
// stream event. Complete assistant messages arrive split, one SDK message per content block with the
// same API message id (see test/fixtures), so their index is the count of blocks seen for that id.
export function createAdapter() {
  let streamingMessageId = "";
  const streamedText = new Map<string, string>();
  const blocksSeen = new Map<string, number>();
  const calls = new Map<string, ToolCall>();
  const denied = new Set<string>();

  function setStatus(toolUseId: string, status: ToolStatus): Part[] {
    const call = calls.get(toolUseId);
    if (!call || call.status === status) return [];
    const next = { ...call, status };
    calls.set(toolUseId, next);
    return [next];
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

  function convert(m: SDKMessage): Part[] {
    switch (m.type) {
      case "stream_event": {
        const e = m.event;
        if (e.type === "message_start") streamingMessageId = e.message.id;
        if (e.type === "content_block_start" && e.content_block.type === "tool_use") {
          const { id, name } = e.content_block;
          const call: ToolCall = { type: "tool_call", id, toolUseId: id, tool: name, input: {}, status: "pending" };
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
            const call: ToolCall = {
              type: "tool_call",
              id: block.id,
              toolUseId: block.id,
              tool: block.name,
              input: block.input,
              status: denied.has(block.id) ? "denied" : "running",
            };
            calls.set(block.id, call);
            return [call];
          }
          return [{ type: "raw", id, message: block }];
        });
      }
      case "user": {
        const content = m.message.content;
        const id = m.uuid ?? crypto.randomUUID();
        if (typeof content === "string") return [{ type: "user_text", id, text: content, images: [] }];
        const parts: Part[] = [];
        const rest = content.filter((b) => {
          if (b.type !== "tool_result") return true;
          const isError = b.is_error ?? false;
          const output =
            Array.isArray(b.content) && b.content.every((c) => c.type === "text")
              ? b.content.map((c) => c.text).join("\n")
              : b.content;
          parts.push({ type: "tool_result", id: `${b.tool_use_id}:result`, toolUseId: b.tool_use_id, output, isError });
          parts.push(...setStatus(b.tool_use_id, denied.has(b.tool_use_id) ? "denied" : isError ? "error" : "done"));
          return false;
        });
        if (rest.length === 0) return parts;
        if (rest.every((b) => b.type === "text" || (b.type === "image" && b.source.type === "base64"))) {
          const text = rest.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
          const images = rest.flatMap((b) =>
            b.type === "image" && b.source.type === "base64" ? [`data:${b.source.media_type};base64,${b.source.data}`] : [],
          );
          return [...parts, { type: "user_text", id, text, images }];
        }
        return [...parts, { type: "raw", id, message: m }];
      }
      case "result":
        return [
          ...(m.permission_denials ?? []).flatMap((d) => deny(d.tool_use_id)),
          {
            type: "turn_result",
            id: m.uuid,
            durationMs: m.duration_ms,
            costUsd: m.total_cost_usd,
            usage: {
              inputTokens: m.usage.input_tokens,
              outputTokens: m.usage.output_tokens,
              cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
              cacheCreationTokens: m.usage.cache_creation_input_tokens ?? 0,
            },
            isError: m.is_error,
          },
        ];
      default:
        if (m.type === "system" && m.subtype === "commands_changed") return commands(m.commands);
        if (m.type === "system" && m.subtype === "init") {
          terminalOnly = new Set(m.terminal_slash_commands);
          return knownCommands ? commands(knownCommands) : [];
        }
        if (m.type === "system" && m.subtype === "permission_denied") return deny(m.tool_use_id);
        if (IGNORED.has(m.type) || IGNORED.has(`${m.type}:${"subtype" in m ? m.subtype : ""}`)) return [];
        return [{ type: "raw", id: ("uuid" in m && m.uuid) || crypto.randomUUID(), message: m }];
    }
  }

  return { convert, commands };
}
