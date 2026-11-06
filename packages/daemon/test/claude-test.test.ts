import { expect, it } from "vitest";
import { testOutcome } from "../src/claude-test.ts";

const TOKEN = "sk-ant-oat01-TESTSECRET";
const out = (o: object, code = 1) => ({ code, stdout: JSON.stringify(o), stderr: "" });

it("is ok when the CLI result is not an error", () => {
  expect(testOutcome(out({ is_error: false, result: "OK" }, 0), TOKEN)).toEqual({ ok: true });
});

it("401 and 403 are claude_auth with the CLI text", () => {
  const r = { is_error: true, api_error_status: 401, result: "Failed to authenticate. API Error: 401 OAuth access token is invalid." };
  expect(testOutcome(out(r), TOKEN)).toEqual({ ok: false, code: "claude_auth", message: r.result });
  expect(testOutcome(out({ ...r, api_error_status: 403 }), TOKEN)).toMatchObject({ code: "claude_auth" });
});

it("other failures are claude_test_failed", () => {
  const r = { is_error: true, api_error_status: null, result: "API Error: Connection refused (ECONNREFUSED)" };
  expect(testOutcome(out(r), TOKEN)).toEqual({ ok: false, code: "claude_test_failed", message: r.result });
});

it("non-JSON output: first stderr line, then exit code", () => {
  expect(testOutcome({ code: 2, stdout: "garbage", stderr: "\nboom\nmore" }, TOKEN)).toMatchObject({ code: "claude_test_failed", message: "boom" });
  expect(testOutcome({ code: 2, stdout: "", stderr: "" }, TOKEN)).toMatchObject({ message: "exit 2" });
});

it("masks the token, keeps the first line, cuts at 200 characters", () => {
  expect(testOutcome(out({ is_error: true, result: `bad ${TOKEN}\nsecond` }), TOKEN)).toMatchObject({ message: "bad ***" });
  expect(testOutcome({ code: 1, stdout: "", stderr: `x ${TOKEN}` }, TOKEN)).toMatchObject({ message: "x ***" });
  const m = (testOutcome(out({ is_error: true, result: "a".repeat(500) }), TOKEN) as { message: string }).message;
  expect(m).toHaveLength(200);
});
