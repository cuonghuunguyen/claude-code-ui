// The local decision log: one JSONL file with a record per decision and per human label, so
// decisions can be replayed (eval) and mined for rule suggestions (improve). Never inside the
// project; never throws out of a hook. See README "Decision log".
import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LOG_MAX_BYTES = 20 * 1024 * 1024;

export type DecisionOutcome = "replied" | "already-answered" | "failed" | "deferred" | "skipped" | "timeout" | "none";

export interface ClassifierInput {
  transcript: string;
  action: string;
}

export interface DecisionRecord {
  v: 1;
  kind: "decision";
  at: string;
  requestID: string;
  sessionID: string;
  /** Project worktree (the directory, when the project has no git worktree). */
  project: string;
  permission: string;
  patterns: string[];
  /** "provider/model" the classifier ran on, when known. */
  model?: string;
  policyHash: string;
  /** "ask": the classifier was unsure and the human was asked (outcome "deferred"). */
  verdict: "allow" | "block" | "ask" | "none";
  reason: string;
  outcome: DecisionOutcome;
  ms: number;
  /** The exact user-message parts sent to the classifier; absent when it never got that far. */
  input?: ClassifierInput;
}

export interface LabelRecord {
  v: 1;
  kind: "label";
  at: string;
  requestID: string;
  reply: "once" | "always" | "reject";
  /** A sibling of another reply, answered by OpenCode in the same burst (reject cascade, or always): not a human decision. */
  cascade?: true;
}

export type LogRecord = DecisionRecord | LabelRecord;

/** OpenCode's data dir (xdg-basedir: `$XDG_DATA_HOME` else `~/.local/share`, on every OS) + `opencode`. */
export function resolveDataDir(logDir: string | undefined, env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  if (logDir) return logDir;
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode");
}

export function hashPolicy(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
}

const logFile = (dir: string) => join(dir, "auto-mode", "decisions.jsonl");
const rotatedFile = (dir: string) => join(dir, "auto-mode", "decisions.1.jsonl");

export interface LogStore {
  /** Appends one record; never rejects. */
  append(record: LogRecord): Promise<void>;
}

export interface LogStoreOptions {
  dir: string;
  maxBytes: number;
  /** Called with a failure, at most once per hour. */
  onError: (err: unknown) => void;
  /** Test seam. */
  now?: () => number;
}

const LOCK_STALE_MS = 30_000;
const REPORT_EVERY_MS = 60 * 60_000;
const lockFile = (dir: string) => join(dir, "auto-mode", "decisions.lock");

const isCode = (err: unknown, code: string) => (err as NodeJS.ErrnoException)?.code === code;

/** Runs `job` under an exclusive lock file (shared by every OpenCode process using this dir); skips it if someone else holds a fresh lock. */
async function withLock(dir: string, now: () => number, job: () => Promise<void>): Promise<void> {
  const lock = lockFile(dir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.close();
      try {
        await job();
      } finally {
        await rm(lock, { force: true });
      }
      return;
    } catch (err) {
      if (!isCode(err, "EEXIST")) throw err;
      try {
        if (now() - (await stat(lock)).mtimeMs <= LOCK_STALE_MS) return; // another process is rotating
        await rm(lock, { force: true }); // stale: its owner died
      } catch {
        // vanished meanwhile: retry
      }
    }
  }
}

export function createLogStore(opts: LogStoreOptions): LogStore {
  const now = opts.now ?? Date.now;
  let chain: Promise<void> = Promise.resolve();
  let lastReport = -Infinity;

  async function rotate(): Promise<void> {
    await withLock(opts.dir, now, async () => {
      const file = logFile(opts.dir);
      let size = 0;
      try {
        size = (await stat(file)).size; // re-check under the lock: another process may have rotated already
      } catch {
        return;
      }
      if (size <= opts.maxBytes) return;
      await rm(rotatedFile(opts.dir), { force: true });
      try {
        await rename(file, rotatedFile(opts.dir));
      } catch (err) {
        if (!isCode(err, "ENOENT")) throw err;
      }
    });
  }

  async function write(record: LogRecord): Promise<void> {
    const file = logFile(opts.dir);
    const line = JSON.stringify(record) + "\n";
    await mkdir(join(opts.dir, "auto-mode"), { recursive: true, mode: 0o700 });
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      // not created yet
    }
    if (size > 0 && size + Buffer.byteLength(line) > opts.maxBytes) {
      try {
        await rotate();
      } catch {
        // rotation is best-effort; the append below still happens
      }
    }
    await appendFile(file, line, { mode: 0o600 });
  }

  return {
    append(record) {
      chain = chain.then(() =>
        write(record).catch((err) => {
          if (now() - lastReport < REPORT_EVERY_MS) return;
          lastReport = now();
          try {
            opts.onError(err);
          } catch {
            // best-effort
          }
        }),
      );
      return chain;
    },
  };
}

export interface LogContents {
  /** Oldest to newest (rotated file first). */
  decisions: DecisionRecord[];
  /** The latest label per request id. */
  labels: Map<string, LabelRecord>;
}

/** Reads the log and its rotated generation; missing files and malformed lines are skipped. */
export async function readLog(dir: string): Promise<LogContents> {
  const out: LogContents = { decisions: [], labels: new Map() };
  for (const file of [rotatedFile(dir), logFile(dir)]) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue; // missing or unreadable
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec: Partial<LogRecord>;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.kind === "decision" && typeof rec.requestID === "string") out.decisions.push(rec as DecisionRecord);
      else if (rec.kind === "label" && typeof rec.requestID === "string" && typeof rec.reply === "string") out.labels.set(rec.requestID, rec as LabelRecord);
    }
  }
  return out;
}
