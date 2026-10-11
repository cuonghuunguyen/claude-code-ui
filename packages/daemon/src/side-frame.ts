// What a side may write to its stdout (GH-278). A side is another process: every line is untrusted input of the hub.
// Anything that is not one of the frames below is dropped and logged; a new frame type is one more entry in FRAME.
import { z } from "zod";
import type { PushPayload, ServerMessage } from "@claude-ui/protocol";

/**
 * Longest side -> hub line (characters). The hub accepts WebSocket frames up to 64 MiB (server.ts MAX_FRAME_BYTES: a prompt with
 * images), a side echoes that prompt back as one `user_text` event, and git output of a side may reach 86 MiB of base64 (GH-275):
 * 128 MiB covers the largest of them. Only a line above it is hostile or broken.
 */
export const MAX_SIDE_LINE_CHARS = 128 * 1024 * 1024;

const message = z.record(z.string(), z.unknown());
const push = z.object({ sessionId: z.string(), title: z.string(), body: z.string(), tag: z.string().optional(), silent: z.boolean().optional(), replace: z.boolean().optional() });

/**
 * Closed set: a key not named here (a frame of a newer side) is not accepted, because every frame type needs a handler in the
 * hub anyway. Object schemas strip unknown keys (not `passthrough`): a frame carries only what the hub reads.
 */
const FRAME = z.union([z.object({ ready: z.literal(true) }).transform(() => ({ kind: "ready" as const })), z.object({ push }).transform((f) => ({ kind: "push" as const, push: f.push as PushPayload })), z.object({ c: z.number().int().nonnegative(), m: message }).transform((f) => ({ kind: "message" as const, c: f.c, m: f.m as unknown as ServerMessage }))]);

export type SideFrame = z.infer<typeof FRAME>;

/** Cut at `n` and JSON-quoted (control characters escaped, no terminal escape reaches the log): a frame may hold prompts, so a log line never carries more than a short prefix. */
export const logPrefix = (s: string, n = 32) => JSON.stringify(s.slice(0, n)) + (s.length > n ? "…" : "");

/** Parses one stdout line: the frame, or why it is none. */
export function parseSideFrame(line: string): { frame: SideFrame } | { error: "not JSON" | "unknown frame" } {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { error: "not JSON" }; // also JSON nested too deep to parse
  }
  const r = FRAME.safeParse(json);
  return r.success ? { frame: r.data } : { error: "unknown frame" };
}
