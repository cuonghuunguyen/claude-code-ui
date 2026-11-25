import { describe, expect, it, vi } from "vitest";
import { buildDigest, capOf, fitCap, stripText, tokensOf, type DigestEvent, type DigestSource } from "./quick-compact.ts";

const src = (events: DigestEvent[], more: Partial<DigestSource> = {}): DigestSource => ({ sessionId: "sid-1", title: "My chat", transcript: "/t/sid-1.jsonl", outDir: "/out", events, ...more });
const filler = (n: number): DigestEvent[] => Array.from({ length: n }, (_, i) => ({ kind: i % 2 ? "assistant" : "user", text: `turn ${i} ${"x".repeat(2000)}` }) as DigestEvent);

describe("quick compact digest", () => {
  it("keeps user and assistant text, drops reminders and command output", () => {
    expect(stripText("<command-name>/x</command-name>")).toBe("");
    const t = [stripText("hello <system-reminder>SECRET</system-reminder>"), stripText("<local-command-stdout>NOISE</local-command-stdout>")].join("|");
    expect(t).toBe("hello|");
    const d = buildDigest(src([{ kind: "user", text: "question one" }, { kind: "assistant", text: "answer one" }]));
    expect(d.text).toContain("**User:** question one");
    expect(d.text).toContain("**Assistant:** answer one");
  });

  it("writes old tool outputs and long inputs to files and points to them", () => {
    const big = "line\n".repeat(300);
    const events: DigestEvent[] = [
      { kind: "user", text: "go" },
      { kind: "tool", name: "Bash", input: { command: "ls" }, out: big },
      { kind: "tool", name: "Bash", input: { command: "echo " + "y".repeat(600) }, out: "ok" },
      ...filler(40),
    ];
    const d = buildDigest(src(events));
    expect(d.text).toContain("[output:");
    expect(d.text).toContain("0001-Bash.output.txt");
    expect(d.files.find((f) => f.name === "0001-Bash.output.txt")!.content).toBe(big);
    expect(d.files.some((f) => f.name === "0002-Bash.input.txt")).toBe(true);
    expect(d.text).not.toContain(big);
  });

  it("keeps the recent tail verbatim with outputs capped at 4000 chars", () => {
    const out = "z".repeat(5000);
    const d = buildDigest(src([{ kind: "user", text: "run" }, { kind: "tool", name: "Bash", input: { command: "gen" }, out }]));
    expect(d.text).toContain("## Recent (verbatim)");
    expect(d.text).toContain("z".repeat(4000));
    expect(d.text).not.toContain("z".repeat(4001));
    expect(d.text).toContain("truncated; full:");
    expect(d.files.find((f) => f.name === "0001-Bash.output.txt")!.content).toBe(out);
  });

  it("carries the earlier compact summary and names source, transcript and folder", () => {
    const d = buildDigest(src([{ kind: "user", text: "hi" }], { earlier: "EARLIER-SUMMARY" }));
    expect(d.text.split("\n")[0]).toBe("[claude-ui quick compact] source=sid-1");
    expect(d.text).toContain("## Earlier compact summary\n\nEARLIER-SUMMARY");
    expect(d.text).toContain("Full transcript: /t/sid-1.jsonl");
    expect(d.text).toContain("/out");
  });

  it("under the cap calls no model", async () => {
    const summarise = vi.fn(async () => "S");
    const d = await fitCap(src(filler(4)), capOf(200_000), summarise);
    expect(summarise).not.toHaveBeenCalled();
    expect(d.summarised).toBe(false);
  });

  it("over the cap summarises only the oldest part and fits the cap", async () => {
    const events = [{ kind: "user", text: "OLDEST-MARK" } as DigestEvent, ...filler(120), { kind: "user", text: "RECENT-MARK" } as DigestEvent];
    const full = buildDigest(src(events));
    const cap = Math.floor(full.tokens * 0.7);
    const seen: string[] = [];
    const d = await fitCap(src(events), cap, async (text, max) => (seen.push(text), "short summary ".repeat(Math.min(max, 20))));
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("OLDEST-MARK");
    expect(seen[0]).not.toContain("RECENT-MARK");
    expect(d.summarised).toBe(true);
    expect(d.text.split("\n")[0]).toBe("[claude-ui quick compact] source=sid-1 summarised");
    expect(d.text).toContain("RECENT-MARK");
    expect(d.tokens).toBeLessThanOrEqual(cap);
    expect(tokensOf(d.text)).toBe(d.tokens);
  });

  it("collapses old tool lines before it calls a model", async () => {
    const tools: DigestEvent[] = Array.from({ length: 200 }, (_, i) => ({ kind: "tool", name: "Read", input: { file_path: `/a/${"p".repeat(300)}${i}` }, out: "o".repeat(500) }));
    const events = [{ kind: "user", text: "start" } as DigestEvent, ...tools, ...filler(40)];
    const full = buildDigest(src(events));
    const summarise = vi.fn(async () => "S");
    const d = await fitCap(src(events), Math.floor(full.tokens * 0.8), summarise);
    expect(summarise).not.toHaveBeenCalled();
    expect(d.text).toMatch(/- \(\d+× Read; details in the tool output files\)/);
    expect(d.tokens).toBeLessThanOrEqual(Math.floor(full.tokens * 0.8));
  });
});

describe("quick compact over a small window", () => {
  it("shortens the verbatim tail so the digest fits the cap, and a 9000-event session is fast", async () => {
    const events: DigestEvent[] = Array.from({ length: 9000 }, (_, i) => (i % 3 ? { kind: "tool", name: "Read", input: { file_path: `/f/${i}` }, out: "o".repeat(300) } : { kind: "user", text: `turn ${i} ${"x".repeat(200)}` }) as DigestEvent);
    const cap = capOf(32_000);
    const t = Date.now();
    const d = await fitCap(src(events), cap, async (_text, max) => "s".repeat(Math.min(max, 100)));
    expect(Date.now() - t).toBeLessThan(3000);
    expect(d.tokens).toBeLessThanOrEqual(cap);
  });
});
