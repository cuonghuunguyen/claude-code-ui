import { getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { projectsDirOf, slugOf, writePublishTranscript } from "../support/fake-transcript.ts";

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
});
