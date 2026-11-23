// Code mode POC (docs/code-mode-spec.md): `runCode` runs a model script in a locked-down child and executes each inner call here,
// after `approve` (the parent session's permission flow: ClaudeSession.askPermission / OpenCode reply) said yes.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { glob as fsGlob, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Approval = { allow: true } | { allow: false; message?: string };
/** The equivalent built-in call: tool name and input as the Engine would build the request. */
export type Approve = (tool: string, input: Record<string, unknown>) => Promise<Approval>;
export type CodeStatus = "ok" | "error" | "denied" | "limit" | "stopped";
export type CodeResult = {
  status: CodeStatus;
  limit?: "time" | "calls" | "output";
  error?: string;
  result: unknown;
  truncated?: boolean;
  logs: string;
  calls: { tool: string; summary: string; ok: boolean }[];
  filesChanged: string[];
  durationMs: number;
};
export type CodeOpts = { cwd: string; approve: Approve; signal?: AbortSignal; timeoutMs?: number; maxCalls?: number };

export const CODE_OUTPUT_CHARS = 16_000;
const CHILD = fileURLToPath(new URL("./code-mode-child.mjs", import.meta.url));
const MAX_CALL_BYTES = 16 << 20;
const CHILD_HEAP_MB = 256;

class Denied extends Error {}
const tail = (s: string, n: number) => (s.length > n ? s.slice(s.length - n) : s);
const within = (root: string, p: string) => {
  const r = relative(root, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

export async function runCode(code: string, o: CodeOpts): Promise<CodeResult> {
  const t0 = Date.now();
  const root = realpathSync(o.cwd);
  const calls: CodeResult["calls"] = [];
  const changed = new Set<string>();
  const readSet = new Set<string>();
  let reserved = 0; // calls that passed the limit check; counted before approval so parallel calls cannot pass it together
  const started = new Set<ChildProcess>();
  let logs = "";
  let status: CodeStatus = "ok";
  let limit: CodeResult["limit"];
  let error: string | undefined;
  let result: unknown = null;
  let ended = false;

  // `--permission` without grants: no fs, child_process, worker. Network is NOT restricted by it (POC finding), env is empty.
  const child = spawn(process.execPath, ["--permission", `--allow-fs-read=${CHILD}`, `--max-old-space-size=${CHILD_HEAP_MB}`, CHILD], { env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let oom = false;
  child.stderr?.on("data", (d: Buffer) => {
    const t = d.toString();
    if (/heap out of memory/i.test(t)) oom = true;
    logs = tail(logs + t, CODE_OUTPUT_CHARS);
  });

  const finish = (s: CodeStatus, e?: string, l?: CodeResult["limit"]) => {
    if (ended) return;
    ended = true;
    status = s;
    error = e;
    limit = l;
    child.kill("SIGKILL");
    // Only processes the script started.
    for (const p of started) if (p.pid && p.exitCode === null) try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill("SIGKILL"); }
  };

  // Real path; for a new file, the real path of its nearest existing ancestor plus the rest, so a symlinked folder cannot lead out.
  const real = (abs: string): string => {
    try { return realpathSync(abs); } catch { /* does not exist */ }
    const parent = dirname(abs);
    return parent === abs ? abs : join(real(parent), basename(abs));
  };
  const path = (p: unknown) => {
    if (typeof p !== "string" || !p) throw new Error("path must be a non-empty string");
    const r = real(resolve(root, p));
    if (!within(root, r)) throw new Error(`${p} is outside the project folder`);
    return r;
  };
  const str = (v: unknown, name: string) => {
    if (typeof v !== "string") throw new Error(`${name} must be a string`);
    return v;
  };
  const ask = async (tool: string, input: Record<string, unknown>) => {
    if (reserved++ >= (o.maxCalls ?? 200)) {
      finish("limit", undefined, "calls");
      throw new Denied("limit");
    }
    const a = await o.approve(tool, input);
    if (a.allow) return;
    if (a.message) throw new Error(`Denied by the user: ${a.message}`);
    finish("denied", `${tool} was denied`);
    throw new Denied("denied");
  };

  const shell = (cmd: string) =>
    new Promise<{ stdout: string; stderr: string; exitCode: number }>((res) => {
      const p = spawn("sh", ["-c", cmd], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      started.add(p);
      let out = "", err = "";
      p.stdout.on("data", (d: Buffer) => { if (out.length < MAX_CALL_BYTES) out += d; });
      p.stderr.on("data", (d: Buffer) => { if (err.length < MAX_CALL_BYTES) err += d; });
      p.on("close", (c) => { started.delete(p); res({ stdout: out, stderr: err, exitCode: c ?? -1 }); });
    });

  const ops: Record<string, (a: any) => Promise<unknown>> = {
    async sh(a) {
      str(a.cmd, "command");
      await ask("Bash", { command: a.cmd });
      return shell(a.cmd);
    },
    async read(a) {
      const p = path(a.path);
      await ask("Read", { file_path: p, ...(a.offset && { offset: a.offset }), ...(a.limit && { limit: a.limit }) });
      const lines = (await readFile(p, "utf8")).split("\n");
      readSet.add(p);
      const from = Math.max(0, (a.offset ?? 1) - 1);
      return lines.slice(from, a.limit ? from + a.limit : undefined).map((l, i) => `${from + i + 1}\t${l}`).join("\n");
    },
    async grep(a) {
      const p = a.path ? path(a.path) : root;
      str(a.pattern, "pattern");
      await ask("Grep", { pattern: a.pattern, path: p });
      const r = await new Promise<string>((res) => {
        const g = spawn("grep", ["-rnE", "--exclude-dir=node_modules", "--exclude-dir=.git", "-e", a.pattern, p], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        g.stdout.on("data", (d: Buffer) => { if (out.length < MAX_CALL_BYTES) out += d; });
        g.on("close", () => res(out));
      });
      return r.split("\n").filter(Boolean).map((l) => l.replace(`${root}/`, ""));
    },
    async glob(a) {
      const pattern = str(a.pattern, "pattern");
      if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) throw new Error("glob pattern must be relative and inside the project folder");
      const dir = a.path ? path(a.path) : root;
      await ask("Glob", { pattern, path: dir });
      const out: string[] = [];
      for await (const f of fsGlob(pattern, { cwd: dir }))
        if (!/(^|\/)(node_modules|\.git)\//.test(f) && within(root, real(resolve(dir, f)))) out.push(f);
      return out.sort();
    },
    async edit(a) {
      const p = path(a.path);
      str(a.oldText, "old text");
      str(a.newText, "new text");
      if (!readSet.has(p)) throw new Error("Read the file before editing it");
      await ask("Edit", { file_path: p, old_string: a.oldText, new_string: a.newText, ...(a.all && { replace_all: true }) });
      const text = await readFile(p, "utf8");
      const n = text.split(a.oldText).length - 1;
      if (n === 0) throw new Error("old text not found");
      if (n > 1 && !a.all) throw new Error(`old text is not unique (${n} matches)`);
      await writeFile(p, a.all ? text.split(a.oldText).join(a.newText) : text.replace(a.oldText, () => a.newText));
      changed.add(relative(root, p));
      return { replaced: a.all ? n : 1 };
    },
    async write(a) {
      const p = path(a.path);
      str(a.content, "content");
      if (existsSync(p) && !readSet.has(p)) throw new Error("Read the file before overwriting it");
      await ask("Write", { file_path: p, content: a.content });
      await writeFile(p, a.content);
      readSet.add(p);
      changed.add(relative(root, p));
      return { bytes: Buffer.byteLength(a.content) };
    },
  };
  const summary = (op: string, a: any) => String((op === "sh" ? a.cmd : (a.path ?? a.pattern)) ?? "").slice(0, 120);
  const TOOL: Record<string, string> = { sh: "Bash", read: "Read", grep: "Grep", glob: "Glob", edit: "Edit", write: "Write" };

  const timer = setTimeout(() => finish("limit", undefined, "time"), o.timeoutMs ?? 120_000);
  const onAbort = () => finish("stopped");
  o.signal?.addEventListener("abort", onAbort, { once: true });
  if (o.signal?.aborted) onAbort();

  await new Promise<void>((resolveRun) => {
    child.on("exit", () => {
      if (!ended) finish("error", oom ? `the script ran out of memory (${CHILD_HEAP_MB} MB)` : "the script process exited");
      resolveRun();
    });
    // Child messages are untrusted (an escaped script can send anything): validate the shape, never throw out of the handler.
    child.on("message", async (m: any) => {
      if (ended || m === null || typeof m !== "object") return;
      if (m.type === "log") logs = tail(logs + m.text + "\n", CODE_OUTPUT_CHARS);
      else if (m.type === "done") {
        if (m.ok) result = m.value;
        finish(m.ok ? "ok" : "error", m.error);
      } else if (m.type === "call") {
        if (typeof m.op !== "string" || m.args === null || typeof m.args !== "object" || Array.isArray(m.args)) return;
        const op = Object.hasOwn(ops, m.op) ? ops[m.op] : undefined;
        const entry = { tool: TOOL[m.op] ?? m.op, summary: summary(m.op, m.args), ok: false };
        try {
          if (!op) throw new Error(`unknown function ${m.op}`);
          const value = await op(m.args);
          entry.ok = true;
          if (!ended) child.send({ type: "reply", id: m.id, ok: true, value });
        } catch (e) {
          if (e instanceof Denied && e.message === "limit") return; // a refused call is not a call
          if (!(e instanceof Denied) && !ended) child.send({ type: "reply", id: m.id, ok: false, error: (e as Error).message });
        } finally {
          if (!calls.includes(entry) && !(limit === "calls" && !entry.ok)) calls.push(entry);
        }
      }
    });
    child.send({ type: "run", code });
  });

  clearTimeout(timer);
  o.signal?.removeEventListener("abort", onAbort);
  let text = JSON.stringify(result ?? null);
  const truncated = text.length > CODE_OUTPUT_CHARS;
  return {
    status,
    ...(limit && { limit }),
    ...(error && { error }),
    result: truncated ? tail(text, CODE_OUTPUT_CHARS) : result,
    ...(truncated && { truncated }),
    logs,
    calls,
    filesChanged: [...changed],
    durationMs: Date.now() - t0,
  };
}
