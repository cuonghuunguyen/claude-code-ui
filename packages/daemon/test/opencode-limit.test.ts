import { describe, expect, it } from "vitest";
import { limitOfApiError, limitOfFailure } from "../src/opencode-limit.ts";

const NOW = Date.parse("2026-11-25T08:00:00Z");
const api = (data: object, name = "APIError") => ({ name, data: { statusCode: 429, ...data } });

// Package contract: the error formats of OpenCode 1 (`APIError`) and OpenCode 2 (`SessionStructuredError`) (GH-973).
describe("opencode-limit: which failures are a limit stop, and when it resets", () => {
  it("OpenCode 1 reset time: retry-after-ms, retry-after seconds, retry-after HTTP date, in OpenCode's order", () => {
    expect(limitOfApiError(api({ responseHeaders: { "retry-after-ms": "1500.5", "retry-after": "60" } }), NOW)).toEqual({ resetsAt: Math.round(NOW + 1500.5) });
    expect(limitOfApiError(api({ responseHeaders: { "Retry-After": "90" } }), NOW)).toEqual({ resetsAt: NOW + 90_000 });
    expect(limitOfApiError(api({ responseHeaders: { "retry-after": "Wed, 25 Nov 2026 13:00:00 GMT" } }), NOW)).toEqual({ resetsAt: Date.parse("2026-11-25T13:00:00Z") });
  });

  it("a reset time in the past or not parsable gives none", () => {
    expect(limitOfApiError(api({ responseHeaders: { "retry-after": "Wed, 25 Nov 2026 07:00:00 GMT" } }), NOW)).toBeUndefined();
    expect(limitOfApiError(api({ responseHeaders: { "retry-after": "soon" } }), NOW)).toBeUndefined();
  });

  it("a usage-limit body without a reset time is a limit stop without resetsAt; a plain 429 and other errors are none", () => {
    expect(limitOfApiError(api({ responseBody: '{"error":{"type":"FreeUsageLimitError"}}' }), NOW)).toEqual({});
    expect(limitOfApiError(api({ responseBody: '{"type":"error","error":{"type":"GoUsageLimitError"}}' }), NOW)).toEqual({});
    expect(limitOfApiError(api({ responseBody: '{"error":{"type":"rate_limit_error"}}' }), NOW)).toBeUndefined();
    expect(limitOfApiError(api({ statusCode: 500, responseHeaders: { "retry-after": "5" } }), NOW)).toBeUndefined();
    expect(limitOfApiError(api({ responseHeaders: { "retry-after": "5" } }, "UnknownError"), NOW)).toBeUndefined();
  });

  it("OpenCode 2: status 429 or a rate-limit type; reset from retryAfterMs; body marker without it", () => {
    expect(limitOfFailure({ type: "provider", status: 429, retryAfterMs: 5000 }, NOW)).toEqual({ resetsAt: NOW + 5000 });
    expect(limitOfFailure({ type: "rate_limit" }, NOW)).toBeUndefined();
    expect(limitOfFailure({ type: "rate_limit", response: { body: "GoUsageLimitError" } }, NOW)).toEqual({});
    expect(limitOfFailure({ status: 429, response: { body: { error: { type: "FreeUsageLimitError" } } } }, NOW)).toEqual({});
    expect(limitOfFailure({ type: "provider", status: 500, retryAfterMs: 5000 }, NOW)).toBeUndefined();
    expect(limitOfFailure(undefined, NOW)).toBeUndefined();
  });
});
