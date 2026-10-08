// Materialized view of a session's event log (docs/spec.md "Event log and sequence numbers", paged subscribe): the same fold the
// client's applyEvent does, kept so the daemon can send whole-turn pages instead of replaying every delta.
import { isAttention, PAGE_PARTS, PAGE_TURNS, TIMELINE_EXCLUDED } from "@claude-ui/protocol";
import type { Event, Part, PosPart, SessionState, TimelinePage } from "@claude-ui/protocol";

type Entry = { part: Part; pos: number; seq: number };
const HEAD_TYPES = new Set<Part["type"]>(["session_state", "commands", "context_usage", "external_turn", "auto_continue", "todo_update"]);
const EDIT_TOOLS = new Set(["Edit", "Write"]);

export class PartIndex {
  private order: string[] = [];
  private byId = new Map<string, Entry>();
  private headEvents = new Map<Part["type"], Event>();
  private state: SessionState = "idle";
  /** Seq of the last "needs input" or "finished" (same rule as the client store). */
  attentionSeq = 0;

  /** Folds one event (seq set); returns the existing pos for an update of a timeline part, else undefined. */
  apply(e: Event): number | undefined {
    const { part } = e;
    if (HEAD_TYPES.has(part.type)) {
      if (part.type === "session_state") {
        if (isAttention(this.state, part)) this.attentionSeq = e.seq;
        this.state = part.state;
      }
      this.headEvents.set(part.type, e);
      return undefined;
    }
    if (part.type === "rewind") {
      const at = this.order.indexOf(part.userMessageId);
      if (at >= 0) {
        for (const id of this.order.slice(at)) this.byId.delete(id);
        this.order.length = at;
      }
      this.headEvents.delete("todo_update");
      return undefined;
    }
    if (part.type === "retract") {
      const gone = new Set(part.partIds);
      gone.forEach((id) => this.byId.delete(id));
      this.order = this.order.filter((id) => !gone.has(id));
      return undefined;
    }
    if (TIMELINE_EXCLUDED.has(part.type)) return undefined;
    const known = this.byId.get(part.id);
    if (known) {
      known.part = part;
      known.seq = e.seq;
      return known.pos;
    }
    this.byId.set(part.id, { part, pos: e.seq, seq: e.seq });
    this.order.push(part.id);
    return undefined;
  }

  /** Latest session_state, commands, context_usage, external_turn, auto_continue and todo_update events, by seq. */
  heads(): Event[] {
    return [...this.headEvents.values()].sort((a, b) => a.seq - b.seq);
  }

  private part(i: number) {
    return this.byId.get(this.order[i]!)!;
  }

  private isTurnStart(i: number) {
    const p = this.part(i).part;
    return p.type === "user_text" && !p.parentId;
  }

  /** Index of the turn start at or before `i` (0 when none: turn 0). */
  private turnStart(i: number) {
    while (i > 0 && !this.isTurnStart(i)) i--;
    return i;
  }

  private page(start: number, end: number): TimelinePage {
    const parts: Part[] = [];
    for (let i = start; i < end; i++) parts.push(this.part(i).part);
    return start > 0 ? { parts, older: { before: this.order[start]!, pos: this.part(start).pos } } : { parts };
  }

  private pageEnding(end: number, until?: string): TimelinePage {
    let start = end;
    for (let turns = 0; start > 0 && turns < PAGE_TURNS && end - start < PAGE_PARTS; turns++) start = this.turnStart(start - 1);
    if (until !== undefined) {
      const m = this.order.findIndex((id, i) => i < end && (id === until || id.startsWith(`${until}:`)));
      if (m >= 0) start = Math.min(start, this.turnStart(m));
    }
    return this.page(start, end);
  }

  lastPage(): TimelinePage {
    return this.pageEnding(this.order.length);
  }

  /** The turn of `id` to the end; undefined when `id` is unknown or that is more than `cap` parts. */
  pageFrom(id: string, cap: number): TimelinePage | undefined {
    const i = this.order.indexOf(id);
    if (i < 0) return undefined;
    const start = this.turnStart(i);
    return this.order.length - start > cap ? undefined : this.page(start, this.order.length);
  }

  /** The page before the part `before`; undefined when it is unknown (an unknown cursor). */
  pageBefore(before: string, until?: string): TimelinePage | undefined {
    const end = this.order.indexOf(before);
    return end < 0 ? undefined : this.pageEnding(end, until);
  }

  /** First seq of a part, undefined when unknown. */
  posOf(id: string): number | undefined {
    return this.byId.get(id)?.pos;
  }

  /** Parts before `beforePos` that whole-session features need: subagents, turn results, running background Bash calls. */
  aux(beforePos: number): PosPart[] {
    return this.scan(beforePos, (p) => p.type === "subagent" || p.type === "turn_result" || (p.type === "tool_call" && p.tool === "Bash" && p.status === "running" && (p.input as { run_in_background?: unknown } | null)?.run_in_background === true));
  }

  /** Edit/Write calls before `beforePos` and their results. */
  edits(beforePos: number): PosPart[] {
    const calls = new Set<string>();
    return this.scan(beforePos, (p) => {
      if (p.type === "tool_call" && EDIT_TOOLS.has(p.tool)) return !!calls.add(p.toolUseId);
      return p.type === "tool_result" && calls.has(p.toolUseId);
    });
  }

  private scan(beforePos: number, keep: (p: Part) => boolean): PosPart[] {
    const out: PosPart[] = [];
    for (const id of this.order) {
      const e = this.byId.get(id)!;
      if (e.pos >= beforePos) break;
      if (keep(e.part)) out.push({ part: e.part, pos: e.pos });
    }
    return out;
  }
}
