import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INSTRUCTION, createWarmCommitMessage, generateCommitMessage, generateConfig, instructionFor, promptFor, unfence } from "../src/commit-message.ts";
import { diffConfig, gitCommitDiff } from "../src/git-write.ts";

if (process.platform === "win32") vi.setConfig({ testTimeout: 120_000 });
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();

/** A stub of the SDK's query: records its arguments and plays `messages`, or waits for the abort. */
function stub(messages: object[] | "wait") {
  const seen: { prompt?: string; options?: Record<string, any> } = {};
  const query = ((a: { prompt: string; options: Record<string, any> }) => {
    Object.assign(seen, a);
    return (async function* () {
      if (messages === "wait") await new Promise<void>((r) => a.options.abortController.signal.addEventListener("abort", () => r(), { once: true }));
      else yield* messages;
    })();
  }) as never;
  return { seen, query };
}
const ok = (result: string) => [{ type: "system" }, { type: "result", subtype: "success", is_error: false, result }];
const gen = (query: never, signal = new AbortController().signal) => generateCommitMessage({ cwd: "/x", prompt: "p", signal, query });

describe("instructionFor", () => {
  const g = { commitMessageInstruction: "global", commitMessageInstructions: { "/p": "mine", "/blank": "  " } as Record<string, string> };
  it("project wins, a blank override or unknown project falls to global, empty global to the built-in", () => {
    expect(instructionFor(g, "/p")).toBe("mine");
    expect(instructionFor(g, "/blank")).toBe("global");
    expect(instructionFor(g, "/other")).toBe("global");
    expect(instructionFor(g, undefined)).toBe("global");
    expect(instructionFor({ ...g, commitMessageInstruction: " " }, "/other")).toBe(DEFAULT_INSTRUCTION);
    expect(instructionFor({ commitMessageInstruction: "", commitMessageInstructions: {} }, "__proto__")).toBe(DEFAULT_INSTRUCTION);
  });
});

describe("prompt of the checked files", () => {
  it("has the hunks of the checked files only, and the truncation note", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cm-")));
    git(root, "init", "-q", "-b", "main");
    for (const f of ["a", "b", "s"]) writeFileSync(join(root, `${f}.txt`), `${f}0\n`);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    writeFileSync(join(root, "a.txt"), `${"x\n".repeat(300)}`);
    writeFileSync(join(root, "b.txt"), "b1\n");
    writeFileSync(join(root, "n.txt"), "new\n");
    writeFileSync(join(root, "s.txt"), "staged\n");
    git(root, "add", "s.txt");
    const keep = diffConfig.maxChars;
    try {
      const d = (await gitCommitDiff(root, { paths: ["a.txt", "n.txt"], allowed: (p) => p.startsWith(root) }))!;
      const p = promptFor("INSTR", d);
      expect(p.startsWith("INSTR\n\n")).toBe(true);
      expect(p).toContain("a.txt");
      expect(p).toContain("+new");
      expect(p).not.toContain("b1");
      expect(p).not.toContain("staged");
      expect(p).not.toContain("truncated");
      diffConfig.maxChars = 300;
      const c = (await gitCommitDiff(root, { paths: ["a.txt", "n.txt"], allowed: (p) => p.startsWith(root) }))!;
      const pc = promptFor("INSTR", c);
      expect(pc).toContain(`The diff was truncated to ${c.diff.length} of ${c.total} characters; the file list above is complete.`);
      expect(pc).toContain("n.txt");
      expect(promptFor("I", { diff: "x", total: 1, cut: "patch" })).toContain("The patch was too large to include; only the file list is given.");
    } finally {
      diffConfig.maxChars = keep;
    }
  });
});

describe("generateCommitMessage", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("asks without tools, session file, API key or hooks", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-secret");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "tok");
    const s = stub(ok("feat: x"));
    expect(await gen(s.query)).toBe("feat: x");
    expect(s.seen.prompt).toBe("p");
    expect(s.seen.options).toMatchObject({ tools: [], persistSession: false, maxTurns: 1, model: "haiku", cwd: "/x", settingSources: [], mcpServers: {}, strictMcpConfig: true, settings: { disableAllHooks: true } });
    expect(s.seen.options!.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(s.seen.options!.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });
  it("unwraps a code fence", async () => {
    expect(await gen(stub(ok("```\nfeat: x\n\nbody\n```\n")).query)).toBe("feat: x\n\nbody");
    expect(unfence("  plain  ")).toBe("plain");
  });
  it("an error result carries its text; an empty result is an error", async () => {
    await expect(gen(stub([{ type: "result", subtype: "success", is_error: true, result: "Not logged in" }]).query)).rejects.toMatchObject({ code: "generate_failed", message: "Not logged in" });
    await expect(gen(stub([{ type: "result", subtype: "error_max_turns", is_error: true }]).query)).rejects.toMatchObject({ code: "generate_failed" });
    await expect(gen(stub(ok("  ")).query)).rejects.toMatchObject({ code: "generate_failed", message: "Claude returned no message" });
    await expect(gen((() => { throw new Error("boom"); }) as never)).rejects.toMatchObject({ code: "generate_failed", message: "boom" });
  });
  it("cancel and timeout", async () => {
    const c = new AbortController();
    const p = gen(stub("wait").query, c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
    await expect(gen(stub("wait").query, AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled" });
    const keep = generateConfig.timeout;
    generateConfig.timeout = 30;
    try {
      await expect(gen(stub("wait").query)).rejects.toMatchObject({ code: "timeout" });
    } finally {
      generateConfig.timeout = keep;
    }
  });
});

/** A stub of a streaming-input query: one process per call; it answers the first user message it is given, then waits for the abort. */
function warmStub(mode: "ok" | "crash" | "wait" = "ok") {
  const log = { spawned: 0, aborted: 0, options: [] as Record<string, any>[], texts: [] as string[], modes: [mode] };
  const query = ((a: { prompt: AsyncIterable<{ message: { content: string } }>; options: Record<string, any> }) => {
    log.spawned++;
    log.options.push(a.options);
    const my = log.modes.length > 1 ? log.modes.shift()! : log.modes[0]!;
    a.options.abortController.signal.addEventListener("abort", () => log.aborted++, { once: true });
    return (async function* () {
      for await (const u of a.prompt) {
        log.texts.push(u.message.content);
        if (my === "crash") return;
        if (my === "wait") await new Promise<void>((r) => a.options.abortController.signal.addEventListener("abort", () => r(), { once: true }));
        else yield* ok(`msg for ${u.message.content}`);
        return;
      }
    })();
  }) as never;
  return { log, query };
}
const genWarm = (w: ReturnType<typeof createWarmCommitMessage>, prompt: string, signal = new AbortController().signal) => generateCommitMessage({ cwd: "/x", prompt, signal, warm: w });

describe("warm commit message generator", () => {
  it("keeps one process ready: a click spawns none, later clicks use a fresh one each, so no diff leaks", async () => {
    const s = warmStub();
    const w = createWarmCommitMessage(s.query);
    w.prewarm();
    expect(s.log.spawned).toBe(1);
    expect(await genWarm(w, "diff A")).toBe("msg for diff A");
    expect(s.log.spawned).toBe(2); // the replacement for the next click
    expect(await genWarm(w, "diff B")).toBe("msg for diff B");
    expect(s.log.spawned).toBe(3);
    expect(s.log.texts).toEqual(["diff A", "diff B"]); // each process got exactly one message
    expect(s.log.options[0]).toMatchObject({ tools: [], persistSession: false, model: "haiku", settingSources: [], mcpServers: {}, strictMcpConfig: true, settings: { disableAllHooks: true } });
    w.stop();
    expect(s.log.aborted).toBe(3);
  });
  it("starts a process on the first click when none is ready; stop ends the ready one and nothing restarts", async () => {
    const s = warmStub();
    const w = createWarmCommitMessage(s.query);
    expect(await genWarm(w, "d")).toBe("msg for d");
    expect(s.log.spawned).toBe(2);
    w.stop();
    expect(s.log.aborted).toBe(2);
    w.stop();
    expect(s.log.spawned).toBe(2);
  });
  it("a crashed warm process is replaced and the click is answered", async () => {
    const s = warmStub();
    s.log.modes = ["crash", "ok"];
    const w = createWarmCommitMessage(s.query);
    w.prewarm();
    expect(await genWarm(w, "d")).toBe("msg for d");
    w.stop();
  });
  it("two crashes in a row fail with generate_failed; the next click starts again", async () => {
    const s = warmStub();
    s.log.modes = ["crash", "crash", "ok"];
    const w = createWarmCommitMessage(s.query);
    await expect(genWarm(w, "d")).rejects.toMatchObject({ code: "generate_failed" });
    expect(await genWarm(w, "e")).toBe("msg for e");
    w.stop();
  });
  it("cancel and timeout end the process", async () => {
    const s = warmStub("wait");
    const w = createWarmCommitMessage(s.query);
    const c = new AbortController();
    const p = genWarm(w, "d", c.signal);
    await vi.waitFor(() => expect(s.log.texts).toEqual(["d"]));
    c.abort();
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
    const keep = generateConfig.timeout;
    generateConfig.timeout = 30;
    try {
      await expect(genWarm(w, "e")).rejects.toMatchObject({ code: "timeout" });
    } finally {
      generateConfig.timeout = keep;
      w.stop();
    }
  });
});
