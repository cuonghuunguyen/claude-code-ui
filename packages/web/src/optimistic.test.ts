import { describe, expect, it } from "vitest";
import type { Event, Part } from "@claude-ui/protocol";
import { addPending, dropPending, movePending, promptedIds, pruneEchoed, STALE_MS, titleLoading, unechoed, type Pending } from "./optimistic.ts";
import { applyEvent, emptySession, type SessionView } from "./store.ts";
import { NEW_TAB } from "./tabs.ts";

const ev = (seq: number, part: Part): Event => ({ type: "event", sessionId: "s", seq, part });
const said = (v: SessionView, id: string, text: string, images: string[] = [], extra: object = {}) =>
  applyEvent(v, ev(v.lastSeq + 1, { type: "user_text", id, text, images, ...extra } as Part));
const p = (key: string, text: string, images: string[] = []) => ({ key, text, images });

describe("optimistic prompts", () => {
  it("a pending prompt shows until its user_text echo is in the view", () => {
    const v0 = emptySession();
    const [a] = addPending(undefined, v0, p("k", "hi"));
    expect(unechoed([a!], v0)).toHaveLength(1);
    expect(unechoed([a!], said(v0, "u1", "hi"))).toHaveLength(0);
  });

  it("an earlier identical prompt in the view is not the echo of a new one", () => {
    const v1 = said(emptySession(), "u1", "ok");
    const list = addPending(undefined, v1, p("k", "ok"));
    expect(list[0]!.after).toBe("u1");
    expect(unechoed(list, v1)).toHaveLength(1);
    expect(unechoed(list, said(v1, "u2", "ok"))).toHaveLength(0);
  });

  it("a prepended older page with the same text does not reconcile the pending prompt", () => {
    const v1 = said(emptySession(), "u1", "ok");
    const list = addPending(undefined, v1, p("k", "ok"));
    // Transcript paging: an older page lands before the existing parts.
    const older = { ...v1, order: ["old1", ...v1.order], parts: new Map([["old1", { type: "user_text", id: "old1", text: "ok", images: [] } as Part], ...v1.parts]) };
    expect(unechoed(list, older)).toHaveLength(1);
    expect(unechoed(list, said(older, "u2", "ok"))).toHaveLength(0);
  });

  it("a replaced order without the after id falls back to the whole order: no duplicate, at worst hidden early", () => {
    const v1 = said(emptySession(), "u1", "ok");
    const list = addPending(undefined, v1, p("k", "ok"));
    const replaced = said(said(emptySession(), "n1", "intro"), "n2", "ok"); // u1 is gone
    expect(unechoed(list, replaced)).toHaveLength(0);
    expect(unechoed(list, said(emptySession(), "n1", "intro"))).toHaveLength(1);
  });

  it("two identical pending prompts: the first echo hides only the first", () => {
    const v0 = emptySession();
    const list = addPending(addPending(undefined, v0, p("a", "x")), v0, p("b", "x"));
    expect(list.map((q) => q.baseline)).toEqual([0, 1]);
    expect(unechoed(list, said(v0, "u1", "x")).map((q) => q.key)).toEqual(["b"]);
    expect(unechoed(list, said(said(v0, "u1", "x"), "u2", "x"))).toHaveLength(0);
  });

  it("a subagent's user_text (parentId) or another image count is not an echo", () => {
    const list = addPending(undefined, emptySession(), p("k", "hi"));
    expect(unechoed(list, said(emptySession(), "u1", "hi", [], { parentId: "agent" }))).toHaveLength(1);
    expect(unechoed(list, said(emptySession(), "u1", "hi", ["data:x"]))).toHaveLength(1);
  });

  it("pruneEchoed keeps the same object when nothing was echoed, drops echoed entries and empty keys, never touches NEW_TAB", () => {
    const v0 = emptySession();
    const mine = addPending(undefined, v0, p("k", "hi"));
    const all = { s1: mine, [NEW_TAB]: mine };
    expect(pruneEchoed(all, { s1: v0 })).toBe(all);
    expect(pruneEchoed(all, { s1: said(v0, "u1", "hi") })).toEqual({ [NEW_TAB]: mine });
    expect(pruneEchoed({ gone: [] }, {})).toEqual({});
  });

  it("a pending prompt whose echo never matches is dropped after 30 s once the view holds another user prompt", () => {
    const v0 = emptySession();
    const [a] = addPending(undefined, v0, p("k", "hello  "), 1000);
    const all = { s1: [a!] };
    const echoedAs = said(v0, "u1", "hello"); // the daemon trimmed it
    expect(pruneEchoed(all, { s1: echoedAs }, 1000 + STALE_MS)).toBe(all);
    expect(pruneEchoed(all, { s1: echoedAs }, 1000 + STALE_MS + 1)).toEqual({});
    // No newer prompt in the view: still waiting, however old.
    expect(pruneEchoed(all, { s1: v0 }, 1000 + 10 * STALE_MS)).toBe(all);
    // A second pending prompt: the first one's echo alone does not drop the second.
    const two = addPending([a!], v0, p("k2", "later"), 1000);
    const next = pruneEchoed({ s1: two }, { s1: said(v0, "u1", "hello  ") }, 1000 + STALE_MS + 1);
    expect(next.s1?.map((q) => q.key)).toEqual(["k2"]);
  });

  it("a turn that ends without an echo (a /clear whose user_text a rewind removed) drops the pending prompt; a running turn does not", () => {
    const apply = (v: SessionView, part: Part) => applyEvent(v, ev(v.lastSeq + 1, part));
    const v1 = said(emptySession(), "u1", "hi");
    const list = addPending(undefined, v1, p("k", "/clear"));
    const result = { type: "turn_result", id: "r1", durationMs: 1, usage: {}, isError: false } as unknown as Part;
    const running = apply(apply(v1, { type: "session_state", id: "st", state: "running" } as Part), { type: "assistant_text", id: "a1", text: "ok", streaming: true });
    expect(unechoed(list, running)).toHaveLength(1);
    // Idle with output but no turn_result (a terminal CLI turn the daemon's sync found before the prompt): still shown.
    const idleOutput = apply(running, { type: "session_state", id: "st", state: "idle" } as Part);
    expect(unechoed(list, idleOutput)).toHaveLength(1);
    // The result is in but the state is not idle yet.
    expect(unechoed(list, apply(running, result))).toHaveLength(1);
    const done = apply(apply(running, result), { type: "session_state", id: "st", state: "idle" } as Part);
    expect(unechoed(list, done)).toHaveLength(0);
    expect(pruneEchoed({ s: list }, { s: done })).toEqual({});
    expect(unechoed(list, apply(idleOutput, { type: "turn_interrupted", id: "ti" } as Part))).toHaveLength(0);
    // Idle with nothing after the anchor (the echo and state are on their way): still shown.
    expect(unechoed(list, v1)).toHaveLength(1);
    // The anchor is unknown (replaced view): never judged ended.
    expect(unechoed(list, apply(emptySession(), result))).toHaveLength(1);
  });

  it("a rejected earlier identical prompt lowers the baseline of the later one: its bubble does not stay beside its echo", () => {
    const v0 = emptySession();
    const list = addPending(addPending(undefined, v0, p("a", "ok")), v0, p("b", "ok"));
    const after = dropPending({ s: list }, "s", "a");
    expect(after.s![0]!.baseline).toBe(0);
    expect(unechoed(after.s, said(v0, "u1", "ok"))).toHaveLength(0);
    // Another text is not touched; a later entry's rejection leaves the earlier one alone.
    const mixed = addPending(addPending(undefined, v0, p("a", "ok")), v0, p("c", "other"));
    expect(dropPending({ s: mixed }, "s", "a").s![0]!.baseline).toBe(0);
    expect(dropPending({ s: list }, "s", "b").s![0]!.baseline).toBe(0);
  });

  it("dropPending removes one entry and the key when empty; movePending moves NEW_TAB to the session id", () => {
    const a = addPending(addPending(undefined, undefined, p("a", "x")), undefined, p("b", "y"));
    expect(dropPending({ s: a }, "s", "a").s!.map((q) => q.key)).toEqual(["b"]);
    expect(dropPending({ s: [a[0]!] }, "s", "a")).toEqual({});
    const all = { [NEW_TAB]: a, other: a };
    expect(movePending(all, "sess")).toEqual({ sess: a, other: a });
    expect(movePending({ other: a }, "sess")).toEqual({ other: a });
  });

  it("promptedIds: a session key, the NEW_TAB entry's sessionId, and a view with a user_text", () => {
    const apply = (v: SessionView, part: Part) => applyEvent(v, ev(v.lastSeq + 1, part));
    const mine: Pending[] = addPending(undefined, undefined, p("k", "x"));
    const over = apply(said(emptySession(), "u", "x"), { type: "turn_result", id: "r", durationMs: 1, usage: {}, isError: false } as unknown as Part);
    const failed = apply(said(emptySession(), "u", "x"), { type: "session_state", id: "st", state: "error" } as Part);
    const ids = promptedIds({ s1: mine, [NEW_TAB]: [{ ...mine[0]!, sessionId: "created" }] }, { s2: said(emptySession(), "u", "x"), s3: emptySession(), s4: over, s5: failed });
    // s4 finished its first turn and s5 failed before a transcript: their placeholder title is final, no skeleton.
    expect([...ids].sort()).toEqual(["created", "s1", "s2"]);
    expect(promptedIds({ [NEW_TAB]: mine }, {}).size).toBe(0);
  });

  it("titleLoading: prompted with a placeholder title only", () => {
    expect(titleLoading("New session", true)).toBe(true);
    expect(titleLoading("Untitled", true)).toBe(true);
    expect(titleLoading("Fix the bug", true)).toBe(false);
    expect(titleLoading("New session", false)).toBe(false);
  });
});
