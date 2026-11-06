// Settings › Claude account › Test (GH-627): one minimal CLI turn proves a token (no cheaper CLI call checks it with the server).
export const TEST_ARGS = ["-p", "Reply with OK.", "--model", "haiku", "--max-turns", "1", "--output-format", "json", "--no-session-persistence", "--tools", "", "--system-prompt", "Reply with OK.", "--setting-sources", "", "--strict-mcp-config"];
export const TEST_TIMEOUT_MS = 60_000;

/** The test outcome of the CLI's print result; the token is masked out of any text. */
export function testOutcome(r: { code: number; stdout: string; stderr: string }, token: string): { ok: true } | { ok: false; code: "claude_auth" | "claude_test_failed"; message: string } {
  let res: { is_error?: boolean; api_error_status?: number | null; result?: unknown } | undefined;
  for (const line of r.stdout.split("\n").reverse()) {
    try {
      const j = JSON.parse(line);
      if (j && typeof j === "object") {
        res = j;
        break;
      }
    } catch {
      // not the JSON line
    }
  }
  if (res?.is_error === false) return { ok: true };
  const text = [typeof res?.result === "string" ? res.result : "", r.stderr].flatMap((s) => s.split("\n")).find((l) => l.trim()) ?? `exit ${r.code}`;
  const message = text.trim().replaceAll(token, "***").slice(0, 200);
  return { ok: false, code: res?.api_error_status === 401 || res?.api_error_status === 403 ? "claude_auth" : "claude_test_failed", message };
}
