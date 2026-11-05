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

/** The range `[min, max]` of side frame schemas this build speaks (ADR 0009: the contract between independently updated Hubs). Bump `max` when a frame is added, `min` when one is dropped. */
export type Schema = readonly [number, number];
// shortcut: CLAUDE_UI_TEST_SCHEMA="min,max" is a test hook (e2e: a Hub of an incompatible schema); no other use.
const testSchema = /^(\d+),(\d+)$/.exec(process.env.CLAUDE_UI_TEST_SCHEMA ?? "");
export const SIDE_SCHEMA: Schema = testSchema ? [Number(testSchema[1]), Number(testSchema[2])] : [1, 1];
export const schemaOverlap = (a: Schema, b: Schema) => a[0] <= b[1] && b[0] <= a[1];
const schema = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);

const message = z.record(z.string(), z.unknown());
const push = z.object({ sessionId: z.string(), title: z.string(), body: z.string(), tag: z.string().optional(), silent: z.boolean().optional(), replace: z.boolean().optional() });

/**
 * Closed set: a key not named here (a frame of a newer side) is not accepted, because every frame type needs a handler in the
 * hub anyway. Object schemas strip unknown keys (not `passthrough`): a frame carries only what the hub reads.
 */
// `signal` is nullish: the error of Node's execFile carries `signal: null`, and a frame the schema drops leaves the hub call waiting for its timeout.
const gitError = z.object({ message: z.string(), code: z.union([z.string(), z.number()]).optional(), killed: z.boolean().optional(), signal: z.string().nullish() });
const ready = z.object({ ready: z.literal(true), killTree: z.literal(true).optional(), hb: z.literal(true).optional(), build: z.string().max(200).optional(), schema: schema.optional(), version: z.string().max(100).optional(), startedBy: z.literal("attach").optional() }).transform((f) => ({ kind: "ready" as const, killTree: f.killTree === true, hb: f.hb === true, build: f.build, schema: f.schema, version: f.version, startedBy: f.startedBy }));
const FRAME = z.union([ready, z.object({ hb: z.literal(1) }).transform(() => ({ kind: "hb" as const })), z.object({ running: z.boolean() }).transform((f) => ({ kind: "running" as const, running: f.running })), z.object({ push }).transform((f) => ({ kind: "push" as const, push: f.push as PushPayload })), z.object({ c: z.number().int().nonnegative(), m: message }).transform((f) => ({ kind: "message" as const, c: f.c, m: f.m as unknown as ServerMessage })), z.object({ g: z.number().int().nonnegative(), out: z.string(), err: z.string(), error: gitError.optional() }).transform((f) => ({ kind: "git" as const, ...f }))]);

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
