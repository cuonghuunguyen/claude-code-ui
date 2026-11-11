// OpenCode error texts (GH-683): cut from the recorded events of OpenCode 1.19.5 (rate limit, model not found, provider 404).
import { describe, expect, it } from "vitest";
import { errorKey, errorText } from "../src/opencode-errors.ts";

const missing = { name: "UnknownError", data: { message: "Model not found: stub/nope." } };
const missingWithStack = {
  name: "UnknownError",
  data: { message: "ProviderModelNotFoundError: Model not found: stub/nope.\n    at <anonymous> (<path>/chunk-a.js:2:64699)\n    at SessionPrompt.getModel (<path>/chunk-b.js:50:11031)" },
};
const limited = { name: "APIError", data: { message: "Rate limit reached for m1", statusCode: 429, isRetryable: true, responseBody: '{"error":{"type":"rate_limit_error"}}' } };
const notFound = {
  name: "APIError",
  data: { message: "The model `m1` does not exist or you do not have access to it.", statusCode: 404, isRetryable: false, responseBody: '{"error":{"code":"model_not_found"}}' },
};

describe("OpenCode error text (GH-683)", () => {
  it("model not found: the model id and what to do, no stack and no error name", () => {
    const a = errorText(missing, {});
    const b = errorText(missingWithStack, {});
    expect(a).toBe(b);
    expect(a).toContain("stub/nope");
    expect(a).toContain("Settings › OpenCode");
    expect(a).not.toContain("\n");
    expect(a).not.toContain("ProviderModelNotFoundError");
    expect(errorKey(missing)).toBe(errorKey(missingWithStack));
  });

  it("an API error has its message and HTTP status; with attempts it says OpenCode gave up after them", () => {
    expect(errorText(limited, {})).toBe("Rate limit reached for m1 (HTTP 429)");
    const text = errorText(limited, { attempts: 5 });
    expect(text).toContain("Rate limit reached for m1");
    expect(text).toContain("HTTP 429");
    expect(text).toContain("5 retries");
    expect(errorText(limited, { attempts: 1 })).toContain("1 retry.");
  });

  it("a 404 model_not_found names the model as not available", () => {
    const text = errorText(notFound, { model: "stub/m1" });
    expect(text).toContain("stub/m1");
    expect(text).toContain("not available");
    expect(text).toContain("HTTP 404");
    expect(errorText({ name: "APIError", data: { message: "gone", statusCode: 404 } }, { model: "stub/m1" })).toContain("not available");
  });

  it("an unknown shape falls back to the name, then a generic text", () => {
    expect(errorText({ name: "WeirdError" }, {})).toBe("WeirdError");
    expect(errorText({ name: "", data: {} }, {})).toBe("OpenCode reported an error");
    expect(errorText(undefined, {})).toBe("OpenCode reported an error");
    expect(errorText({ name: "UnknownError", data: { message: "Boom: it broke\n    at x (y.js:1:1)" } }, {})).toBe("Boom: it broke");
  });
});
