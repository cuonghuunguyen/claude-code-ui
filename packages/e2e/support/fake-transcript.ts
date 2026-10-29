// A synthetic Claude Code transcript of one session that published an Artifact (GH-400 e2e): the real publish would go to claude.ai.
// Writes only below a config dir inside the run folder (projectsDirOf throws otherwise).
// Minimal record shape the SDK's getSessionMessages() and listSessions() restore (verified by test/fake-transcript.test.ts):
// one JSON object per line, type user|assistant, uuid chained by parentUuid, sessionId, cwd, timestamp, message in the API shape
// (assistant: a tool_use block, user: the matching tool_result block).
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute, resolve } from "node:path";

/** `<configDir>/projects` of a Claude config dir that lies inside the run folder; anything else (the owner's real ~/.claude included) throws: a fixture must never write there. */
export function projectsDirOf(configDir: string | undefined, run: string): string {
  const rel = configDir ? relative(resolve(run), resolve(configDir)) : "";
  if (!configDir || rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`refusing to write a transcript: CLAUDE_CONFIG_DIR (${configDir ?? "unset"}) is not inside the run folder ${run}`);
  return join(configDir, "projects");
}

/** The project folder name of a cwd: every non-alphanumeric character becomes "-" (the Claude CLI's rule). */
export const slugOf = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

export type FakePublish = { sessionId: string; cwd: string; file: string; title: string; url: string; /** The daemon's CLAUDE_CONFIG_DIR, inside `run`. */ configDir: string; run: string };

/** Writes the transcript; returns its path. Remove it with rmSync when the scenario ends. */
export function writePublishTranscript(p: FakePublish): string {
  const cwd = realpathSync(p.cwd);
  const dir = join(projectsDirOf(p.configDir, p.run), slugOf(cwd));
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

export type FakeTurnPublish = { file: string; title?: string; url: string };
export type FakeTurns = { sessionId: string; cwd: string; configDir: string; run: string; /** Number of prompt/reply turns. */ turns: number; /** Turn number (from 1) -> the Artifact publish that turn makes; the other turns end in a text reply. */ publishes: Record<number, FakeTurnPublish> };

/** Writes a session of `turns` turns, one hour apart, ending an hour before now; the turns in `publishes` call Artifact (GH-176 e2e). Returns its path. */
export function writeTurnsTranscript(p: FakeTurns): string {
  const cwd = realpathSync(p.cwd);
  const dir = join(projectsDirOf(p.configDir, p.run), slugOf(cwd));
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now() - (p.turns + 1) * 3_600_000;
  const at = (turn: number, step: number) => new Date(t0 + turn * 3_600_000 + step * 1000).toISOString();
  const base = { isSidechain: false, userType: "external", cwd, sessionId: p.sessionId, version: "2.0.0" };
  const id = (turn: number, step: number) => `${String(turn).padStart(4, "0")}${String(step)}000-0000-4000-8000-000000000000`;
  const rows: object[] = [];
  let parent: string | null = null;
  const add = (turn: number, step: number, type: "user" | "assistant", message: object) => {
    const uuid = id(turn, step);
    rows.push({ ...base, parentUuid: parent, type, uuid, timestamp: at(turn, step), message });
    parent = uuid;
  };
  for (let n = 1; n <= p.turns; n++) {
    add(n, 0, "user", { role: "user", content: `Turn ${n}` });
    const pub = p.publishes[n];
    const head = { id: `msg_fake_${n}`, type: "message", role: "assistant", model: "claude-haiku-4-5" };
    if (!pub) {
      add(n, 1, "assistant", { ...head, content: [{ type: "text", text: `Reply ${n}` }], stop_reason: "end_turn" });
      continue;
    }
    const call = `toolu_fake_${n}`;
    add(n, 1, "assistant", { ...head, content: [{ type: "tool_use", id: call, name: "Artifact", input: { file_path: pub.file, ...(pub.title && { title: pub.title }) } }], stop_reason: "tool_use" });
    add(n, 2, "user", { role: "user", content: [{ type: "tool_result", tool_use_id: call, content: `Published ${pub.file} at ${pub.url} (Version 1)` }] });
    add(n, 3, "assistant", { ...head, id: `msg_fake_${n}b`, content: [{ type: "text", text: `Done ${n}` }], stop_reason: "end_turn" });
  }
  const file = join(dir, `${p.sessionId}.jsonl`);
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}
