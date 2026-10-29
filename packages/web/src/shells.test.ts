import type { Part } from "@claude-ui/protocol";
import { expect, it } from "vitest";
import { shellsOf } from "./shells.ts";
import { applyEvent, emptySession } from "./store.ts";

const bash = (id: string, input: object, status: "running" | "done" | "stopped", shell?: "foreground" | "background"): Part => ({ type: "tool_call", id, toolUseId: id, tool: "Bash", input, status, shell });
const view = (...parts: Part[]) => parts.reduce((v, part, i) => applyEvent(v, { type: "event", sessionId: "s", seq: i + 1, part }), emptySession());

it("shellsOf lists background shells of any status, running first, newest first; not foreground or plain Bash", () => {
  const v = view(
    bash("old", { command: "a", run_in_background: true }, "done"),
    bash("run1", { command: "b", run_in_background: true }, "running"),
    bash("plain", { command: "c" }, "running"),
    bash("fg", { command: "d" }, "running", "foreground"),
    bash("moved", { command: "e" }, "stopped", "background"),
    bash("run2", { command: "f" }, "running", "background"),
  );
  expect(shellsOf(v).map((c) => c.id)).toEqual(["run2", "run1", "moved", "old"]);
});

it("shellsOf lists a background shell started inside a subagent run", () => {
  const v = view({ ...bash("sub1", { command: "npm run dev", run_in_background: true }, "running"), parentId: "agent1" } as Part, bash("fg", { command: "ls" }, "done"));
  expect(shellsOf(v).map((c) => c.id)).toEqual(["sub1"]);
});

it("shellsOf lists a ! command moved to the background with its output; not a foreground one (GH-485)", () => {
  const b = (id: string, shell?: "background"): Part => ({ type: "bash", id, command: `cmd-${id}`, stdout: "a", stderr: "", status: "running", ...(shell && { shell }) });
  const v = view(b("fg"), b("bg", "background"));
  expect(shellsOf(v)).toMatchObject([{ toolUseId: "bg", input: { command: "cmd-bg" }, status: "running", text: "a" }]);
});
