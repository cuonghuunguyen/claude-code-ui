// Adapter: converts raw SDK messages into parts (CONTEXT.md "Adapter").
// One adapter instance per session; it holds the accumulated text of streaming blocks.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Part } from "./parts.ts";

// Text part id = `<API message id>:<content block index>`. Streamed blocks know their index from the
// stream event. Complete assistant messages arrive split, one SDK message per content block with the
// same API message id (see test/fixtures), so their index is the count of blocks seen for that id.
export function createAdapter() {
  let streamingMessageId = "";
  const streamedText = new Map<string, string>();
  const blocksSeen = new Map<string, number>();

  function convert(m: SDKMessage): Part[] {
    switch (m.type) {
      case "stream_event": {
        const e = m.event;
        if (e.type === "message_start") streamingMessageId = e.message.id;
        if (e.type !== "content_block_delta" || e.delta.type !== "text_delta") return [];
        const id = `${streamingMessageId}:${e.index}`;
        const text = (streamedText.get(id) ?? "") + e.delta.text;
        streamedText.set(id, text);
        return [{ type: "assistant_text", id, text, streaming: true }];
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
          if (block.type === "thinking" || block.type === "redacted_thinking") return [];
          return [{ type: "raw", id, message: block }];
        });
      }
      case "user": {
        const content = m.message.content;
        const id = m.uuid ?? crypto.randomUUID();
        if (typeof content === "string") return [{ type: "user_text", id, text: content, images: [] }];
        if (content.every((b) => b.type === "text"))
          return [{ type: "user_text", id, text: content.map((b) => b.text).join("\n"), images: [] }];
        return [{ type: "raw", id, message: m }];
      }
      case "result":
        return [
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
        // ponytail: system/status/rate-limit messages are dropped; later issues add parts for the ones the UI needs.
        return [];
    }
  }

  return { convert };
}
