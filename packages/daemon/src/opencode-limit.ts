/**
 * OpenCode's provider usage / rate limits (GH-973): when its own retries are over (the turn ends with a 429), which failures are a
 * "limit stop" for the auto-continue scheduler, and when the limit resets. Pure: the engines call it at the failure of a turn.
 *
 * Reset time, in OpenCode's own order (opencode/src/session/retry.ts): `retry-after-ms`, then `retry-after` (seconds or an HTTP date).
 * A 429 is a limit stop when the reset wait is at least MIN_WAIT_MS (a per-minute rate limit sends a short retry-after too), or when the body
 * names a usage limit (FreeUsageLimitError / GoUsageLimitError; with its reset time when known, else without). Else a plain error.
 */
export const MIN_WAIT_MS = 5 * 60_000;
export type LimitStop = { resetsAt?: number };

const USAGE_LIMIT = /FreeUsageLimitError|GoUsageLimitError/;

const header = (h: Record<string, unknown> | undefined, name: string): string | undefined => {
  if (!h) return undefined;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name);
  const v = key === undefined ? undefined : h[key];
  return typeof v === "string" || typeof v === "number" ? String(v).trim() : undefined;
};

/** The reset time (ms epoch) the headers give, only when after `now`. */
export function resetOfHeaders(h: Record<string, unknown> | undefined, now: number): number | undefined {
  const ms = Number(header(h, "retry-after-ms"));
  let at: number | undefined;
  if (header(h, "retry-after-ms") && Number.isFinite(ms)) at = now + ms;
  else {
    const ra = header(h, "retry-after");
    if (ra) {
      const s = Number(ra);
      at = Number.isFinite(s) ? now + s * 1000 : Date.parse(ra);
    }
  }
  return at !== undefined && Number.isFinite(at) && at > now ? Math.round(at) : undefined;
}

const result = (resetsAt: number | undefined, body: unknown, now: number): LimitStop | undefined => {
  const marked = typeof body === "string" && USAGE_LIMIT.test(body);
  if (resetsAt !== undefined && (marked || resetsAt - now >= MIN_WAIT_MS)) return { resetsAt };
  return marked ? {} : undefined;
};

/** OpenCode 1: the `error` of `session.error`. */
export function limitOfApiError(error: { name?: string; data?: Record<string, any> } | undefined, now: number): LimitStop | undefined {
  if (error?.name !== "APIError" || error.data?.statusCode !== 429) return undefined;
  return result(resetOfHeaders(error.data.responseHeaders, now), error.data.responseBody, now);
}

/** OpenCode 2: the `error` of `session.execution.failed` (`{type, message, status?, response?: {body}, retryAfterMs?}`). */
export function limitOfFailure(error: { type?: string; status?: number; response?: { body?: unknown }; retryAfterMs?: number } | undefined, now: number): LimitStop | undefined {
  if (!error) return undefined;
  if (error.status !== 429 && !/rate_limit/i.test(error.type ?? "")) return undefined;
  const ms = typeof error.retryAfterMs === "number" && error.retryAfterMs > 0 ? now + error.retryAfterMs : undefined;
  const body = error.response?.body;
  return result(ms === undefined ? undefined : Math.round(ms), typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body), now);
}
