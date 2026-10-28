import { describe, expect, it } from "vitest";
import { isBackgroundShell, type Part } from "../src/index.ts";

const bash = (extra: object = {}, input: object = { command: "x" }, tool = "Bash") =>
  ({ type: "tool_call", id: "t", toolUseId: "t", tool, input, status: "running", ...extra }) as Part;

describe("isBackgroundShell", () => {
  it("run_in_background or shell background, Bash only", () => {
    expect(isBackgroundShell(bash({ shell: "background" }))).toBe(true);
    expect(isBackgroundShell(bash({}, { command: "x", run_in_background: true }))).toBe(true);
    expect(isBackgroundShell(bash({ shell: "foreground" }))).toBe(false);
    expect(isBackgroundShell(bash())).toBe(false);
    expect(isBackgroundShell(bash({}, { run_in_background: true }, "Task"))).toBe(false);
    expect(isBackgroundShell({ type: "user_text", id: "u", text: "", images: [] })).toBe(false);
  });
});
