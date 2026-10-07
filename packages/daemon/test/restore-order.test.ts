// A restored session logs each subagent run inside its turn, so a page of whole turns holds the run with its children (GH-137).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Session } from "../src/session.ts";
import { interleaveRuns } from "../src/transcript.ts";
import type { Event } from "@claude-ui/protocol";
import { fakeQuery, history } from "./fake-query.ts";

const m = (type: string, uuid: string, content: unknown, parent: string | null = null) =>
  ({ type, uuid, session_id: "x", parent_tool_use_id: parent, parent_agent_id: null, message: { id: `m-${uuid}`, role: type, content } }) as never;
const turn = (i: number) => [m("user", `u${i}`, `prompt ${i}`), m("assistant", `a${i}`, [{ type: "text", text: `answer ${i}` }])];
// Turn 0 runs a subagent: the run's messages are listed apart from the main chain, as getSubagentMessages() returns them.
const main = [
  m("user", "u-first", "start a run"),
  m("assistant", "a-first", [{ type: "tool_use", id: "toolu_run", name: "Agent", input: { description: "Early run" } }]),
  m("user", "r-first", [{ type: "tool_result", tool_use_id: "toolu_run", content: "done" }]),
  ...Array.from({ length: 12 }, (_, i) => turn(i + 1)).flat(),
];
const children = [
  m("user", "c-prompt", "do the thing", "toolu_run"),
  m("assistant", "c-1", [{ type: "tool_use", id: "toolu_child", name: "Read", input: { file_path: "a" } }], "toolu_run"),
  m("user", "c-2", [{ type: "tool_result", tool_use_id: "toolu_child", content: "x" }], "toolu_run"),
];

describe("restored subagent runs", () => {
  it("interleaveRuns puts a run's messages right after the main message with its result", () => {
    const ordered = interleaveRuns(main, [children]);
    expect(ordered.map((x) => x.uuid).slice(0, 7)).toEqual(["u-first", "a-first", "r-first", "c-prompt", "c-1", "c-2", "u1"]);
    expect(ordered).toHaveLength(main.length + children.length);
    // A run whose call is not in the chain is kept, before the chain.
    expect(interleaveRuns(main, [[m("user", "lost", "x", "toolu_nowhere")]])[0]!.uuid).toBe("lost");
    // A nested run follows the message of its call inside the outer run.
    const outer = [...children, m("assistant", "n-1", [{ type: "tool_use", id: "toolu_inner", name: "Agent", input: {} }], "toolu_run")];
    const inner = [m("user", "i-1", "x", "toolu_inner")];
    expect(interleaveRuns(main, [outer, inner]).slice(3, 9).map((x) => x.uuid)).toEqual(["c-prompt", "c-1", "c-2", "n-1", "i-1", "u1"]);
  });

  it("restore behind 10+ later turns: the last page holds none of the early run's children, paging back loads them", () => {
    const s = Session.restore(randomUUID(), "/tmp", interleaveRuns(main, [children]), { query: fakeQuery as never });
    const { snapshot } = s.snapshot();
    expect(snapshot.page.parts.some((p) => p.parentId)).toBe(false);
    expect(snapshot.page.parts.filter((p) => p.type === "user_text")).toHaveLength(10);
    let older = snapshot.page.older;
    const found: string[] = [];
    while (older) {
      const page = s.page(older.before)!;
      found.push(...page.parts.filter((p) => p.parentId === "toolu_run").map((p) => p.id));
      older = page.older;
    }
    expect(found.length).toBeGreaterThan(0);
  });

  it("a run whose Agent call is gone (before a compaction) goes before the main chain, so the last page does not hold it", () => {
    const old = [m("user", "o-prompt", "old run", "toolu_before_compact"), m("assistant", "o-1", [{ type: "text", text: "old child" }], "toolu_before_compact")];
    const ordered = interleaveRuns(main, [old]);
    expect(ordered.slice(0, 2).map((x) => x.uuid)).toEqual(["o-prompt", "o-1"]);
    expect(ordered[2]!.uuid).toBe("u-first");
    const s = Session.restore(randomUUID(), "/tmp", ordered, { query: fakeQuery as never });
    expect(s.snapshot().snapshot.page.parts.some((p) => p.parentId)).toBe(false);
  });

  // An orphan run (its Agent call compacted away) renders nowhere; only its Edit/Write calls and their results reach anything (the changes tab).
  const orphan = [
    m("user", "o-prompt", "old run", "toolu_before_compact"),
    m("assistant", "o-text", [{ type: "text", text: "x".repeat(5000) }], "toolu_before_compact"),
    m("assistant", "o-read", [{ type: "tool_use", id: "toolu_o_read", name: "Read", input: { file_path: "a" } }], "toolu_before_compact"),
    m("user", "o-read-r", [{ type: "tool_result", tool_use_id: "toolu_o_read", content: "y".repeat(5000) }], "toolu_before_compact"),
    m("assistant", "o-edit", [{ type: "tool_use", id: "toolu_o_edit", name: "Edit", input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" } }], "toolu_before_compact"),
    m("user", "o-edit-r", [{ type: "tool_result", tool_use_id: "toolu_o_edit", content: "updated" }], "toolu_before_compact"),
    m("assistant", "o-nest", [{ type: "tool_use", id: "toolu_o_nested", name: "Agent", input: { description: "nested" } }], "toolu_before_compact"),
  ];
  const nested = [
    m("user", "n-prompt", "nested run", "toolu_o_nested"),
    m("assistant", "n-edit", [{ type: "tool_use", id: "toolu_n_edit", name: "Write", input: { file_path: "/p/b.ts", content: "b" } }], "toolu_o_nested"),
    m("user", "n-edit-r", [{ type: "tool_result", tool_use_id: "toolu_n_edit", content: "written" }], "toolu_o_nested"),
    m("assistant", "n-text", [{ type: "text", text: "nested text" }], "toolu_o_nested"),
  ];

  it("at restore (pruneOrphans) an orphan run and the runs nested in it keep only their Edit/Write calls and results, before the chain", () => {
    const ordered = interleaveRuns(main, [orphan, nested, children], { pruneOrphans: true });
    expect(ordered.slice(0, 4).map((x) => x.uuid)).toEqual(["o-edit", "o-edit-r", "n-edit", "n-edit-r"]);
    expect(ordered[4]!.uuid).toBe("u-first");
    // Anchored runs are untouched.
    expect(ordered.map((x) => x.uuid)).toEqual(expect.arrayContaining(["c-prompt", "c-1", "c-2"]));
    expect(ordered).toHaveLength(main.length + children.length + 4);
    // Without the option (the sync path: a continuing run whose call is known) nothing is dropped.
    expect(interleaveRuns(main, [orphan, nested])).toHaveLength(main.length + orphan.length + nested.length);
  });

  it("a restore whose chain is 1 turn (just compacted): the first page holds no orphan child but the edits, and the changes still have them", () => {
    const short = [m("user", "u-only", "after the compaction"), m("assistant", "a-only", [{ type: "text", text: "ok" }])];
    const restore = (prune: boolean) => Session.restore(randomUUID(), "/tmp", interleaveRuns(short, [orphan, nested], { pruneOrphans: prune }), { query: fakeQuery as never });
    // The page reaches index 0: without pruning it carries every orphan child.
    expect(restore(false).snapshot().snapshot.page.parts.filter((p) => p.parentId).length).toBeGreaterThan(4);
    const { page } = restore(true).snapshot().snapshot;
    expect(page.older).toBeUndefined();
    const children = page.parts.filter((p) => p.parentId);
    expect(children.map((p) => p.id).sort()).toEqual(["toolu_n_edit", "toolu_n_edit:result", "toolu_o_edit", "toolu_o_edit:result"]);
    expect(children.find((p) => p.id === "toolu_o_edit")).toMatchObject({ type: "tool_call", tool: "Edit", status: "done" });
    expect(page.parts.find((p) => p.type === "user_text")).toMatchObject({ text: "after the compaction" });
  });

  it("a pruned restore stays pruned: the first sync logs none of the dropped orphan messages, and the last page is unchanged", async () => {
    const short = [m("user", "u-only", "after the compaction"), m("assistant", "a-only", [{ type: "text", text: "ok" }])];
    // An orphan with a tail after its last edit, and one without edits.
    const tailed = [...orphan, m("assistant", "o-tail", [{ type: "text", text: "orphan tail text" }], "toolu_before_compact")];
    const plain = [m("user", "p-prompt", "other old run", "toolu_other"), m("assistant", "p-1", [{ type: "text", text: "other text" }], "toolu_other")];
    const runs = [tailed, nested, plain];
    const s = Session.restore(randomUUID(), "/tmp", interleaveRuns(short, runs, { pruneOrphans: true }), {
      query: fakeQuery as never,
      readTranscript: async () => ({ main: short as never, runs: runs as never }),
    }, [...short, ...runs.flat()].map((x) => (x as { uuid: string }).uuid));
    const before = JSON.stringify(s.snapshot().snapshot.page);
    const events: Event[] = [];
    s.subscribe(Number.MAX_SAFE_INTEGER, (e) => events.push(e));
    await s.sync();
    // context_usage: the restore's own usage refresh, settling late; a sync with nothing new returns before refreshing.
    expect(events.map((e) => e.part.type).filter((t) => t !== "context_usage")).toEqual([]);
    expect(JSON.stringify(s.snapshot().snapshot.page)).toBe(before);
  });

  it("a sync puts a new run's messages inside its turn, not after every new message", async () => {
    const msgs = [
      m("user", "s-prompt", "from the terminal"),
      m("assistant", "s-call", [{ type: "tool_use", id: "toolu_sync", name: "Agent", input: { description: "Sync run" } }]),
      m("user", "s-result", [{ type: "tool_result", tool_use_id: "toolu_sync", content: "done" }]),
      m("assistant", "s-last", [{ type: "text", text: "after the run" }]),
    ];
    const run = [m("user", "s-c1", "child prompt", "toolu_sync"), m("assistant", "s-c2", [{ type: "text", text: "child text" }], "toolu_sync")];
    const s = Session.restore(randomUUID(), "/tmp", history, { query: fakeQuery as never, readTranscript: async () => ({ main: [...history, ...msgs] as never, runs: [run] }) });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await s.sync();
    const texts = events.map((e) => e.part).filter((p) => p.type === "assistant_text" || p.type === "user_text").map((p) => (p as { text: string }).text);
    expect(texts.indexOf("child text")).toBeGreaterThan(-1);
    expect(texts.indexOf("child text")).toBeLessThan(texts.indexOf("after the run"));
  });
});
