import { describe, expect, it } from "vitest";
import { CHUNK_BYTES } from "@claude-ui/protocol";
import { planPaste, runTransfer, type Item, type Send } from "./transfer.ts";

type Node = { kind: "file"; data: string } | { kind: "dir" } | { kind: "link"; target: string };
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const err = (code: string) => Object.assign(new Error(code), { code });

/** Two in-memory Daemons keyed by side id. */
function world(init: Record<string, Record<string, Node>>) {
  const fs: Record<string, Map<string, Node>> = {};
  for (const [side, nodes] of Object.entries(init)) fs[side] = new Map(Object.entries(nodes));
  const log: { type: string; side: string; [k: string]: unknown }[] = [];
  let failOn: ((m: { type: string; [k: string]: unknown }) => boolean) | undefined;
  const below = (side: string, p: string) => [...fs[side]!.keys()].filter((k) => k.startsWith(p + "/"));
  const send: Send = async (m) => {
    log.push(m);
    if (failOn?.(m)) throw err("fs_error");
    const d = fs[m.side]!;
    const path = m.path as string;
    switch (m.type) {
      case "fs.walk": {
        const root = d.get(path);
        if (!root) throw err("not_found");
        const rels = ["", ...below(m.side, path).map((k) => k.slice(path.length + 1))];
        const entries = rels.map((rel) => {
          const n = d.get(rel ? `${path}/${rel}` : path)!;
          return { rel, kind: n.kind, size: n.kind === "file" ? Buffer.from(n.data, "base64").length : 0, mode: 0o644, ...(n.kind === "link" && { target: n.target }) };
        });
        return { entries, bytes: 0 } as never;
      }
      case "fs.create":
        if (d.has(path)) throw err("exists");
        d.set(path, { kind: "dir" });
        return { path } as never;
      case "fs.copy": {
        const from = d.get(m.from as string)!;
        if (d.has(m.to as string)) throw err("exists");
        d.set(m.to as string, from);
        return { path: m.to } as never;
      }
      case "fs.readChunk": {
        const n = d.get(path);
        if (n?.kind !== "file") throw err("not_a_file");
        const all = Buffer.from(n.data, "base64");
        return { data: all.subarray(m.offset as number, (m.offset as number) + (m.length as number)).toString("base64"), size: all.length } as never;
      }
      case "fs.writeChunk": {
        const cur = d.get(path);
        if (m.offset === 0 && cur) throw err("exists");
        const prev = m.offset === 0 ? Buffer.alloc(0) : Buffer.from((cur as { data: string }).data, "base64");
        d.set(path, { kind: "file", data: Buffer.concat([prev, Buffer.from(m.data as string, "base64")]).toString("base64") });
        return { size: 0 } as never;
      }
      case "fs.rename": {
        const to = `${(m.dir as string | undefined) ?? dirOf(path)}/${m.name}`;
        if (d.has(to) && !m.replace) throw err("exists");
        for (const k of [path, ...below(m.side, path)]) {
          d.set(to + k.slice(path.length), d.get(k)!);
          d.delete(k);
        }
        return { path: to } as never;
      }
      case "fs.delete":
        for (const k of [path, ...below(m.side, path)]) d.delete(k);
        return {} as never;
    }
    throw err("unknown_type");
  };
  return { fs, log, send, failOn: (f: typeof failOn) => (failOn = f), types: (t: string) => log.filter((m) => m.type === t) };
}
const b64 = (s: string) => Buffer.from(s).toString("base64");
const file = (s: string): Node => ({ kind: "file", data: b64(s) });
const dmn = (side: string, path: string, isDir = false): Item => ({ kind: "daemon", side, path, name: path.split("/").at(-1)!, isDir });
const keep = async () => ({ choice: "keep" as const, all: false });
const staging = (w: ReturnType<typeof world>, side: string) => [...w.fs[side]!.keys()].filter((k) => k.includes(".partial-"));

describe("runTransfer (GH-555)", () => {
  it("same Daemon: a copy is fs.walk + fs.create + fs.copy, no chunk call, ends with one rename", async () => {
    const w = world({ a: { "/p/src": { kind: "dir" }, "/p/src/x.ts": file("x"), "/p/dst": { kind: "dir" } } });
    const r = await runTransfer({ send: w.send, items: [dmn("a", "/p/src", true)], target: { side: "a", dir: "/p/dst", names: [] }, op: "copy", resolve: keep });
    expect(r).toMatchObject({ done: ["/p/dst/src"] });
    expect(w.fs.a!.get("/p/dst/src/x.ts")).toEqual(file("x"));
    expect(w.types("fs.readChunk")).toHaveLength(0);
    expect(w.types("fs.writeChunk")).toHaveLength(0);
    expect(w.types("fs.copy")).toHaveLength(1);
    expect(w.log.every((m) => m.side === "a")).toBe(true);
    expect(w.types("fs.rename")).toHaveLength(1);
    expect(staging(w, "a")).toEqual([]);
    expect(w.fs.a!.has("/p/src/x.ts")).toBe(true);
  });

  it("same Daemon cut is one fs.rename with dir", async () => {
    const w = world({ a: { "/p/f.ts": file("1"), "/p/d": { kind: "dir" } } });
    const r = await runTransfer({ send: w.send, items: [dmn("a", "/p/f.ts")], target: { side: "a", dir: "/p/d", names: [] }, op: "cut", resolve: keep });
    expect(r.done).toEqual(["/p/d/f.ts"]);
    expect(w.log).toEqual([{ type: "fs.rename", path: "/p/f.ts", name: "f.ts", dir: "/p/d", side: "a" }]);
  });

  it("cross Daemon copy streams the chunks of a file bigger than one chunk and ends with one rename", async () => {
    const big = "x".repeat(CHUNK_BYTES + 10);
    const w = world({ a: { "/a/big.bin": file(big) }, b: { "/b": { kind: "dir" } } });
    const progress: number[] = [];
    const r = await runTransfer({ send: w.send, items: [dmn("a", "/a/big.bin")], target: { side: "b", dir: "/b", names: [] }, op: "copy", resolve: keep, onProgress: (p) => progress.push(p.bytes) });
    expect(r.done).toEqual(["/b/big.bin"]);
    expect(Buffer.from((w.fs.b!.get("/b/big.bin") as { data: string }).data, "base64").toString()).toBe(big);
    expect(w.types("fs.writeChunk")).toHaveLength(2);
    expect(w.types("fs.writeChunk").every((m) => m.side === "b")).toBe(true);
    expect(w.types("fs.readChunk").every((m) => m.side === "a")).toBe(true);
    expect(w.types("fs.rename")).toHaveLength(1);
    expect(w.types("fs.copy")).toHaveLength(0);
    expect(progress.at(-1)).toBe(big.length);
    expect(w.fs.a!.has("/a/big.bin")).toBe(true);
  });

  it("cross Daemon cut deletes the source only after the final rename", async () => {
    const w = world({ a: { "/a/f": file("1") }, b: { "/b": { kind: "dir" } } });
    await runTransfer({ send: w.send, items: [dmn("a", "/a/f")], target: { side: "b", dir: "/b", names: [] }, op: "cut", resolve: keep });
    const order = w.log.map((m) => m.type);
    expect(order.lastIndexOf("fs.rename")).toBeLessThan(order.lastIndexOf("fs.delete"));
    expect(w.log.at(-1)).toMatchObject({ type: "fs.delete", side: "a", path: "/a/f" });
    expect(w.fs.a!.has("/a/f")).toBe(false);
    expect(w.fs.b!.has("/b/f")).toBe(true);
  });

  it("a failure in the 2nd file deletes the staging copy, keeps the source, reports the error", async () => {
    const w = world({ a: { "/a/d": { kind: "dir" }, "/a/d/1": file("1"), "/a/d/2": file("2") }, b: { "/b": { kind: "dir" } } });
    w.failOn((m) => m.type === "fs.writeChunk" && String(m.path).endsWith("/2"));
    const r = await runTransfer({ send: w.send, items: [dmn("a", "/a/d", true)], target: { side: "b", dir: "/b", names: [] }, op: "cut", resolve: keep });
    expect(r.error).toMatchObject({ code: "fs_error", name: "d" });
    expect(r.done).toEqual([]);
    expect(staging(w, "b")).toEqual([]);
    expect(w.fs.b!.has("/b/d")).toBe(false);
    expect(w.fs.a!.has("/a/d/1")).toBe(true);
    expect(w.types("fs.delete").map((m) => m.side)).toEqual(["b"]);
  });

  it("abort between entries deletes the staging copy", async () => {
    const w = world({ a: { "/a/d": { kind: "dir" }, "/a/d/1": file("1"), "/a/d/2": file("2") }, b: { "/b": { kind: "dir" } } });
    const ac = new AbortController();
    const r = await runTransfer({ send: w.send, items: [dmn("a", "/a/d", true)], target: { side: "b", dir: "/b", names: [] }, op: "copy", resolve: keep, signal: ac.signal, onProgress: (p) => p.files === 1 && ac.abort() });
    expect(r.cancelled).toBe(true);
    expect(staging(w, "b")).toEqual([]);
    expect([...w.fs.b!.keys()]).toEqual(["/b"]);
  });

  it("clash: Replace passes replace, Skip leaves it, Keep both uses the copy name, Apply to all asks once", async () => {
    const mk = () => world({ a: { "/p/a.txt": file("A"), "/p/b.txt": file("B"), "/p/d": { kind: "dir" }, "/p/d/a.txt": file("old"), "/p/d/b.txt": file("old") } });
    const items = [dmn("a", "/p/a.txt"), dmn("a", "/p/b.txt")];
    const target = { side: "a", dir: "/p/d", names: ["a.txt", "b.txt"] };

    let w = mk();
    let asked = 0;
    let r = await runTransfer({ send: w.send, items, target, op: "copy", resolve: async (_n, rest) => (asked++, expect(rest).toBe(1), { choice: "replace", all: true }) });
    expect(asked).toBe(1);
    expect(r.done).toEqual(["/p/d/a.txt", "/p/d/b.txt"]);
    expect(w.types("fs.rename").every((m) => m.replace === true)).toBe(true);
    expect(w.fs.a!.get("/p/d/a.txt")).toEqual(file("A"));

    w = mk();
    r = await runTransfer({ send: w.send, items, target, op: "copy", resolve: async () => ({ choice: "skip", all: true }) });
    expect(r).toMatchObject({ done: [], skipped: ["a.txt", "b.txt"] });
    expect(w.fs.a!.get("/p/d/a.txt")).toEqual(file("old"));

    w = mk();
    r = await runTransfer({ send: w.send, items, target, op: "copy", resolve: async () => ({ choice: "keep", all: false }) });
    expect(r.done).toEqual(["/p/d/a copy.txt", "/p/d/b copy.txt"]);
    expect(w.fs.a!.get("/p/d/a.txt")).toEqual(file("old"));
  });

  it("copy into its own folder keeps both without asking", async () => {
    const w = world({ a: { "/p/a.txt": file("A") } });
    const r = await runTransfer({ send: w.send, items: [dmn("a", "/p/a.txt")], target: { side: "a", dir: "/p", names: ["a.txt"] }, op: "copy", resolve: async () => Promise.reject(new Error("asked")) });
    expect(r.done).toEqual(["/p/a copy.txt"]);
  });

  it("links: recreated on the same Daemon, skipped and counted across Daemons", async () => {
    const nodes = { "/a/d": { kind: "dir" }, "/a/d/l": { kind: "link", target: "x" }, "/a/d/f": file("1") } as Record<string, Node>;
    let w = world({ a: nodes, b: { "/b": { kind: "dir" } } });
    let r = await runTransfer({ send: w.send, items: [dmn("a", "/a/d", true)], target: { side: "b", dir: "/b", names: [] }, op: "copy", resolve: keep });
    expect(r.linksSkipped).toBe(1);
    expect(w.fs.b!.has("/b/d/l")).toBe(false);
    expect(w.fs.b!.has("/b/d/f")).toBe(true);
    w = world({ a: { ...nodes, "/a/e": { kind: "dir" } } });
    r = await runTransfer({ send: w.send, items: [dmn("a", "/a/d", true)], target: { side: "a", dir: "/a/e", names: [] }, op: "copy", resolve: keep });
    expect(r.linksSkipped).toBe(0);
    expect(w.fs.a!.get("/a/e/d/l")).toEqual({ kind: "link", target: "x" });
  });

  it("caps refuse before any write request", async () => {
    const w = world({ a: { "/a/d": { kind: "dir" }, "/a/d/1": file("1") }, b: { "/b": { kind: "dir" } } });
    const send: Send = async (m) => {
      if (m.type === "fs.walk") throw err("too_large");
      return w.send(m);
    };
    const r = await runTransfer({ send, items: [dmn("a", "/a/d", true)], target: { side: "b", dir: "/b", names: [] }, op: "copy", resolve: keep });
    expect(r.error?.code).toBe("too_large");
    expect(w.log.filter((m) => m.type !== "fs.walk")).toEqual([]);
  });
});

describe("OS files (GH-555)", () => {
  it("are written as chunks to the target Daemon, a folder item first", async () => {
    const w = world({ b: { "/b": { kind: "dir" } } });
    const f = new File(["hello"], "h.txt");
    const items: Item[] = [
      { kind: "browser", name: "h.txt", isDir: false, items: [{ rel: "", kind: "file", size: 5, file: f }] },
      { kind: "browser", name: "dir", isDir: true, items: [{ rel: "", kind: "dir", size: 0 }, { rel: "e.txt", kind: "file", size: 0, file: new File([], "e.txt") }] },
    ];
    const r = await runTransfer({ send: w.send, items, target: { side: "b", dir: "/b", names: [] }, op: "copy", resolve: keep });
    expect(r.done).toEqual(["/b/h.txt", "/b/dir"]);
    expect(Buffer.from((w.fs.b!.get("/b/h.txt") as { data: string }).data, "base64").toString()).toBe("hello");
    expect(w.fs.b!.get("/b/dir/e.txt")).toEqual(file(""));
  });
});

describe("planPaste (GH-555)", () => {
  const t = { side: "a", dir: "/p/src" };
  it("refuses a folder into itself or below, on the same Daemon only", () => {
    expect(planPaste([dmn("a", "/p/src", true)], t, "copy")).toMatchObject({ items: [], refused: [{ name: "src", code: "into_itself" }] });
    expect(planPaste([dmn("a", "/p", true)], t, "cut").refused).toHaveLength(1);
    expect(planPaste([dmn("b", "/p", true)], t, "copy").refused).toEqual([]);
  });
  it("a cut into its own folder does nothing; a copy goes on", () => {
    expect(planPaste([dmn("a", "/p/src/x.ts")], t, "cut").items).toEqual([]);
    expect(planPaste([dmn("a", "/p/src/x.ts")], t, "copy").items).toHaveLength(1);
  });
  it("OS files over the entry or byte limit are refused as a whole", () => {
    const many: Item = { kind: "browser", name: "d", isDir: true, items: Array.from({ length: 10_001 }, (_, i) => ({ rel: `${i}`, kind: "dir" as const, size: 0 })) };
    expect(planPaste([many], t, "copy").refused).toEqual([{ name: "", code: "too_many" }]);
    const huge: Item = { kind: "browser", name: "h", isDir: false, items: [{ rel: "", kind: "file", size: 513 * 1024 * 1024 }] };
    expect(planPaste([huge], t, "copy")).toEqual({ items: [], refused: [{ name: "", code: "too_large" }] });
  });
});
