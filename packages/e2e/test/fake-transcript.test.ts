import { getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { projectsDirOf, slugOf, writePublishTranscript, writeTurnsTranscript } from "../support/fake-transcript.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "fake-transcript-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const base = { sessionId: "4b2c3d4e-5f60-4718-8a9b-0a1b2c3d4e5f", file: "/x/dash.html", title: "T", url: "https://claude.ai/artifact/AbC123" };

describe("fake publish transcript (GH-400 e2e fixture)", () => {
  it("getSessionMessages restores the user text, the Artifact tool_use with its input and the tool_result; listSessions finds the session", async () => {
    const cwd = join(tmp, "project with space");
    mkdirSync(cwd);
    const configDir = join(tmp, "config");
    const old = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      const file = join(cwd, "dash.html");
      writePublishTranscript({ ...base, cwd, file, title: "Sales dashboard", configDir, run: tmp });
      const msgs = await getSessionMessages(base.sessionId, { dir: cwd });
      expect(msgs.map((m) => m.type)).toEqual(["user", "assistant", "user"]);
      const use = (msgs[1]!.message as { content: { type: string; name: string; input: unknown }[] }).content[0]!;
      expect(use).toMatchObject({ type: "tool_use", name: "Artifact", input: { file_path: file, title: "Sales dashboard" } });
      const out = (msgs[2]!.message as { content: { type: string; content: string }[] }).content[0]!;
      expect(out.type).toBe("tool_result");
      expect(out.content).toContain(base.url);
      expect((await listSessions({ dir: cwd })).map((s) => s.sessionId)).toContain(base.sessionId);
    } finally {
      if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = old;
    }
  });
  it("refuses a config dir outside the run folder, the real ~/.claude, an unset dir and the run folder itself; writes nothing", () => {
    const real = join(homedir(), ".claude");
    for (const configDir of [real, join(tmp, "..", "elsewhere"), tmp, ""]) {
      expect(() => writePublishTranscript({ ...base, cwd: tmp, configDir, run: tmp })).toThrow(/refusing to write a transcript/);
    }
    expect(() => projectsDirOf(undefined, tmp)).toThrow(/unset/);
    expect(existsSync(join(tmp, "elsewhere"))).toBe(false);
  });
  it("the project folder name and the transcript root", () => {
    expect(slugOf("/a/b c_d")).toBe("-a-b-c-d");
    expect(projectsDirOf(join(tmp, "cfg"), tmp)).toBe(join(tmp, "cfg", "projects"));
  });
  it("GH-176 a turns transcript restores every turn and the publishes of the chosen turns, with timestamps", async () => {
    const cwd = join(tmp, "turns project");
    mkdirSync(cwd);
    const configDir = join(tmp, "config-turns");
    const old = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const sessionId = "5b2c3d4e-5f60-4718-8a9b-0a1b2c3d4e5f";
    try {
      writeTurnsTranscript({ sessionId, cwd, configDir, run: tmp, turns: 3, publishes: { 1: { file: "/x/a.html", url: base.url }, 3: { file: "/x/b.md", title: "B", url: base.url } } });
      const msgs = await getSessionMessages(sessionId, { dir: cwd });
      const prompts = msgs.filter((m) => m.type === "user" && typeof (m.message as { content: unknown }).content === "string");
      expect(prompts).toHaveLength(3);
      const uses = msgs.flatMap((m) => (m.message as { content: { type: string; name?: string; input?: unknown }[] }).content).filter((b) => b?.type === "tool_use");
      expect(uses.map((u) => u.input)).toEqual([{ file_path: "/x/a.html" }, { file_path: "/x/b.md", title: "B" }]);
    } finally {
      if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = old;
    }
  });
});
