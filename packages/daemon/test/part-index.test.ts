import { describe, expect, it } from "vitest";
import type { Event, Part, TimelinePage } from "@claude-ui/protocol";
import { isAttention, PAGE_PARTS, PAGE_TURNS, TIMELINE_EXCLUDED } from "@claude-ui/protocol";
import { PartIndex } from "../src/part-index.ts";

/** Feeds parts to an index and a log like Session.emit does. */
function build(parts: Part[]) {
  const index = new PartIndex();
  const log: Event[] = [];
  for (const part of parts) {
    const seq = log.length + 1;
    const pos = index.apply({ type: "event", sessionId: "s", seq, part });
    log.push({ type: "event", sessionId: "s", seq, ...(pos !== undefined && { pos }), part });
  }
  return { index, log };
}

/** The client's fold (store.ts applyEvent) over the timeline parts. */
function fold(log: Event[]) {
  let order: string[] = [];
  const parts = new Map<string, Part>();
  for (const { part } of log) {
    if (part.type === "rewind") {
      const at = order.indexOf(part.userMessageId);
      if (at >= 0) {
        order.slice(at).forEach((id) => parts.delete(id));
        order = order.slice(0, at);
      }
    } else if (part.type === "retract") {
      part.partIds.forEach((id) => parts.delete(id));
      order = order.filter((id) => !part.partIds.includes(id));
    } else if (!TIMELINE_EXCLUDED.has(part.type)) {
      if (!parts.has(part.id)) order.push(part.id);
      parts.set(part.id, part);
    }
  }
  return { order, parts };
}

const user = (n: number): Part => ({ type: "user_text", id: `u${n}`, text: `prompt ${n}`, images: [] });
const text = (id: string, t: string, streaming = false): Part => ({ type: "assistant_text", id, text: t, streaming });
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
const turnResult = (n: number): Part => ({ type: "turn_result", id: `r${n}`, durationMs: 1, usage, isError: false });
const call = (id: string, tool: string, input: unknown = {}, status: "running" | "done" = "done"): Part => ({ type: "tool_call", id, toolUseId: id, tool, input, status });
const result = (id: string): Part => ({ type: "tool_result", id: `${id}:result`, toolUseId: id, output: "ok", isError: false });
const state = (s: "idle" | "running"): Part => ({ type: "session_state", id: "session_state", state: s });
const subagent = (id: string, status: "running" | "done" = "done"): Part => ({ type: "subagent", id, toolUseId: id, description: "d", status, startedAt: 1 });

/** `n` turns from number `from`, each: prompt, streamed reply (3 updates), a tool call and result, turn result. */
function turns(n: number, from = 1): Part[] {
  const out: Part[] = [];
  for (let i = from; i < from + n; i++)
    out.push(state("running"), user(i), text(`a${i}`, "h", true), text(`a${i}`, "hel", true), call(`c${i}`, "Read"), result(`c${i}`), text(`a${i}`, "hello"), turnResult(i), state("idle"));
  return out;
}

/** The last page, then older pages, concatenated oldest first. */
function allPages(index: PartIndex) {
  const pages: TimelinePage[] = [index.lastPage()];
  while (pages[0]!.older) pages.unshift(index.pageBefore(pages[0]!.older.before)!);
  return pages;
}

describe("PartIndex", () => {
  it("pages concatenated oldest to newest equal the client fold of the whole log", () => {
    const parts = [
      ...turns(12),
      subagent("sa", "running"),
      { ...text("child", "x"), parentId: "sa" },
      subagent("sa"),
      { type: "notice", id: "n1", level: "notice", text: "bad" } as Part,
      { type: "retract", id: "n1:retract", partIds: ["n1"] } as Part,
      ...turns(14, 13),
      { type: "rewind", id: "rw", userMessageId: "u20" } as Part,
      ...turns(3, 20),
      { type: "todo_update", id: "t:todos", items: [] } as Part,
    ];
    const { index, log } = build(parts);
    const whole = fold(log);
    const pages = allPages(index);
    const flat = pages.flatMap((p) => p.parts);
    expect(flat.map((p) => p.id)).toEqual(whole.order);
    expect(new Set(flat.map((p) => p.id)).size).toBe(flat.length);
    for (const p of flat) expect(p).toBe(whole.parts.get(p.id));
    expect(pages.length).toBeGreaterThan(2);
  });

  it("a page holds whole turns: at least PAGE_TURNS turns or PAGE_PARTS parts, and one giant turn goes whole", () => {
    const page = build(turns(25)).index.lastPage();
    expect(page.parts.filter((p) => p.type === "user_text")).toHaveLength(PAGE_TURNS);
    expect(page.parts[0]!.type).toBe("user_text");

    const giant: Part[] = [user(1), user(2)];
    for (let i = 0; i < PAGE_PARTS * 2; i++) giant.push(call(`g${i}`, "Read"));
    const { index } = build([...giant, user(3), text("x", "y")]);
    // The giant turn u2 is over PAGE_PARTS alone: the last page is u3 plus that whole turn at most, never a cut of it.
    const last = index.lastPage();
    expect(last.parts.map((p) => p.id)).toContain("u2");
    expect(last.parts.filter((p) => p.id.startsWith("g"))).toHaveLength(PAGE_PARTS * 2);
    expect(last.parts[0]!.id).toBe("u2");
    expect(last.older!.before).toBe("u2");
  });

  it("older.before is a top-level user_text id and older.pos its first seq", () => {
    const { index, log } = build(turns(25));
    const page = index.lastPage();
    expect(page.older!.before).toMatch(/^u\d+$/);
    expect(page.older!.pos).toBe(log.find((e) => e.part.id === page.older!.before)!.seq);
    expect(allPages(index)[0]!.older).toBeUndefined();
  });

  it("apply returns the first seq for an update of an existing part and undefined for a new part or a session_state", () => {
    const index = new PartIndex();
    expect(index.apply({ type: "event", sessionId: "s", seq: 1, part: text("a", "h", true) })).toBeUndefined();
    expect(index.apply({ type: "event", sessionId: "s", seq: 2, part: state("running") })).toBeUndefined();
    expect(index.apply({ type: "event", sessionId: "s", seq: 3, part: text("a", "hello") })).toBe(1);
    expect(index.apply({ type: "event", sessionId: "s", seq: 4, part: state("idle") })).toBeUndefined();
  });

  it("a rewind and a retract remove parts from later pages; a cursor that was rewound away is unknown", () => {
    const { index } = build([...turns(15), { type: "rewind", id: "rw", userMessageId: "u12" } as Part]);
    const all = allPages(index).flatMap((p) => p.parts.map((x) => x.id));
    expect(all).not.toContain("u12");
    expect(all).toContain("u11");
    expect(index.pageBefore("u12")).toBeUndefined();
    expect(index.pageBefore("nope")).toBeUndefined();
  });

  it("get returns the latest version of a part and undefined after a rewind or retract", () => {
    const { index } = build([...turns(3), { type: "rewind", id: "rw", userMessageId: "u3" } as Part]);
    expect(index.get("a1")).toMatchObject({ text: "hello" });
    expect(index.get("u2")).toBeDefined();
    expect(index.get("u3")).toBeUndefined();
    expect(index.get("nope")).toBeUndefined();
  });

  it("until extends the page back to the turn holding the part id or the message id prefix", () => {
    const { index } = build(turns(30));
    const cursor = index.lastPage().older!;
    const page = index.pageBefore(cursor.before, "c2")!;
    expect(page.parts.some((p) => p.id === "c2")).toBe(true);
    expect(page.parts[0]!.id).toBe("u2");
    expect(index.pageBefore(cursor.before, "a3")!.parts[0]!.id).toBe("u3");
    expect(index.pageBefore(cursor.before, "zzz")!.parts.filter((p) => p.type === "user_text")).toHaveLength(PAGE_TURNS);
  });

  it("heads keep the latest session_state, commands, context_usage, external_turn, todo_update; attentionSeq follows the store rule", () => {
    const { index, log } = build([
      state("running"),
      { type: "commands", id: "commands", commands: [] },
      { type: "todo_update", id: "t:todos", items: [{ content: "x", status: "pending" }] },
      { type: "context_usage", id: "context_usage", usage: { totalTokens: 1, maxTokens: 2, percentage: 50, categories: [] } },
      { type: "external_turn", id: "external_turn", running: false },
      { type: "session_model", id: "session_model", model: "m" },
      state("idle"),
    ]);
    expect(index.heads().map((e) => e.part.type)).toEqual(["commands", "todo_update", "context_usage", "external_turn", "session_state"]);
    expect(index.heads().at(-1)!.part).toMatchObject({ state: "idle" });
    expect(index.attentionSeq).toBe(log.length);
    expect(isAttention("idle", { state: "idle" })).toBe(false);
  });

  it("aux lists unloaded subagent, turn_result and running background Bash parts only; edits lists Edit/Write calls and their results before the boundary", () => {
    const { index } = build([
      user(1),
      call("e1", "Edit", { file_path: "a" }),
      result("e1"),
      call("w1", "Write", { file_path: "b" }),
      call("bg", "Bash", { run_in_background: true }, "running"),
      call("fg", "Bash", {}, "running"),
      call("rd1", "Read"),
      result("rd1"),
      subagent("sa"),
      turnResult(1),
      ...turns(12, 2),
    ]);
    const cursor = index.lastPage().older!;
    expect(index.aux(cursor.pos).map((x) => x.part.id)).toEqual(["bg", "sa", "r1", "r2", "r3"]);
    expect(index.edits(cursor.pos).map((x) => x.part.id)).toEqual(["e1", "e1:result", "w1"]);
  });

  it("aux carries the newest ExitPlanMode call before the cursor, at most one", () => {
    const { index } = build([
      user(1),
      call("p1", "ExitPlanMode", { plan: "old plan" }),
      subagent("sa"),
      call("p2", "ExitPlanMode", { plan: "new plan" }),
      ...turns(12, 2),
    ]);
    const cursor = index.lastPage().older!;
    const ids = index.aux(cursor.pos).map((x) => x.part.id);
    expect(ids.filter((id) => !id.startsWith("r"))).toEqual(["sa", "p2"]);
  });

  it("aux carries the newest ExitPlanMode call whatever its input, and the newest plan-file Write; not calls inside the page", () => {
    const file = (id: string, content: string) => call(id, "Write", { file_path: "/home/user/.claude/plans/p.md", content });
    const { index } = build([user(1), file("w0", "old"), file("w1", "# File plan"), call("w2", "Write", { file_path: "/p/a.txt", content: "x" }), call("p1", "ExitPlanMode", {}), ...turns(12, 2), call("p3", "ExitPlanMode", { plan: "inside page" })]);
    const cursor = index.lastPage().older!;
    const ids = index.aux(cursor.pos).map((x) => x.part.id);
    expect(ids.filter((id) => !id.startsWith("r"))).toEqual(["w1", "p1"]);
  });

  it("aux carries the Edit and MultiEdit calls of the plan file after its newest Write, in the session's plan folders only", () => {
    const f = "/cfg/plans/p.md";
    const { index } = build([
      user(1),
      call("w0", "Write", { file_path: f, content: "old" }),
      call("w1", "Write", { file_path: f, content: "# Plan\n1. a" }),
      call("e1", "Edit", { file_path: f, old_string: "1. a", new_string: "1. b" }),
      call("e2", "MultiEdit", { file_path: f, edits: [{ old_string: "1. b", new_string: "1. c" }] }),
      call("e3", "Edit", { file_path: "/other/plans/q.md", old_string: "x", new_string: "y" }),
      call("e4", "Edit", { file_path: f, old_string: "1. c", new_string: "1. failed" }, "running"),
      call("p1", "ExitPlanMode", {}),
      ...turns(12, 2),
    ]);
    const cursor = index.lastPage().older!;
    const ids = index.aux(cursor.pos, ["/cfg/plans"]).map((x) => x.part.id).filter((id) => !id.startsWith("r"));
    expect(ids).toEqual(["w1", "e1", "e2", "p1"]);
    expect(index.planOf("p1", ["/cfg/plans"])).toBe("# Plan\n1. c");
    // Folders the session does not use: no plan file at all.
    expect(index.planOf("p1", ["/nowhere"])).toBeUndefined();
  });

  it("planOf: the newest plan-file Write before the call, else the call's own plan; an empty-input call without a file has none", () => {
    const file = (id: string, content: string) => call(id, "Write", { file_path: "C:\\Users\\u\\.claude\\plans\\p.md", content });
    const { index } = build([user(1), file("w0", "old"), file("w1", "# File plan"), call("p1", "ExitPlanMode", {}), call("p2", "ExitPlanMode", { plan: "own" }), file("w2", "later")]);
    expect(index.planOf("p1")).toBe("# File plan");
    // The file wins: the CLI filled `plan` from the file before an Edit of the same message ran.
    expect(index.planOf("p2")).toBe("# File plan");
    expect(build([user(1), call("p2", "ExitPlanMode", { plan: "own" })]).index.planOf("p2")).toBe("own");
    expect(index.planOf("not-yet")).toBe("later");
    expect(build([user(1), call("p1", "ExitPlanMode", {})]).index.planOf("p1")).toBeUndefined();
  });

  it("pageFrom starts at the turn of the given id; over the cap or unknown gives undefined", () => {
    const { index } = build(turns(25));
    const from = index.pageFrom("c20", 3000)!;
    expect(from.parts[0]!.id).toBe("u20");
    expect(from.parts.at(-1)!.id).toBe(index.lastPage().parts.at(-1)!.id);
    expect(index.pageFrom("c20", 3)).toBeUndefined();
    expect(index.pageFrom("nope", 3000)).toBeUndefined();
  });
});

describe("prompt_queue part", () => {
  it("is a head (latest wins) and not a timeline part", () => {
    const q = (n: number): Part => ({ type: "prompt_queue", id: "prompt_queue", items: n ? [{ id: "i", text: "t", imageCount: 0 }] : [] });
    const { index, log } = build([user(1), q(1), q(0)]);
    expect(TIMELINE_EXCLUDED.has("prompt_queue")).toBe(true);
    expect(index.heads().filter((e) => e.part.type === "prompt_queue").map((e) => (e.part as { items: unknown[] }).items.length)).toEqual([0]);
    expect(fold(log).order).toEqual(["u1"]);
  });
});
