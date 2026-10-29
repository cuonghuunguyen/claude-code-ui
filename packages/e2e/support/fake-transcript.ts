// A synthetic Claude Code transcript of one session that published an Artifact (GH-400 e2e): the real publish would go to claude.ai.
// Minimal record shape the SDK's getSessionMessages() and listSessions() restore (verified by test/fake-transcript.test.ts):
// one JSON object per line, type user|assistant, uuid chained by parentUuid, sessionId, cwd, timestamp, message in the API shape
// (assistant: a tool_use block, user: the matching tool_result block).
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `<CLAUDE_CONFIG_DIR or ~/.claude>/projects`, where the daemon's Claude CLI keeps transcripts. */
export const projectsDirOf = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string => join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");

/** The project folder name of a cwd: every non-alphanumeric character becomes "-" (the Claude CLI's rule). */
export const slugOf = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

export type FakePublish = { sessionId: string; cwd: string; file: string; title: string; url: string; root?: string };

/** Writes the transcript; returns its path. Remove it with rmSync when the scenario ends. */
export function writePublishTranscript(p: FakePublish): string {
  const cwd = realpathSync(p.cwd);
  const dir = join(p.root ?? projectsDirOf(), slugOf(cwd));
  mkdirSync(dir, { recursive: true });
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const base = { isSidechain: false, userType: "external", cwd, sessionId: p.sessionId, version: "2.0.0" };
  const ids = ["a", "b", "c"].map((k, i) => `${k.repeat(8)}-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const call = "toolu_fake_publish";
  const rows = [
    { ...base, parentUuid: null, type: "user", uuid: ids[0], timestamp: at(0), message: { role: "user", content: "Publish the dashboard" } },
    { ...base, parentUuid: ids[0], type: "assistant", uuid: ids[1], timestamp: at(1), message: { id: "msg_fake_publish", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "tool_use", id: call, name: "Artifact", input: { file_path: p.file, title: p.title } }], stop_reason: "tool_use" } },
    { ...base, parentUuid: ids[1], type: "user", uuid: ids[2], timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: call, content: `Published ${p.file} at ${p.url} (Version 1)` }] } },
  ];
  const file = join(dir, `${p.sessionId}.jsonl`);
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}
