import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SEARCH_LIMITS, searchTranscripts, snippet, type SearchFile } from "../src/content-search.ts";

const dir = mkdtempSync(join(tmpdir(), "content-search-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const user = (text: unknown, uuid = "u" + Math.random(), extra: object = {}) => ({ type: "user", uuid, message: { role: "user", content: text }, ...extra });
const answer = (text: string, id = "m" + Math.random(), extra: object = {}) => ({ type: "assistant", uuid: "a" + Math.random(), message: { id, role: "assistant", content: [{ type: "text", text }] }, ...extra });
let n = 0;
const file = (lines: unknown[], raw?: string): SearchFile => {
  const f = join(dir, `${++n}.jsonl`);
  writeFileSync(f, raw ?? lines.map((l) => JSON.stringify(l) + "\n").join(""));
  return { sessionId: `s${n}`, cwd: "/p", title: `t${n}`, file: f };
};
const run = (files: SearchFile[], q: string, limits = {}, ac = new AbortController(), onResult?: () => void) => {
  const results: { sessionId: string; hits: { messageId: string; role: string; snippet: string }[] }[] = [];
  return searchTranscripts(files, q, (r) => (results.push(r), onResult?.()), { signal: ac.signal, limits }).then((done) => ({ results, done }));
};

describe("searchTranscripts", () => {
  it("matches prompts and answers case-insensitively, newest file first", async () => {
    const a = file([user("hello foobar", "U1"), answer("a FOOBAR here", "M1")]);
    const b = file([user("my Foobar")]);
    const { results } = await run([b, a], "FooBar");
    expect(results.map((r) => r.sessionId)).toEqual([b.sessionId, a.sessionId]);
    expect(results[1]!.hits).toMatchObject([{ messageId: "U1", role: "user" }, { messageId: "M1", role: "assistant" }]);
  });

  it("matches text that JSON escapes: quotes, backslashes, non-ASCII", async () => {
    const f = file([user('say "hi" now'), user("C:\\temp\\x"), user("Ünïcode café")]);
    for (const q of ['"hi"', "c:\\temp", "CAFÉ"]) expect((await run([f], q)).results.flatMap((r) => r.hits)).toHaveLength(1);
  });

  it("does not match tool results, tool inputs, thinking, sidechain, meta, compact summaries or JSON keys", async () => {
    const f = file([
      user([{ type: "tool_result", tool_use_id: "x", content: "zebra" }]),
      { type: "assistant", uuid: "a", message: { id: "m1", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "zebra" } }] } },
      { type: "assistant", uuid: "b", message: { id: "m2", content: [{ type: "thinking", thinking: "zebra" }] } },
      answer("zebra", "m3", { isSidechain: true }),
      user("zebra", "u1", { isMeta: true }),
      user("zebra", "u2", { isCompactSummary: true }),
      user("<command-name>zebra</command-name>"),
    ]);
    for (const q of ["zebra", "uuid", "isSidechain"]) expect((await run([f], q)).results).toEqual([]);
  });

  it("caps the sessions and the hits per session", async () => {
    const mk = () => file([user("needle one"), user("needle two"), answer("needle three")]);
    const dup = file([user("needle", "same"), user("needle again", "same")]);
    const { results, done } = await run([mk(), mk(), mk()], "needle", { sessions: 2, hitsPerSession: 1 });
    expect(results.map((r) => r.hits.length)).toEqual([1, 1]);
    expect(done.stopped).toBe("sessions");
    expect((await run([dup], "needle")).results[0]!.hits).toHaveLength(1);
  });

  it("stops on abort: no result after it, stopped canceled", async () => {
    const ac = new AbortController();
    const { results, done } = await run([file([user("needle")]), file([user("needle")])], "needle", {}, ac, () => ac.abort());
    expect(results).toHaveLength(1);
    expect(done.stopped).toBe("canceled");
    const pre = new AbortController();
    pre.abort();
    expect((await run([file([user("needle")])], "needle", {}, pre)).done).toMatchObject({ scannedFiles: 0, stopped: "canceled" });
  });

  it("stops at the time and byte budgets", async () => {
    const files = [file([user("needle")]), file([user("needle")])];
    const t = await run(files, "needle", { ms: 0 });
    expect(t.results).toEqual([]);
    expect(t.done.stopped).toBe("time");
    const b = await run(files, "needle", { bytes: 1 });
    expect(b.results).toHaveLength(1);
    expect(b.done.stopped).toBe("bytes");
  });

  it("a line split across chunks and a multi-byte character at a chunk edge still match", async () => {
    const { results } = await run([file([user("ééé needle ééé")])], "needle", { chunkBytes: 7 });
    expect(results[0]!.hits[0]!.snippet).toBe("ééé needle ééé");
  });

  it("skips a line longer than lineBytes and matches the next one", async () => {
    const f = file([user("needle " + "x".repeat(400), "long"), user("needle short", "short")]);
    const { results } = await run([f], "needle", { lineBytes: 200, chunkBytes: 32 });
    expect(results[0]!.hits.map((h) => h.messageId)).toEqual(["short"]);
  });

  it("a last line without newline is searched; a missing file is skipped", async () => {
    const f = file([], JSON.stringify(user("needle end", "last")));
    const gone: SearchFile = { sessionId: "gone", cwd: "/p", title: "", file: join(dir, "nope.jsonl") };
    const { results, done } = await run([gone, f], "needle");
    expect(results.map((r) => r.hits[0]!.messageId)).toEqual(["last"]);
    expect(done.stopped).toBeUndefined();
  });
});

describe("snippet", () => {
  it("is centered on the match, whitespace collapsed, at most snippetChars, URL userinfo redacted", () => {
    const s = snippet("a\n\n b https://u:pw@host/x needle tail", "needle")!;
    expect(s).toContain("https://host/x needle");
    expect(s).not.toContain("pw");
    const long = snippet("a".repeat(100) + " needle " + "b".repeat(300), "needle")!;
    expect(long.startsWith("…") && long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(122);
    expect(long).toContain("needle");
  });

  // Visible area as wide as the window, so what the window cuts would show.
  const WIDE = { ...SEARCH_LIMITS, before: 5000, snippetChars: 5000 };

  it("a multi-MB message is windowed: only a window around the match is returned (and it is fast)", () => {
    const text = "word ".repeat(1_000_000) + "needle" + " word".repeat(1_000_000);
    const t0 = performance.now();
    const s = snippet(text, "needle", WIDE)!;
    expect(performance.now() - t0).toBeLessThan(1000);
    // Without windowing the whole 10 MB would come back.
    expect(s.length).toBeLessThan(2 * (SEARCH_LIMITS.window + 2000));
    expect(s).toContain("needle");
  });

  it("the window starts at whitespace: a URL password cut by the window start is still redacted", () => {
    const url = "https://u:SECRET@h";
    const gap = (n: number) => "a ".repeat(n / 2);
    // The raw window start (480 before the match) lands inside the password, for each offset.
    for (let k = 0; k < url.length; k++) {
      const tail = "x".repeat(SEARCH_LIMITS.window - (url.length - k) - 1) + " ";
      const text = gap(1000) + url + " " + tail + "needle";
      const out = snippet(text, "needle", WIDE)!;
      expect(out, `offset ${k}`).toContain("needle");
      expect(out, `offset ${k}`).not.toContain("SECRET");
      // The whole URL is in the window (not dropped), with its userinfo removed.
      expect(out, `offset ${k}`).toContain("https://h");
    }
  });

  it("the window ends at whitespace: a URL password cut by the window end is never shown", () => {
    for (const w of [" ", "\n", "\t", "\r\n"]) {
      for (let n = 400; n < 520; n++) {
        const text = "needle" + w.repeat(n) + "https://u:SECRET@h/x " + "tail ".repeat(50);
        const out = snippet(text, "needle", WIDE) ?? "";
        expect(out, `${JSON.stringify(w)} x ${n}`).not.toContain("SECRET");
        // A URL that starts inside the window is kept whole, redacted.
        if (n * w.length <= 470) expect(out, `${JSON.stringify(w)} x ${n}`).toContain("https://h/x");
      }
    }
  });

  it("a token over 2000 chars at a window end is dropped, not cut", () => {
    const text = "needle " + "x".repeat(SEARCH_LIMITS.window - 8) + "https://u:SECRET@h/" + "p".repeat(3000);
    const out = snippet(text, "needle", WIDE)!;
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("https");
  });

  it("a match inside a token over 2000 chars gives no snippet", () => {
    expect(snippet("see https://alice:S3CRETneedle@host/" + "p".repeat(2500), "needle", WIDE)).toBeUndefined();
  });
});
