// What a docs scene declares. Typed against the protocol, so a wire change breaks `npm run typecheck`.
import type { Event, ListResult, Part, ServerMessage, SessionListItem, SubscribeResult } from "@claude-ui/protocol";
import { TIMELINE_EXCLUDED } from "@claude-ui/protocol";
import type { Page } from "@playwright/test";

export type Theme = "light" | "dark";

export type SceneSession = { info: SessionListItem; parts: Part[] };

export type Scene = {
  /** Default 1440x900. */
  viewport?: { width: number; height: number };
  /** Default ["light"]; each one makes a PNG (`<name>-dark.png` for dark). */
  themes?: Theme[];
  /** localStorage seeded before the app boots (the guide and theme keys are added for you). */
  storage?: Record<string, string>;
  /** The URL hash the app opens: `#new`, `#focus` or `#<session id>`. */
  hash: string;
  sessions: SceneSession[];
  projects: string[];
  worktrees?: ListResult["worktrees"];
  /** Replies by request type, over the defaults in demo.ts; a function gets the request. Unknown types resolve `{}` with a console warning. */
  replies?: Record<string, unknown | ((req: { type: string; [k: string]: unknown }) => unknown)>;
  /** Server messages pushed once the connection is open, in order. */
  events?: ServerMessage[];
  /** Shell output a terminal attach replays, by terminal id; the scene's `terminal.list` reply comes from the keys. */
  terminals?: Record<string, { title: string; output: string }>;
  /** Playwright steps before the capture (open a menu, ...). */
  steps?: (page: Page) => Promise<void>;
  /** CSS selector to capture instead of the whole viewport. */
  clip?: string;
};

/** The snapshot a paged subscribe replies: state-like parts as heads, the rest as the page. */
export function subscribeReply({ info, parts }: SceneSession): SubscribeResult {
  const ev = (part: Part, i: number): Event => ({ type: "event", sessionId: info.id, seq: i + 1, part });
  const events = parts.map(ev);
  const { id, cwd, state, model, permissionMode, effort, permissionModes } = info;
  return {
    logEpoch: "scene",
    seq: events.length,
    session: { id, cwd, state, model, permissionMode, effort, permissionModes },
    title: info.title,
    snapshot: {
      heads: events.filter((e) => TIMELINE_EXCLUDED.has(e.part.type)),
      attentionSeq: events.length,
      page: { parts: parts.filter((p) => !TIMELINE_EXCLUDED.has(p.type)) },
      aux: [],
    },
  };
}
