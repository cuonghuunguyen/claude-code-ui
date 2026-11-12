// The local decision log: one JSONL file with a record per decision and per human label, so
// decisions can be replayed (eval) and mined for rule suggestions (improve). Never inside the
// project; never throws out of a hook. See README "Decision log".
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
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
  verdict: "allow" | "block" | "none";
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
  /** Called at most once, with the first failure. */
  onError: (err: unknown) => void;
}

export function createLogStore(opts: LogStoreOptions): LogStore {
  let chain: Promise<void> = Promise.resolve();
  let reported = false;

  async function write(record: LogRecord): Promise<void> {
    const file = logFile(opts.dir);
    const line = JSON.stringify(record) + "\n";
    await mkdir(join(opts.dir, "auto-mode"), { recursive: true });
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      // not created yet
    }
    if (size > 0 && size + Buffer.byteLength(line) > opts.maxBytes) {
      await rm(rotatedFile(opts.dir), { force: true });
      await rename(file, rotatedFile(opts.dir));
    }
    await appendFile(file, line, { mode: 0o600 });
  }

  return {
    append(record) {
      chain = chain.then(() =>
        write(record).catch((err) => {
          if (reported) return;
          reported = true;
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
export function readLog(dir: string): LogContents {
  const out: LogContents = { decisions: [], labels: new Map() };
  for (const file of [rotatedFile(dir), logFile(dir)]) {
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
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
