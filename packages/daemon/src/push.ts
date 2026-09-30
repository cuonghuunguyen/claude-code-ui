// Web Push (docs/spec.md "Push notifications"): VAPID keys and subscriptions in the config dir, rules copied from Orca.
// The payload is encrypted for the subscribing browser only (ADR 0003); the push service sees ciphertext.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import type { Event, Part, PushPayload, SessionState, WebPushSubscription } from "@claude-ui/protocol";
import { configDir } from "./token.ts";

export const FINISH_DELAY_MS = 1500;
export const MIN_GAP_MS = 5000;
/** Web Push allows ~4 KB of plaintext per message. */
export const MAX_PAYLOAD_BYTES = 3800;
const SUBJECT = process.env.CLAUDE_UI_VAPID_SUBJECT ?? "https://github.com/cuonghuunguyen/claude-ui";

type PendingPart = Extract<Part, { type: "permission_request" | "question" }>;
type Tracked = { state: SessionState; text?: string; error?: string; request?: PendingPart; timer?: ReturnType<typeof setTimeout>; lastSent: number };

/**
 * Turns session events into pushes: "needs input" at once, "finished" (an error counts) 1.5 s after the turn ends unless
 * work resumes, at most one per session per 5 s, none while `suppressed` (a focused, visible tab shows the session).
 */
export function createNotifier(opts: { push: (sessionId: string, body: string) => void; suppressed: (sessionId: string) => boolean }) {
  const sessions = new Map<string, Tracked>();

  function fire(id: string, t: Tracked, body: string) {
    if (opts.suppressed(id) || Date.now() - t.lastSent < MIN_GAP_MS) return;
    t.lastSent = Date.now();
    opts.push(id, body);
  }

  return {
    observe({ sessionId: id, part }: Event) {
      let t = sessions.get(id);
      if (!t) sessions.set(id, (t = { state: "idle", lastSent: -Infinity }));
      if (part.type === "user_text") t.text = t.error = undefined;
      else if (part.type === "assistant_text") t.text = part.text;
      else if (part.type === "raw" && (part.message as { error?: unknown })?.error) t.error = String((part.message as { error: unknown }).error);
      else if (part.type === "permission_request" || part.type === "question") t.request = part.settled ? undefined : part;
      if (part.type !== "session_state") return;
      const busy = t.state === "running" || t.state === "needs_input";
      t.state = part.state;
      clearTimeout(t.timer);
      if (part.state === "needs_input") fire(id, t, `Needs input · ${t.request ? describe(t.request) : "waiting for an answer"}`);
      else if ((part.state === "idle" || part.state === "error") && busy) {
        const body = t.error ? `Error · ${t.error}` : (lastLine(t.text) ?? "Finished");
        t.timer = setTimeout(() => fire(id, t, body), FINISH_DELAY_MS);
      }
    },
  };
}

/** "Bash: npm test": the tool and its command, path or input; a question's text. */
function describe(p: PendingPart) {
  if (p.type === "question") return p.questions.map((q) => q.question).join(" ");
  const { tool, input } = p;
  const i = (input ?? {}) as Record<string, unknown>;
  const detail = i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern;
  return `${tool}: ${typeof detail === "string" ? detail : JSON.stringify(input)}`;
}

const lastLine = (text?: string) => text?.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);

/** Truncates the text so the JSON payload stays within MAX_PAYLOAD_BYTES. */
export function fitPayload(p: PushPayload): PushPayload {
  const out = { ...p, title: p.title.length > 200 ? `${p.title.slice(0, 199)}…` : p.title };
  while (Buffer.byteLength(JSON.stringify(out)) > MAX_PAYLOAD_BYTES) out.body = `${out.body.slice(0, Math.floor(out.body.length * 0.9))}…`;
  return out;
}

const isSubscription = (s: unknown): s is WebPushSubscription => {
  const x = s as WebPushSubscription | null;
  try {
    return typeof x?.keys?.p256dh === "string" && typeof x.keys.auth === "string" && new URL(x.endpoint).protocol === "https:";
  } catch {
    return false;
  }
};

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** Owns the VAPID key pair (generated on first run) and the stored subscriptions. `send` is web-push's, replaced in tests. */
export function createPush({ dir = configDir(), send = webpush.sendNotification }: { dir?: string; send?: typeof webpush.sendNotification } = {}) {
  const keyFile = join(dir, "vapid.json");
  const subFile = join(dir, "push-subscriptions.json");
  let keys = readJson<{ publicKey: string; privateKey: string }>(keyFile);
  if (!keys) writeFileSync(keyFile, JSON.stringify((keys = webpush.generateVAPIDKeys())), { mode: 0o600 });
  let subs = readJson<WebPushSubscription[]>(subFile) ?? [];
  const save = () => writeFileSync(subFile, JSON.stringify(subs), { mode: 0o600 });
  const vapidDetails = { subject: SUBJECT, ...keys };

  return {
    publicKey: keys.publicKey,
    /** Stores (or replaces, by endpoint) a browser subscription. False when it is malformed or not https. */
    subscribe(s: unknown) {
      if (!isSubscription(s)) return false;
      const { endpoint, keys } = s;
      subs = [...subs.filter((x) => x.endpoint !== endpoint), { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }];
      save();
      return true;
    },
    async send(payload: PushPayload) {
      const body = JSON.stringify(fitPayload(payload));
      await Promise.all(
        subs.map((s) =>
          send(s, body, { vapidDetails, TTL: 86_400, urgency: "high" }).catch((e: { statusCode?: number }) => {
            // Gone: the browser unsubscribed (toggle off) or expired it. The endpoint is a capability URL: never log it.
            if (e.statusCode === 404 || e.statusCode === 410) (subs = subs.filter((x) => x !== s)), save();
            else console.error(`push failed: ${e.statusCode ?? (e as Error).message}`);
          }),
        ),
      );
    },
  };
}

export type Push = ReturnType<typeof createPush>;
