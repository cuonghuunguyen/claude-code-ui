// Child sessions of one OpenCode 2 session (docs/spec.md "OpenCode 2 adapter"): a `subagent` call's session (and, nested, its own subagents') shows its parts
// under the call. One registry per session: child id -> the call it runs for and a mapper of its own, so turn usage, denials and shell maps stay per session.
import type { Part } from "@claude-ui/protocol";
import { OpenCode2Mapper } from "./opencode2-parts.ts";

export type ChildKind = "subagent" | "inline";
export type Child = { callId: string; kind: ChildKind; mapper: OpenCode2Mapper };

export class ChildRuns {
  private readonly byChild = new Map<string, Child>();
  private readonly byCall = new Map<string, string>();

  /** Child `childId` runs for call `callId`. A child linked before keeps its mapper (a re-read of the history links it again). */
  link(childId: string, callId: string, kind: ChildKind = "subagent"): Child {
    const known = this.byChild.get(childId);
    if (known) return known;
    const child = { callId, kind, mapper: new OpenCode2Mapper() };
    this.byChild.set(childId, child);
    this.byCall.set(callId, childId);
    return child;
  }
  get = (childId: string) => this.byChild.get(childId);
  entries = (): Iterable<[string, Child]> => this.byChild.entries();
  /** The child session of call `callId`. */
  childOf = (callId: string) => this.byCall.get(callId);
  /** The mapper of every child (a child's own background shells live there). */
  mappers = (): Iterable<OpenCode2Mapper> => [...this.byChild.values()].map((c) => c.mapper);
  /** `shell.exited` of shell `shellId`: only the child that owns the shell stores the exit; its card parts come back under that child's call. */
  shellExited(shellId: string, status: string | undefined, exit: number | undefined): Part[] {
    for (const child of this.byChild.values()) {
      if (!child.mapper.hasShell(shellId)) continue;
      return child.mapper.shellExited(shellId, status, exit).map((p) => ({ ...p, parentId: child.callId }));
    }
    return [];
  }
  unlink(childId: string) {
    const child = this.byChild.get(childId);
    if (!child) return;
    this.byChild.delete(childId);
    if (this.byCall.get(child.callId) === childId) this.byCall.delete(child.callId);
  }
}

/** The most events kept per unknown session, how long they wait for its link, and how many sessions are kept at once. */
const EARLY_EVENTS = 200;
const EARLY_MS = 10_000;
const EARLY_SESSIONS = 20;
type Early = { type: string; d: Record<string, any> };

/** Events of a session nobody linked yet (a subagent's, announced by its call a moment later): kept briefly, replayed in order once the link is known. */
export class EarlyEvents {
  private readonly held = new Map<string, { at: number; events: Early[] }>();
  constructor(private readonly now: () => number = Date.now) {}

  add(sid: string, type: string, d: Record<string, any>) {
    this.expire();
    let hit = this.held.get(sid);
    if (!hit) {
      if (this.held.size >= EARLY_SESSIONS) this.held.delete(this.held.keys().next().value!);
      this.held.set(sid, (hit = { at: this.now(), events: [] }));
    }
    if (hit.events.length < EARLY_EVENTS) hit.events.push({ type, d });
  }
  /** The kept events of `sid`, oldest first; they are forgotten. */
  take(sid: string): Early[] {
    this.expire();
    const hit = this.held.get(sid);
    this.held.delete(sid);
    return hit?.events ?? [];
  }
  private expire() {
    for (const [sid, h] of this.held) if (this.now() - h.at > EARLY_MS) this.held.delete(sid);
  }
}
