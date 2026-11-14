// Allow and retry (GH-711): one-shot approval of a call the auto mode classifier denied.

const SHELLS = new Set(["Bash", "PowerShell"]);
const INPUT_CAP = 4000;

/** Key stable over a rewritten `description`, `timeout` and `run_in_background` of a shell call; the same call retried matches. */
export function retryKey(tool: string, input: unknown): string {
  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
  if (SHELLS.has(tool)) return `${tool}\0${typeof obj?.command === "string" ? obj.command : ""}`;
  if (obj) {
    const { description: _, ...rest } = obj;
    return `${tool}\0${stable(rest)}`;
  }
  return `${tool}\0${stable(input)}`;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

function fenced(tool: string, input: unknown): string {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  let body = SHELLS.has(tool) && typeof obj?.command === "string" ? obj.command : (JSON.stringify(input, null, 2) ?? "");
  if (body.length > INPUT_CAP) body = `${body.slice(0, INPUT_CAP)}\n… (truncated)`;
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${body}\n${fence}`;
}

/** The user message that asks Claude to run the denied call again. */
export function followUp(tool: string, input: unknown): string {
  return `Auto mode denied your ${tool} call. I allow it once. Run it again with the same input:\n${fenced(tool, input)}`;
}

/** Always allow (GH-756): the same, naming the saved rule and its scope. */
export function followUpAlways(tool: string, input: unknown, rule: string, scope: "session" | "local"): string {
  const where = scope === "session" ? "this session" : "this project";
  return `Auto mode denied your ${tool} call. I added the allow rule \`${rule}\` for ${where}. Run it again with the same input:\n${fenced(tool, input)}`;
}

/** Armed approvals: each `take` of a key consumes one `arm`. */
export class OneShots {
  private readonly armed: string[] = [];
  get size() {
    return this.armed.length;
  }
  arm(key: string) {
    this.armed.push(key);
  }
  take(key: string): boolean {
    const i = this.armed.indexOf(key);
    if (i < 0) return false;
    this.armed.splice(i, 1);
    return true;
  }
  clear() {
    this.armed.length = 0;
  }
}

/** A refused Allow and retry; `code` is the wire error code. */
export class DeniedRetryError extends Error {
  constructor(
    readonly code: "unknown_call" | "unsupported" | "session_not_live" | "bash_running" | "session_busy" | "no_rule" | "ignored_in_auto" | "managed_only" | "check_failed" | "settings_write_failed",
    message: string,
  ) {
    super(message);
  }
}
