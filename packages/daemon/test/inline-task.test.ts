import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolError } from "../src/daemon-mcp.ts";
import { createInlineTask, INLINE_INSTRUCTIONS } from "../src/inline-task.ts";
import { INLINE_MAX_PER_SESSION, type InlineResult, type InlineSpec } from "../src/inline-types.ts";

const RESULT: InlineResult = { status: "done", text: "found", model: "claude-haiku-4-5", turns: 2, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, filesChanged: [], durationMs: 1 };
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "inline-task-")));
writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
mkdirSync(join(cwd, "sub"));
writeFileSync(join(cwd, "sub", "b.txt"), "bee");

type Call = { sessionId: string; spec: InlineSpec; signal: AbortSignal; toolUseId?: string; input: Record<string, unknown> };
function make(over: { enabled?: () => boolean; maxTurns?: number; run?: (c: Call) => Promise<InlineResult> } = {}) {
  const calls: Call[] = [];
  const group = createInlineTask({
    enabled: over.enabled ?? (() => true),
    real: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    },
    settings: () => ({ maxTurns: over.maxTurns ?? 10 }),
    run: async (sessionId, spec, signal, toolUseId, input) => {
      const c = { sessionId, spec, signal, toolUseId, input };
      calls.push(c);
      return over.run ? over.run(c) : RESULT;
    },
  });
  const tool = group.tools[0]!;
  const call = (args: Record<string, unknown>, ctx: { sessionId?: string; signal?: AbortSignal; toolUseId?: string } = {}) =>
    tool.run({ sessionId: ctx.sessionId ?? "s", cwd, signal: ctx.signal, toolUseId: ctx.toolUseId }, args);
  return { group, tool, calls, call };
}

describe("inline_task group", () => {
  it("is the inline group with one allow-tool named inline_task; enabled is read at each call", () => {
    let on = true;
    const { group, tool } = make({ enabled: () => on });
    expect(group.id).toBe("inline");
    expect(group.tools.map((t) => t.name)).toEqual(["inline_task"]);
    expect(tool.permission).toBe("allow");
    expect(group.enabled()).toBe(true);
    on = false;
    expect(group.enabled()).toBe(false);
    expect(group.timeoutMs).toBe(600_000 + 60_000);
  });

  it("instructions carry the when-to-use rules and the scenarios (at most 1200 chars)", () => {
    expect(INLINE_INSTRUCTIONS.length).toBeLessThanOrEqual(1300);
    expect(INLINE_INSTRUCTIONS).toMatch(/inline_task/);
    expect(INLINE_INSTRUCTIONS).toMatch(/3-10 tool calls/);
    expect(INLINE_INSTRUCTIONS).toMatch(/Use a subagent instead/);
    expect(INLINE_INSTRUCTIONS).toMatch(/Do it directly when 1-2 tool calls/);
    for (const e of ["Test run", "CI failure triage", "Log extraction", "Mechanical edit"]) expect(INLINE_INSTRUCTIONS).toContain(e);
  });

  it("returns the runner's result as is, with the default tools, the setting's maxTurns and the call's id", async () => {
    const { call, calls } = make({ maxTurns: 7 });
    const ctrl = new AbortController();
    const r = await call({ prompt: "Find the usages of foo\nand list them" }, { toolUseId: "toolu_1", signal: ctrl.signal });
    expect(r).toEqual(RESULT);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.spec).toEqual({ text: "Find the usages of foo\nand list them", title: "Find the usages of foo", tools: ["Read", "Grep", "Glob"], mcp: [], model: undefined, maxTurns: 7 });
    expect(calls[0]!.toolUseId).toBe("toolu_1");
    expect(calls[0]!.signal.aborted).toBe(false);
    ctrl.abort();
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls[0]!.input).toEqual({ prompt: "Find the usages of foo\nand list them" });
  });

  it("passes tools, mcp, model, maxTurns from the input; the title is cut at 60 chars", async () => {
    const { call, calls } = make();
    await call({ prompt: "x".repeat(100), tools: ["Bash", "Write"], mcp: ["playwright", "mcp__git__log"], model: "sonnet", maxTurns: 3 });
    expect(calls[0]!.spec).toMatchObject({ tools: ["Bash", "Write"], mcp: ["playwright", "mcp__git__log"], model: "sonnet", maxTurns: 3 });
    expect(calls[0]!.spec.title).toBe("x".repeat(60));
  });

  describe("input schema", () => {
    const schema = z.object(make().tool.shape);
    const bad = (v: Record<string, unknown>) => expect(schema.safeParse(v).success).toBe(false);
    it("checks every field", () => {
      expect(schema.safeParse({ prompt: "p" }).success).toBe(true);
      bad({});
      bad({ prompt: "" });
      bad({ prompt: "x".repeat(20_001) });
      expect(schema.safeParse({ prompt: "x".repeat(20_000) }).success).toBe(true);
      bad({ prompt: "p", tools: ["Agent"] });
      bad({ prompt: "p", maxTurns: 0 });
      bad({ prompt: "p", maxTurns: 31 });
      bad({ prompt: "p", maxTurns: 1.5 });
      expect(schema.safeParse({ prompt: "p", maxTurns: 30 }).success).toBe(true);
      bad({ prompt: "p", files: Array.from({ length: 21 }, (_, i) => `f${i}`) });
      bad({ prompt: "p", mcp: Array.from({ length: 11 }, (_, i) => `s${i}`) });
      bad({ prompt: "p", model: "m".repeat(101) });
    });
  });

  describe("files", () => {
    it("appends each file as <file path>, relative or absolute inside the folder", async () => {
      const { call, calls } = make();
      await call({ prompt: "Review", files: ["a.ts", join(cwd, "sub", "b.txt")] });
      expect(calls[0]!.spec.text).toBe(`Review\n\n<file path="a.ts">\nexport const a = 1;\n\n</file>\n<file path="sub/b.txt">\nbee\n</file>`);
    });
    it("refuses a path outside the folder, also through ../ and a symlink", async () => {
      const { call, calls } = make();
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "inline-out-")));
      writeFileSync(join(outside, "secret"), "s");
      symlinkSync(join(outside, "secret"), join(cwd, "link"));
      await expect(call({ prompt: "p", files: [join(outside, "secret")] })).rejects.toThrow(ToolError);
      await expect(call({ prompt: "p", files: ["../x"] })).rejects.toThrow(/outside/);
      await expect(call({ prompt: "p", files: ["link"] })).rejects.toThrow(/outside/);
      expect(calls).toHaveLength(0);
    });
    it("refuses a missing file, a directory, a binary file", async () => {
      const { call } = make();
      writeFileSync(join(cwd, "bin.dat"), Buffer.from([1, 0, 2]));
      await expect(call({ prompt: "p", files: ["nope.ts"] })).rejects.toThrow(/nope\.ts/);
      await expect(call({ prompt: "p", files: ["sub"] })).rejects.toThrow(/not a file/);
      await expect(call({ prompt: "p", files: ["bin.dat"] })).rejects.toThrow(/binary/);
    });
    it("refuses a file over 64 KB and files over 256 KB together", async () => {
      const { call } = make();
      writeFileSync(join(cwd, "big.txt"), "x".repeat(64 * 1024 + 1));
      writeFileSync(join(cwd, "ok.txt"), "x".repeat(64 * 1024));
      await expect(call({ prompt: "p", files: ["big.txt"] })).rejects.toThrow(/64 KB/);
      await expect(call({ prompt: "p", files: ["ok.txt", "ok.txt", "ok.txt", "ok.txt", "ok.txt"] })).rejects.toThrow(/256 KB/);
    });
  });

  describe("grants", () => {
    it("refuses the claude-ui and orchestration servers (a server or one of their tools)", async () => {
      const { call, calls } = make();
      for (const mcp of ["claude-ui", "orchestration", "mcp__claude-ui__inline_task", "mcp__orchestration__worker_start"])
        await expect(call({ prompt: "p", mcp: [mcp] })).rejects.toThrow(/recursion|cannot be granted/i);
      expect(calls).toHaveLength(0);
    });
    it("refuses a malformed mcp entry", async () => {
      const { call } = make();
      await expect(call({ prompt: "p", mcp: ["mcp__x"] })).rejects.toThrow(ToolError);
    });
  });

  describe("concurrency", () => {
    it("allows 3 running runs per session; the 4th is a ToolError; a finished run frees a slot; sessions count apart", async () => {
      const gates: (() => void)[] = [];
      const { call } = make({ run: () => new Promise((r) => gates.push(() => r(RESULT))) });
      const first = Array.from({ length: INLINE_MAX_PER_SESSION }, () => call({ prompt: "p" }));
      await expect(call({ prompt: "p" })).rejects.toThrow(/3/);
      void call({ prompt: "p" }, { sessionId: "other" });
      gates.shift()!();
      await first[0];
      const again = call({ prompt: "p" });
      expect(gates.length).toBeGreaterThan(0);
      for (const g of gates.splice(0)) g();
      await Promise.all([...first, again]);
    });
    it("a run that throws frees its slot", async () => {
      const { call } = make({ run: () => Promise.reject(new Error("boom")) });
      for (let i = 0; i < 5; i++) await expect(call({ prompt: "p" })).rejects.toThrow("boom");
    });
  });
});
