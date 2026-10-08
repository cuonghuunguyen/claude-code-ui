// Web Push (docs/spec.md "Push notifications"): VAPID keys and subscriptions in the config dir, same rules as Orca (MIT; behaviour only, no code).
// The payload is encrypted for the subscribing browser only (ADR 0003); the push service sees ciphertext.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import type { Event, Part, PushPayload, SessionState, WebPushSubscription } from "@claude-ui/protocol";
import { configDir } from "./token.ts";

export const FINISH_DELAY_MS = 1500;
export const MIN_GAP_MS = 5000;
/** Web Push allows ~4 KB of plaintext per message. */
export const MAX_PAYLOAD_BYTES = 3800;
const SUBJECT = process.env.CLAUDE_UI_VAPID_SUBJECT ?? "https://github.com/cuonghuunguyen/claude-code-ui";

type PendingPart = Extract<Part, { type: "permission_request" | "question" }>;
type Tracked = { state: SessionState; text?: string; error?: string; request?: PendingPart; timer?: ReturnType<typeof setTimeout>; lastSent: number; escalated: Set<string>; /** The group this session's last push counted it in (groups below). */ group?: string };
/** Workers of one coordinator blocked on the same request share one notification (tag) that counts them. */
type Group = { tag: string; what: string; members: Set<string>; shown: boolean; title: string };
/** What a push adds to the plain `(sessionId, body)`: the notification's tag, silence and replace-only flags, and whose title it carries. */
export type PushExtra = { tag?: string; silent?: boolean; replace?: boolean; titleSession?: string };

/**
 * Turns session events into pushes: "needs input" at once, "finished" (an error counts) 1.5 s after the turn ends unless
 * work resumes or background tasks still run, at most one per session per 5 s (an escalated request pushes at once), none while `suppressed` (a focused, visible tab shows the session).
 * An escalated request that settles (answered, stopped, cancelled) calls `replace` once, at once, also while `suppressed`: its notification must not stay.
 */
export function createNotifier(opts: {
  push: (sessionId: string, body: string, extra?: PushExtra) => void;
  suppressed: (sessionId: string) => boolean;
  /** An earlier notification (`tag`: its group's; absent: the session's) no longer applies: the daemon replaces it with a silent one. */
  replace?: (sessionId: string, body: string, tag?: string) => void;
  /** The coordinator of a worker session, undefined for any other: workers of one coordinator blocked on the same request group (GH-163). */
  group?: (sessionId: string) => string | undefined;
}) {
  const sessions = new Map<string, Tracked>();
  const groups = new Map<string, Group>();
  const countBody = (g: Group) => (g.members.size === 1 ? `Needs input · ${g.what}` : `${g.members.size} workers need input · ${short(g.what)}`);

  /** A needs-input push of a worker joins its request's group: one tag, a count in the body; true when a push went out. */
  function fireGrouped(id: string, t: Tracked, body: string, force: boolean) {
    const coordinator = opts.group?.(id);
    if (coordinator === undefined || !t.request) return fire(id, t, body, force);
    const key = `${coordinator}\u0000${describe(t.request)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { tag: `req-${createHash("sha1").update(key).digest("hex").slice(0, 16)}`, what: describe(t.request), members: new Set(), shown: false, title: coordinator }));
    const had = g.members.has(id);
    g.members.add(id);
    t.group = key;
    if ((had && !force) || opts.suppressed(id)) return false;
    const n = g.members.size;
    // The first push keeps the 5 s gap; a later one only changes the count of the notification already there.
    if (n === 1 && !force && Date.now() - t.lastSent < MIN_GAP_MS) return false;
    t.lastSent = Date.now();
    opts.push(id, n === 1 ? body : countBody(g), { tag: g.tag, titleSession: g.title, ...(n > 1 && { silent: true, replace: true }) });
    g.shown = true;
    return true;
  }

  /** The session no longer waits on its request: the group's notification shows the new count, or goes when it was the last. True when it had a group. */
  function leave(id: string, t: Tracked) {
    const key = t.group;
    t.group = undefined;
    const g = key === undefined ? undefined : groups.get(key);
    if (!g || !g.members.delete(id)) return false;
    if (g.members.size === 0) groups.delete(key!);
    if (g.shown) {
      if (g.members.size === 0) opts.replace?.(id, `No longer needs input · ${clip(g.what, 200)}`, g.tag);
      else opts.push([...g.members].at(-1)!, countBody(g), { tag: g.tag, titleSession: g.title, silent: true, replace: true });
    }
    return true;
  }

  /** True when a push went out. */
  function fire(id: string, t: Tracked, body: string, force = false) {
    if (opts.suppressed(id) || (!force && Date.now() - t.lastSent < MIN_GAP_MS)) return false;
    t.lastSent = Date.now();
    opts.push(id, body);
    return true;
  }

  return {
    observe({ sessionId: id, part }: Event) {
      let t = sessions.get(id);
      if (!t) sessions.set(id, (t = { state: "idle", lastSent: -Infinity, escalated: new Set() }));
      if (part.type === "user_text") t.text = t.error = undefined;
      else if (part.type === "assistant_text") t.text = part.text;
      else if (part.type === "raw" && (part.message as { error?: unknown })?.error) t.error = String((part.message as { error: unknown }).error);
      else if (part.type === "permission_request" || part.type === "question") {
        t.request = part.settled ? undefined : part;
        // A grouped worker's notification is replaced through its group (leave), not through the session tag.
        if (part.settled && leave(id, t)) t.escalated.delete(part.requestId);
        // One push per request (escalate refuses a second call); only a focused tab of this (worker) session suppresses it.
        // Only a push that went out is replaced later: a replacement for a notification never shown would show itself.
        if (!part.settled && part.escalated && !t.escalated.has(part.requestId)) {
          if (fireGrouped(id, t, `Needs input · Escalated by coordinator: ${clip(part.reason ?? "", 200)} · ${describe(part)}`, true)) t.escalated.add(part.requestId);
        } else if (part.settled && t.escalated.delete(part.requestId))
          opts.replace?.(id, `No longer needs input · ${part.type === "question" ? (part.answers ? "answered" : "cancelled") : (part.decision ?? "settled")} · ${clip(describe(part), 200)}`);
      }
      if (part.type !== "session_state") return;
      const busy = t.state === "running" || t.state === "needs_input";
      t.state = part.state;
      clearTimeout(t.timer);
      if (part.state !== "needs_input") leave(id, t);
      if (part.state === "needs_input") fireGrouped(id, t, `Needs input · ${t.request ? describe(t.request) : "waiting for an answer"}`, false);
      else if ((part.state === "error" || (part.state === "idle" && !part.working)) && busy) {
        const body = t.error ? `Error · ${t.error}` : (lastLine(t.text) ?? "Finished");
        t.timer = setTimeout(() => fire(id, t, body), FINISH_DELAY_MS);
      }
    },
  };
}

/** A path in `what` cut to its last two segments: "Read: …/implement-issue/SKILL.md". */
const short = (what: string) => what.replace(/(\S*[\\/])([^\\/\s]+[\\/][^\\/\s]+)$/, "…/$2");

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

/** Runs a command without a shell: argv only. `execFile`, replaced in tests. */
export type Run = (file: string, args: string[], opts: { timeout: number; windowsHide: boolean }, cb: (err: Error | null) => void) => unknown;

// Session text comes from Claude (Bash commands, paths): it reaches the command only as argv data, never as shell or script source.
const clip = (s: string, n: number) => {
  const c = Array.from(s); // code points: a surrogate pair is never split
  return c.length > n ? `${c.slice(0, n - 1).join("")}…` : s;
};
const xmlText = (s: string) =>
  s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
/** Windows PowerShell's own AppUserModelID: the toast shows as "Windows PowerShell" without registering an app. */
const PS_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/** The command and argv that show `title`/`body` as a desktop notification on `platform`. */
export function osNotifyCommand({ title, body }: { title: string; body: string }, platform: NodeJS.Platform): [string, string[]] {
  title = clip(title, 100);
  body = clip(body, 500);
  if (platform === "darwin")
    return ["osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", title, body]];
  if (platform === "win32") {
    // The XML is base64 inside the script: no text of the session is PowerShell source (PowerShell also ends a '…' string at ’ ‘).
    const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlText(title)}</text><text>${xmlText(body)}</text></binding></visual></toast>`;
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
      "$x = New-Object Windows.Data.Xml.Dom.XmlDocument",
      `$x.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(xml).toString("base64")}')))`,
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${PS_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
    ].join("\n");
    return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]];
  }
  // "--": a title or body starting with "-" (a Markdown list line) is text, not an option.
  return ["notify-send", ["--app-name=claude-ui", "--", title, body]];
}

/** Shows a desktop notification on the daemon's machine; rejects when the command is missing or fails. */
export function osNotify(p: { title: string; body: string }, platform = process.platform, run: Run = execFile as unknown as Run) {
  const [file, args] = osNotifyCommand(p, platform);
  return new Promise<void>((resolve, reject) => run(file, args, { timeout: 10_000, windowsHide: true }, (err) => (err ? reject(err) : resolve())));
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
export function createPush({ dir = configDir(), send = webpush.sendNotification, notify = osNotify }: { dir?: string; send?: typeof webpush.sendNotification; notify?: ((p: PushPayload) => Promise<unknown>) | false } = {}) {
  const keyFile = join(dir, "vapid.json");
  const subFile = join(dir, "push-subscriptions.json");
  let keys = readJson<{ publicKey: string; privateKey: string }>(keyFile);
  if (!keys) writeFileSync(keyFile, JSON.stringify((keys = webpush.generateVAPIDKeys())), { mode: 0o600 });
  let subs = readJson<WebPushSubscription[]>(subFile) ?? [];
  const save = () => writeFileSync(subFile, JSON.stringify(subs), { mode: 0o600 });
  const vapidDetails = { subject: SUBJECT, ...keys };
  let notifyFailed = false;
  let notifyMissing = false;

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
      // No browser takes a push (plain-HTTP --lan tab, push off, no Web Push): the daemon's machine shows it.
      // Logged once; a missing command (ENOENT) is not called again, other failures are retried.
      if (!subs.length) {
        // An OS toast cannot be withdrawn: a replacement would only show a second one.
        if (payload.replace) return;
        if (notify && !notifyMissing)
          await notify(payload).catch((e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") notifyMissing = true;
            if (!notifyFailed) (notifyFailed = true), console.error(`desktop notification failed (${e.code ?? "error"}); further failures are not logged`);
          });
        return;
      }
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
