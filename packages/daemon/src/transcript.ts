// Incremental read of a session's JSONL transcript: each read parses only the lines the CLI appended since the last one.
import { readdirSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { SessionMessage, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

/**
 * The restore order of a session's history: each subagent run's messages (they name the Agent call that started it with
 * `parent_tool_use_id`) right after the message of that call's result (else of the call), so a run sits inside its turn as it does live
 * and a page of whole turns holds it with its children. A run whose call is not found goes before the main chain, with the oldest page.
 * `pruneOrphans` (restore): such a run was started before a compaction (the chain restores from its summary), so its subagent part never
 * exists and its parts render nowhere; it and the runs nested in it keep only their Edit/Write calls and results (the changes tab reads
 * them), else a just compacted session's first page would carry every earlier run. The restore still counts every read message as known
 * (`Session.restore` `read`), so a sync does not log the pruned ones. A sync leaves unanchored runs whole: there such a run is a continuing
 * run whose call the session already knows (also an orphan still writing after the restore; its messages render nowhere). A run with no
 * `parent_tool_use_id` at all (not seen from the SDK) counts as an orphan.
 */
export function interleaveRuns(main: SessionMessage[], runs: SessionMessage[][], opts: { pruneOrphans?: boolean } = {}): SessionMessage[] {
  const blocks = (m: SessionMessage) => ((m.message as { content?: unknown } | undefined)?.content ?? []) as { type?: string; id?: string; name?: string; tool_use_id?: string }[];
  const anchor = new Map<string, string>();
  for (const m of [...main, ...runs.flat()]) {
    const content = blocks(m);
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "tool_use" && b.id && !anchor.has(b.id)) anchor.set(b.id, m.uuid);
      // A result is the better anchor: the children follow it, as the adapter saw them before.
      else if (b.type === "tool_result" && b.tool_use_id) anchor.set(b.tool_use_id, m.uuid);
    }
  }
  const placedAt = new Map<string, SessionMessage[][]>();
  let lost: SessionMessage[][] = [];
  for (const run of runs) {
    const call = run.find((m) => m.parent_tool_use_id)?.parent_tool_use_id;
    const at = call ? anchor.get(call) : undefined;
    if (at) placedAt.set(at, [...(placedAt.get(at) ?? []), run]);
    else lost.push(run);
  }
  if (opts.pruneOrphans) {
    // Runs nested in an orphan run are orphans too.
    for (let i = 0; i < lost.length; i++)
      for (const m of lost[i]!) {
        const here = placedAt.get(m.uuid);
        if (here) (placedAt.delete(m.uuid), lost.push(...here));
      }
    lost = lost.map(editsOf).filter((run) => run.length);
  }
  const out: SessionMessage[] = [];
  const emit = (list: SessionMessage[]) => {
    for (const m of list) {
      out.push(m);
      const here = placedAt.get(m.uuid);
      if (here) (placedAt.delete(m.uuid), here.forEach(emit));
    }
  };
  lost.forEach(emit);
  emit(main);
  // Runs anchored in a message no emitted run holds.
  [...placedAt.values()].flat().forEach(emit);
  return out;
}

const EDIT_TOOLS = new Set(["Edit", "Write"]);

/** The Edit/Write calls of a run and their results, each message cut to those blocks. */
function editsOf(run: SessionMessage[]): SessionMessage[] {
  const calls = new Set<string>();
  return run.flatMap((m) => {
    const message = m.message as { content?: unknown } | undefined;
    if (!Array.isArray(message?.content)) return [];
    const content = message.content as { type?: string; id?: string; name?: string; tool_use_id?: string }[];
    const kept = content.filter((b) => (b.type === "tool_use" && b.id && EDIT_TOOLS.has(b.name ?? "") ? !!calls.add(b.id) : b.type === "tool_result" && calls.has(b.tool_use_id ?? "")));
    if (!kept.length) return [];
    return [kept.length === content.length ? m : { ...m, message: { ...message, content: kept } }];
  });
}

/**
 * Parsed lines of one JSONL file, read on from the last read's offset. A cut last line (a write in progress) waits for the
 * next read; a shorter or replaced file is read again from the start. Unparsable lines are skipped, as the SDK does.
 * ponytail: holds every entry in memory while the session is mirrored (a 43 MB transcript: ~100 MB heap).
 */
export class JsonlTail {
  entries: SessionStoreEntry[] = [];
  private offset = 0;
  private ino?: number;

  async read(file: string) {
    const fh = await open(file, "r");
    try {
      const { size, ino } = await fh.stat();
      if (size < this.offset || ino !== this.ino) Object.assign(this, { entries: [], offset: 0, ino });
      if (size === this.offset) return;
      const buf = Buffer.alloc(size - this.offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
      const end = buf.lastIndexOf(10, bytesRead - 1);
      if (end < 0) return;
      for (const l of buf.toString("utf8", 0, end).split("\n")) {
        if (!l.trim()) continue;
        try {
          this.entries.push(JSON.parse(l));
        } catch {
          // Not JSON.
        }
      }
      this.offset += end + 1;
    } finally {
      await fh.close();
    }
  }

  /** A read-only SDK session store over the entries: getSessionMessages() builds the chain without reading the file again. */
  store(): SessionStore {
    return { load: async () => this.entries, append: async () => {} };
  }
}

/**
 * Whether a running Claude Code process reports a turn of this session: each interactive CLI writes
 * `<claudeDir>/sessions/<pid>.json` with its `sessionId` and `status` (`busy`, `waiting` for a permission prompt, `idle`).
 * A file of an exited process stays behind, so the PID must be alive. A CLI without `status` (before 2.1.2xx) counts as not running.
 * `anyStatus`: whether any live CLI process runs the session, idle too (SDK-spawned CLIs write the file as well, entrypoint `sdk-ts`).
 * ponytail: a reused PID of a stale file reads as alive; compare `procStart` if that shows up.
 */
export function cliTurnRunning(claudeDir: string, sessionId: string, anyStatus = false) {
  const dir = join(claudeDir, "sessions");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return false;
  }
  return names.some((n) => {
    try {
      const { pid, sessionId: id, status } = JSON.parse(readFileSync(join(dir, n), "utf8"));
      return id === sessionId && (anyStatus || status === "busy" || status === "waiting") && alive(pid);
    } catch {
      return false;
    }
  });
}

function alive(pid: unknown) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (e) {
    // EPERM: it runs under another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
