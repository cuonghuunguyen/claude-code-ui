// One sandboxed addon iframe and its bridge (docs/spec.md "Addon host", ADR 0006). The frame has an opaque origin: it is told apart by `event.source`,
// never by origin, and it never receives the token. Every request passes the capability gate (addons.ts) before the host acts.
import { useContext, useEffect, useRef, type CSSProperties } from "react";
import type { Part } from "@claude-ui/protocol";
import { AddonApiContext, gate, type AddonInfo } from "./addons.ts";
import { useColorTheme, useDark } from "./theme.ts";
import { wholeParts, type SessionView } from "./store.ts";

export type AddonRole = "pane" | "band" | "command" | "render";
const MAX_INSERT = 32 * 1024;
const MAX_STATUS = 80;
const MAX_TOAST = 200;

/** Host -> frame. The only `"*"` target: an opaque-origin frame has no other one. */
export const postTo = (frame: HTMLIFrameElement | null, msg: object) => frame?.contentWindow?.postMessage({ v: 1, ...msg }, "*");

export const frameUrl = (addon: AddonInfo, entry: string) => addon.base + entry.split("/").map(encodeURIComponent).join("/");

/** `view`: the id of the view (or "" for a command handler); `session`/`sessionId`: the owner session, whose parts `session.read` returns. */
export function AddonFrame({ addon, entry, role, view, sessionId, session, onHeight, className, style, hidden }: { addon: AddonInfo; entry: string; role: AddonRole; view: string; sessionId: string; session?: SessionView; onHeight?: (px: number) => void; className?: string; style?: CSSProperties; hidden?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const api = useContext(AddonApiContext);
  const theme = useColorTheme();
  const dark = useDark();
  const live = useRef({ session, onHeight, api, theme, dark });
  live.current = { session, onHeight, api, theme, dark };
  // The parts the frame has read: session.parts pushes only the ones that are new or changed since.
  const sent = useRef<Map<string, Part> | undefined>(undefined);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const m = e.data as { v?: unknown; id?: unknown; type?: unknown; text?: unknown; height?: unknown };
      if (!m || m.v !== 1 || typeof m.id !== "string" || typeof m.type !== "string") return;
      const { id, type } = m;
      const done = (result: unknown = {}) => postTo(frame.current, { id, ok: true, result });
      const fail = (code: "refused" | "bad_request" | "unknown", message: string) => (live.current.api.refused(addon.name, type, message), postTo(frame.current, { id, ok: false, error: { code, message } }));
      const g = gate(type, addon.approved);
      if (!g.ok) return fail(g.code, g.message);
      if (type === "ui.ready") {
        if (typeof m.height === "number" && Number.isFinite(m.height)) live.current.onHeight?.(Math.max(24, Math.min(480, Math.round(m.height))));
        return done();
      }
      if (type === "session.read") {
        const parts = live.current.session ? wholeParts(live.current.session) : [];
        sent.current = new Map(parts.map((p) => [p.id, p]));
        return done({ parts });
      }
      if (type === "prompt.insert") {
        if (typeof m.text !== "string" || m.text.length > MAX_INSERT) return fail("bad_request", `text must be a string up to ${MAX_INSERT} characters`);
        live.current.api.insert(sessionId, m.text);
        return done();
      }
      if (type === "ui.status") {
        if (m.text !== null && (typeof m.text !== "string" || m.text.length > MAX_STATUS)) return fail("bad_request", `text must be null or a string up to ${MAX_STATUS} characters`);
        live.current.api.status(sessionId, addon.name, m.text);
        return done();
      }
      if (typeof m.text !== "string" || m.text.length > MAX_TOAST) return fail("bad_request", `text must be a string up to ${MAX_TOAST} characters`);
      live.current.api.toast(addon.name, m.text);
      done();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [addon.name, addon.approved, sessionId]);

  // New or changed parts, after the frame has read the session once.
  useEffect(() => {
    if (!sent.current || !session) return;
    const known = sent.current;
    const changed = wholeParts(session).filter((p) => known.get(p.id) !== p);
    if (!changed.length) return;
    for (const p of changed) known.set(p.id, p);
    postTo(frame.current, { type: "session.parts", parts: changed });
  }, [session]);

  useEffect(() => void postTo(frame.current, { type: "theme.changed", theme, mode: dark ? "dark" : "light" }), [theme, dark]);

  return (
    <iframe
      ref={frame}
      src={frameUrl(addon, entry)}
      sandbox="allow-scripts"
      title={`${addon.name} ${view}`.trim()}
      referrerPolicy="no-referrer"
      loading="lazy"
      onLoad={() => (sent.current = undefined, postTo(frame.current, { type: "init", addon: addon.name, view, role, session: sessionId, theme: live.current.theme, mode: live.current.dark ? "dark" : "light" }))}
      className={className ?? "min-h-0 w-full flex-1 border-0"}
      style={style}
      hidden={hidden}
      data-testid={`addon-frame-${addon.name}-${role}`}
    />
  );
}
