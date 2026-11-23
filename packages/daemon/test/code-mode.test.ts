import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCode, type Approve } from "../src/code-mode.ts";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "code-mode-")));
mkdirSync(join(cwd, "src"));
for (const n of ["a", "b", "c"]) writeFileSync(join(cwd, "src", `${n}.ts`), `export const ${n} = "old";\n`);
const allow: Approve = async () => ({ allow: true });
const run = (code: string, approve: Approve = allow, o: object = {}) => runCode(code, { cwd, approve, ...o });

describe("code mode POC", () => {
  it("returns an expression, runs $ and parallel reads, returns one summary", async () => {
    const asked: string[] = [];
    const r = await run(`const fs = await glob("src/*.ts"); const t = await Promise.all(fs.map((f) => read(f))); return ({ n: fs.length, head: t[0].split("\\n")[0], echo: await $\`echo \${"a b"}\`.text() })`, async (t) => (asked.push(t), { allow: true }));
    expect(r.status).toBe("ok");
    expect(r.result).toEqual({ n: 3, head: '1\texport const a = "old";', echo: "a b\n" });
    expect(r.calls.map((c) => c.tool)).toEqual(expect.arrayContaining(["Glob", "Read", "Bash"]));
    expect(asked).toHaveLength(5);
  });

  it("edits many files after read; enforces read-before-edit and unique match", async () => {
    const bad = await run(`await edit("src/a.ts", "old", "new")`);
    expect(bad.status).toBe("error");
    expect(bad.error).toMatch(/Read the file/);
    const r = await run(`for (const f of await glob("src/*.ts")) { await read(f); await edit(f, "old", "new"); } return await grep("new", { path: "src" });`);
    expect(r.status).toBe("ok");
    expect(r.filesChanged.sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(readFileSync(join(cwd, "src/b.ts"), "utf8")).toContain('"new"');
  });

  it("a denied call with a comment is catchable; without a comment the script aborts", async () => {
    const a = await run(`try { await $\`echo hi\`.text(); } catch (e) { return e.message; }`, async () => ({ allow: false, message: "no shell" }));
    expect(a.status).toBe("ok");
    expect(a.result).toMatch(/no shell/);
    const b = await run(`await $\`echo hi\`; await write("never.txt", "x"); return 1;`, async () => ({ allow: false }));
    expect(b.status).toBe("denied");
    expect(b.filesChanged).toEqual([]);
  });

  it("the script has no process, require, import, fs, env or constructor escape", async () => {
    const probe = `const out = {};
      for (const k of ["process", "require", "fs", "fetch", "setTimeout", "module"]) out[k] = typeof globalThis[k];
      try { out.fn = read.constructor("return process")().pid; } catch (e) { out.fn = "blocked"; }
      try { out.ctor = this.constructor.constructor("return process")().pid; } catch (e) { out.ctor = "blocked"; }
      try { out.proto = Object.getPrototypeOf(async function () {}).constructor("return process")().pid; } catch (e) { out.proto = "blocked"; }
      try { out.imp = typeof (await import("node:fs")); } catch (e) { out.imp = "blocked"; }
      return out;`;
    const r = await run(probe);
    expect(r.status).toBe("ok");
    expect(r.result).toEqual({ process: "undefined", require: "undefined", fs: "undefined", fetch: "undefined", setTimeout: "undefined", module: "undefined", fn: "blocked", ctor: "blocked", proto: "blocked", imp: "blocked" });
  });

  it("no main-realm error crosses the bridge (a replaced JSON.stringify made the bridge throw a main-realm SyntaxError)", async () => {
    const r = await run(`JSON.stringify = () => "{bad"; try { await read("src/a.ts"); return "no throw"; } catch (e) { try { return e.constructor.constructor("return process")().pid; } catch { return "blocked"; } }`);
    expect(r.status).toBe("ok");
    expect(["no throw", "blocked"]).toContain(r.result);
  });

  it("stays inside the project folder: absolute, symlinked folder for a new file, glob outside", async () => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), "code-mode-out-")));
    writeFileSync(join(out, "secret.txt"), "s");
    symlinkSync(out, join(cwd, "link"));
    for (const code of [`return await read("/etc/hosts")`, `await write("link/new.txt", "x")`, `return await glob("../*")`, `return await glob("${out}/*")`]) {
      const r = await run(code);
      expect(r.status, code).toBe("error");
      expect(r.error, code).toMatch(/outside|inside the project/);
    }
    expect(existsSync(join(out, "new.txt"))).toBe(false);
    expect((await run(`return await glob("link/*")`)).result).toEqual([]);
  });

  it("the call limit holds for parallel calls", async () => {
    let asked = 0;
    const r = await run(`await Promise.all(Array.from({ length: 50 }, () => read("src/a.ts")))`, async () => (asked++, { allow: true }), { maxCalls: 5 });
    expect(r.limit).toBe("calls");
    expect(asked).toBe(5);
  });

  it("limits: time, calls, output; stop kills only script processes", async () => {
    expect((await run(`while (true) {}`, allow, { timeoutMs: 500 })).limit).toBe("time");
    const c = await run(`for (let i = 0; i < 10; i++) await $\`true\`;`, allow, { maxCalls: 3 });
    expect(c.limit).toBe("calls");
    expect(c.calls).toHaveLength(3);
    const big = await run(`"x".repeat(50000)`);
    expect(big.truncated).toBe(true);
    const ac = new AbortController();
    const p = run(`await $\`sleep 30\``, allow, { signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    const s = await p;
    expect(s.status).toBe("stopped");
    expect(s.durationMs).toBeLessThan(5000);
  });
});
