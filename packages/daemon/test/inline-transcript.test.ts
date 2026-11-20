// Contract: the steps the daemon writes for an inline run are read back by the SDK as a subagent run of the `inline_task` call, so a restore
// shows them under the call (docs/spec.md "Inline tasks" › Restart). Depends on the SDK's subagent file format (meta.json `toolUseId`).
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSubagentMessages, listSubagents, type SDKMessage, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAdapter, type Part } from "@claude-ui/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { interleaveRuns } from "../src/transcript.ts";
import { openInlineTranscript } from "../src/inline-transcript.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";
const CALL = "toolu_01INLINECALL";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.CLAUDE_CONFIG_DIR;
});

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const msg = (type: "user" | "assistant", uuid: string, message: Record<string, unknown>) => ({ type, uuid, session_id: SESSION, parent_tool_use_id: null, message }) as unknown as SDKMessage;
const RUN: SDKMessage[] = [
  msg("assistant", "a1", { id: "msg_1", role: "assistant", content: [{ type: "tool_use", id: "toolu_G", name: "Grep", input: { pattern: "foo" } }] }),
  msg("user", "u1", { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_G", content: "src/a.ts:1:foo" }] }),
  msg("assistant", "a2", { id: "msg_2", role: "assistant", content: [{ type: "text", text: "Found it in src/a.ts." }] }),
];

describe("inline run transcript", () => {
  it("is read back by the SDK as the subagent run of the inline_task call, with the same part ids as the live run", async () => {
    const config = realpathSync(mkdtempSync(join(tmpdir(), "inline-transcript-")));
    dirs.push(config);
    process.env.CLAUDE_CONFIG_DIR = config;
    const cwd = join(config, "proj");
    mkdirSync(cwd);
    const project = join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(join(project, SESSION), { recursive: true });
    const main = [
      { parentUuid: null, isSidechain: false, type: "user", uuid: "m1", timestamp: "2026-11-20T10:00:00.000Z", sessionId: SESSION, cwd, message: { role: "user", content: "Find foo" } },
      { parentUuid: "m1", isSidechain: false, type: "assistant", uuid: "m2", timestamp: "2026-11-20T10:00:01.000Z", sessionId: SESSION, cwd, message: { id: "msg_main", role: "assistant", content: [{ type: "tool_use", id: CALL, name: "mcp__claude-ui__inline_task", input: { prompt: "Find foo" } }] } },
      { parentUuid: "m2", isSidechain: false, type: "user", uuid: "m3", timestamp: "2026-11-20T10:00:09.000Z", sessionId: SESSION, cwd, message: { role: "user", content: [{ type: "tool_result", tool_use_id: CALL, content: '{"status":"done"}' }] } },
    ];
    writeFileSync(join(project, `${SESSION}.jsonl`), main.map(line).join(""));

    const w = openInlineTranscript({ dir: join(project, SESSION, "subagents"), sessionId: SESSION, cwd, toolUseId: CALL, description: "Find foo" })!;
    // A user prompt and a nested step are not steps of the run.
    w.append(msg("user", "p", { role: "user", content: "Find foo" }));
    for (const m of RUN) w.append(m);
    await w.done();
    expect(readdirSync(join(project, SESSION, "subagents")).sort()).toEqual([`agent-inline-${CALL}.jsonl`, `agent-inline-${CALL}.meta.json`]);

    expect(await listSubagents(SESSION, { dir: cwd })).toEqual([`inline-${CALL}`]);
    const run = await getSubagentMessages(SESSION, `inline-${CALL}`, { dir: cwd });
    expect(run.map((m) => [m.type, m.uuid, m.parent_tool_use_id])).toEqual(RUN.map((m) => [m.type, (m as { uuid: string }).uuid, CALL]));

    const restored = createAdapter();
    const mainMessages = main.map((e) => ({ type: e.type, uuid: e.uuid, session_id: SESSION, parent_tool_use_id: null, message: e.message, timestamp: e.timestamp })) as unknown as SessionMessage[];
    const parts = interleaveRuns(mainMessages, [run]).flatMap((m) => restored.convert(m as unknown as SDKMessage));
    const live = createAdapter();
    const livePartIds = RUN.flatMap((m) => live.convert(m)).map((p) => p.id);
    const children = parts.filter((p): p is Part => (p as { parentId?: string }).parentId === CALL);
    expect(children.map((p) => p.id)).toEqual(livePartIds);
    expect([...new Set(children.map((p) => p.type))].sort()).toEqual(["assistant_text", "tool_call", "tool_result"]);
    expect(parts.some((p) => p.type === "subagent")).toBe(false);
  });

  it("refuses a call id that is not safe in a file name", () => {
    expect(openInlineTranscript({ dir: "/x", sessionId: SESSION, cwd: "/x", toolUseId: "../evil", description: "" })).toBeUndefined();
  });
});
