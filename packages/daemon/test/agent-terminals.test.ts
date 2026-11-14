import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentTerminals, QUIET_MS, RESULT_CHARS, type TerminalPort } from "../src/agent-terminals.ts";
import { ToolError, type DaemonToolCtx } from "../src/daemon-mcp.ts";

type T = { id: string; title: string; cwd: string; login: boolean; buffer: string };
const ROOT = "/work/app";
const term = (id: string, title: string, cwd = ROOT, extra: Partial<T> = {}): T => ({ id, title, cwd, login: false, buffer: "", ...extra });

function setup(terms: T[], { worktrees = [{ path: ROOT }] as { path: string }[] | null, enabled = true, known = [] as string[] } = {}) {
  const listeners = new Map<string, { output: (d: string) => void; exit: (c: number) => void }>();
  const written: string[] = [];
  let writeError: ReturnType<TerminalPort["write"]>;
  const port: TerminalPort = {
    all: () => terms,
    buffer: (id) => terms.find((t) => t.id === id)?.buffer,
    write: (id, data) => (writeError ? writeError : (written.push(`${id}:${data}`), undefined)),
    attach: (id, l) => (terms.some((t) => t.id === id) ? (listeners.set(id, l), () => void listeners.delete(id)) : undefined),
  };
  const group = createAgentTerminals({ terminals: port, worktrees: async () => worktrees, known: () => known, enabled: () => enabled });
  const call = (name: string, args: Record<string, unknown> = {}, ctx: Partial<DaemonToolCtx> = {}) =>
    group.tools.find((t) => t.name === name)!.run({ sessionId: "s", cwd: ROOT, ...ctx }, args) as Promise<any>;
  return { group, call, listeners, written, failWrite: (e: typeof writeError) => (writeError = e) };
}

describe("terminal_list", () => {
  it("lists terminals of the project with the folder relative to the root", async () => {
    const { call } = setup([term("a", "Terminal 1"), term("b", "Terminal 2", `${ROOT}/packages/web`)]);
    expect(await call("terminal_list")).toEqual([
      { terminal: "a", title: "Terminal 1", cwd: ".", running: true },
      { terminal: "b", title: "Terminal 2", cwd: "packages/web", running: true },
    ]);
  });
  it("hides other projects, a nested linked worktree and login terminals", async () => {
    const { call } = setup([term("a", "Terminal 1"), term("o", "Terminal 1", "/work/other"), term("n", "Terminal 1", `${ROOT}/.claude/worktrees/x`), term("l", "Claude login", ROOT, { login: true })], { worktrees: [{ path: ROOT }, { path: `${ROOT}/.claude/worktrees/x` }] });
    expect((await call("terminal_list")).map((t: { terminal: string }) => t.terminal)).toEqual(["a"]);
  });
  it("a session in a linked worktree sees that worktree only", async () => {
    const wt = `${ROOT}/.claude/worktrees/x`;
    const { call } = setup([term("a", "Terminal 1"), term("n", "Terminal 2", wt)], { worktrees: [{ path: ROOT }, { path: wt }] });
    expect((await call("terminal_list", {}, { cwd: `${wt}/sub` })).map((t: { terminal: string }) => t.terminal)).toEqual(["n"]);
  });
  it("outside a repository the session folder is the scope", async () => {
    const { call } = setup([term("a", "Terminal 1", "/tmp/p"), term("b", "Terminal 2", "/tmp/q")], { worktrees: null });
    expect((await call("terminal_list", {}, { cwd: "/tmp/p" })).map((t: { terminal: string }) => t.terminal)).toEqual(["a"]);
  });
  it("is refused while the setting is off", async () => {
    const { call } = setup([term("a", "Terminal 1")], { enabled: false });
    await expect(call("terminal_list")).rejects.toBeInstanceOf(ToolError);
  });
});

describe("terminal_read", () => {
  it("returns the last lines as plain text and resolves by id or title", async () => {
    const { call } = setup([term("a", "Terminal 1", ROOT, { buffer: "\x1b[32mone\x1b[0m\r\ntwo\r\nthree\r\n" })]);
    expect(await call("terminal_read", { terminal: "Terminal 1", lines: 2 })).toEqual({ title: "Terminal 1", text: "two\nthree", lines: 2, truncated: false, redacted: 0 });
    expect((await call("terminal_read", { terminal: "a" })).text).toBe("one\ntwo\nthree");
  });
  it("redacts known secrets and token patterns and counts them", async () => {
    const { call } = setup([term("a", "Terminal 1", ROOT, { buffer: "export DEMO_TOKEN=abcd1234efgh5678\r\npair pairing-token-value\r\n" })], { known: ["pairing-token-value"] });
    const r = await call("terminal_read", { terminal: "a" });
    expect(r.text).not.toContain("abcd1234");
    expect(r.text).not.toContain("pairing-token-value");
    expect(r.redacted).toBe(2);
  });
  it("redacts a private key even when the line window starts inside it", async () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\r\nAAAA\r\nBBBB\r\n-----END RSA PRIVATE KEY-----\r\nafter\r\n";
    const { call } = setup([term("a", "Terminal 1", ROOT, { buffer: key })]);
    const r = await call("terminal_read", { terminal: "a", lines: 3 });
    expect(r.text).not.toContain("BBBB");
    expect(r.text).toContain("[redacted]");
    expect(r.redacted).toBe(1);
  });
  it("hides a value that echo prints alone after an export of it, in a read and in a run", async () => {
    const { call, listeners } = setup([term("a", "Terminal 1", ROOT, { buffer: "$ export DEMO_TOKEN=abcd1234efgh5678\r\n$ echo $DEMO_TOKEN\r\nabcd1234efgh5678\r\n" })]);
    const r = await call("terminal_read", { terminal: "a" });
    expect(r.text).not.toContain("abcd1234");
    vi.useFakeTimers();
    const p = call("terminal_run", { terminal: "a", command: "echo $DEMO_TOKEN" });
    await vi.advanceTimersByTimeAsync(0);
    listeners.get("a")!.output("abcd1234efgh5678\r\n");
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect((await p).output).toBe("[redacted]\n");
    vi.useRealTimers();
  });
  it("keeps the tail of an over-long text and says truncated", async () => {
    const { call } = setup([term("a", "Terminal 1", ROOT, { buffer: `${"x".repeat(RESULT_CHARS)}END\n` })]);
    const r = await call("terminal_read", { terminal: "a", lines: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(RESULT_CHARS);
    expect(r.text.endsWith("END")).toBe(true);
  });
  it("names the ids when a title is ambiguous", async () => {
    const { call } = setup([term("a", "Terminal 1"), term("b", "Terminal 1", `${ROOT}/sub`)]);
    await expect(call("terminal_read", { terminal: "Terminal 1" })).rejects.toThrow(/a, b/);
  });
  it("does not reveal a terminal outside the scope", async () => {
    const { call } = setup([term("o", "Terminal 1", "/work/other")]);
    await expect(call("terminal_read", { terminal: "o" })).rejects.toThrow(/No terminal o/);
  });
});

describe("terminal_run", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([["a\nb"], ["a\rb"], ["a\x1bb"], [""], ["x".repeat(4097)]])("refuses a command that is not one line (%#)", async (command) => {
    const { call, written } = setup([term("a", "Terminal 1")]);
    await expect(call("terminal_run", { terminal: "a", command })).rejects.toThrow(/one line/);
    expect(written).toEqual([]);
  });

  it("types the command with Enter and returns the output once the terminal is quiet", async () => {
    const { call, listeners, written } = setup([term("a", "Terminal 1")]);
    const p = call("terminal_run", { terminal: "Terminal 1", command: "echo hi" });
    await vi.advanceTimersByTimeAsync(0);
    expect(written).toEqual(["a:echo hi\r"]);
    listeners.get("a")!.output("echo hi\r\n");
    await vi.advanceTimersByTimeAsync(300);
    listeners.get("a")!.output("hi\r\n");
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(await p).toEqual({ title: "Terminal 1", output: "echo hi\nhi\n", quiet: true, truncated: false, redacted: 0 });
    expect(listeners.size).toBe(0);
  });

  it("returns quiet: false when the terminal still prints at waitMs", async () => {
    const { call, listeners } = setup([term("a", "Terminal 1")]);
    const p = call("terminal_run", { terminal: "a", command: "tail -f log", waitMs: 2000 });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) {
      listeners.get("a")?.output(`line ${i}\n`);
      await vi.advanceTimersByTimeAsync(300);
    }
    const r = await p;
    expect(r.quiet).toBe(false);
    expect(r.output).toContain("line 0");
  });

  it("waits the whole waitMs when the terminal prints nothing", async () => {
    const { call } = setup([term("a", "Terminal 1")]);
    const p = call("terminal_run", { terminal: "a", command: "sleep 5", waitMs: 3000 });
    await vi.advanceTimersByTimeAsync(2999);
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).output).toBe("");
  });

  it("returns what it has when the tool call is aborted, and never sends Ctrl-C", async () => {
    const { call, listeners, written } = setup([term("a", "Terminal 1")]);
    const ac = new AbortController();
    const p = call("terminal_run", { terminal: "a", command: "sleep 99" }, { signal: ac.signal });
    await vi.advanceTimersByTimeAsync(0);
    listeners.get("a")!.output("partial");
    ac.abort();
    expect((await p).output).toBe("partial");
    expect(written).toEqual(["a:sleep 99\r"]);
  });

  it("refuses a second run on a terminal that is waiting, and frees it afterwards", async () => {
    const { call, listeners } = setup([term("a", "Terminal 1")]);
    const first = call("terminal_run", { terminal: "a", command: "one" });
    await vi.advanceTimersByTimeAsync(0);
    await expect(call("terminal_run", { terminal: "a", command: "two" })).rejects.toThrow(/Another terminal_run/);
    listeners.get("a")!.output("x");
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    await first;
    const again = call("terminal_run", { terminal: "a", command: "three" });
    await vi.advanceTimersByTimeAsync(0);
    listeners.get("a")!.output("y");
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    await expect(again).resolves.toMatchObject({ output: "y" });
  });

  it("returns the output with the exit code when the terminal exits while waiting", async () => {
    const { call, listeners } = setup([term("a", "Terminal 1")]);
    const p = call("terminal_run", { terminal: "a", command: "exit 3" });
    await vi.advanceTimersByTimeAsync(0);
    listeners.get("a")!.output("logout\r\n");
    listeners.get("a")!.exit(3);
    expect(await p).toMatchObject({ output: "logout\n", exited: 3 });
  });

  it.each([
    ["unknown_terminal", /closed/],
    ["input_backlog", /too much input/],
    ["write_failed", /failed/],
  ] as const)("maps the write error %s to a tool error and detaches", async (code, text) => {
    const { call, failWrite, listeners } = setup([term("a", "Terminal 1")]);
    failWrite(code);
    await expect(call("terminal_run", { terminal: "a", command: "x" })).rejects.toThrow(text);
    expect(listeners.size).toBe(0);
  });

  it("redacts secrets in the output", async () => {
    const { call, listeners } = setup([term("a", "Terminal 1")]);
    const p = call("terminal_run", { terminal: "a", command: "env" });
    await vi.advanceTimersByTimeAsync(0);
    listeners.get("a")!.output("GITHUB_TOKEN=ghp_" + "a".repeat(36) + "\r\n");
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    const r = await p;
    expect(r.output).toBe("GITHUB_TOKEN=[redacted]\n");
    expect(r.redacted).toBe(1);
  });

  it("titles the permission card with the terminal, its folder and the command (cut at 200 chars)", async () => {
    const { group } = setup([term("a", "Terminal 1", `${ROOT}/pkg`)]);
    const run = group.tools.find((t) => t.name === "terminal_run")!;
    expect(await run.title!({ sessionId: "s", cwd: ROOT }, { terminal: "a", command: "npm test" })).toBe("Run in Terminal 1 (pkg): npm test");
    expect(await run.title!({ sessionId: "s", cwd: ROOT }, { terminal: "a", command: "x".repeat(300) })).toBe(`Run in Terminal 1 (pkg): ${"x".repeat(200)}…`);
    expect(await run.title!({ sessionId: "s", cwd: ROOT }, { terminal: "zzz", command: "ls" })).toBeUndefined();
  });
});

describe("group", () => {
  it("allows list and read without a card, asks for run, and follows the setting", () => {
    const { group } = setup([]);
    expect(group.tools.map((t) => [t.name, t.permission])).toEqual([
      ["terminal_list", "allow"],
      ["terminal_read", "allow"],
      ["terminal_run", "ask"],
    ]);
    expect(group.enabled()).toBe(true);
  });
});
