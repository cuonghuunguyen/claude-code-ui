// The text of an OpenCode error for the user (docs/spec.md "OpenCode engine"): one line, without OpenCode's stack trace, with what to do when the model is missing.
// OpenCode 1.19.5 reports the same failure as `session.error` (first without, then once more after idle with a Bun stack trace) and stores it on the assistant message.

/** An OpenCode error object (`session.error` properties.error, an assistant message's `info.error`). */
export type OpenCodeError = { name?: string; data?: { message?: string; statusCode?: number; responseBody?: string } };

/** The first line of a message: OpenCode appends stack lines (`    at …`) to some errors. */
export const firstLine = (s: string) => s.split("\n")[0]!.trim();

/** The message without the stack and without a leading `SomethingError: ` class name. */
const cleaned = (err: OpenCodeError | undefined) => firstLine(err?.data?.message ?? "").replace(/^[A-Za-z]*Error:\s+/, "");

const MISSING = /^Model not found: (\S+?)\.?$/;
const missingModel = (err: OpenCodeError | undefined) => MISSING.exec(cleaned(err))?.[1];

/** Two errors with the same key are one failure: the duplicate of OpenCode's second `session.error` is dropped. */
export const errorKey = (err: OpenCodeError | undefined) => cleaned(err) || err?.name || "";

/**
 * @param ctx.model the model the turn used (`provider/model`) when known
 * @param ctx.attempts the last retry attempt of the turn: OpenCode gave up after that many retries
 */
export function errorText(err: OpenCodeError | undefined, ctx: { model?: string; attempts?: number }): string {
  const message = cleaned(err);
  const missing = missingModel(err);
  if (missing || err?.name === "ProviderModelNotFoundError")
    return `The model ${missing ?? ctx.model ?? "you picked"} is not available in OpenCode. Pick another model, or connect its provider in Settings › OpenCode.`;
  const status = err?.data?.statusCode;
  if (err?.name === "APIError" && (status === 404 || err.data?.responseBody?.includes("model_not_found")))
    return `The model ${ctx.model ?? "you picked"} is not available: ${message || "not found"} (HTTP ${status ?? 404}). Pick another model.`;
  if (err?.name === "APIError" && status) {
    const head = `${message || "The model provider returned an error"} (HTTP ${status})`;
    return ctx.attempts ? `${head}. OpenCode gave up after ${ctx.attempts} ${ctx.attempts === 1 ? "retry" : "retries"}.` : head;
  }
  return message || err?.name || "OpenCode reported an error";
}
