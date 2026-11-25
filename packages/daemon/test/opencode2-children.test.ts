// Contract of ChildRuns: a shell exit reaches only the child that owns the shell (others keep no copy of it).
import { expect, it } from "vitest";
import { ChildRuns } from "../src/opencode2-children.ts";

it("shellExited gives the card of the owning child only and stores the exit nowhere else", () => {
  const runs = new ChildRuns();
  const owner = runs.link("ses_a", "call_a");
  const other = runs.link("ses_b", "call_b");
  owner.mapper.history([{ id: "m1", type: "assistant", agent: "g", model: { id: "m", providerID: "p" }, time: { created: 1 }, content: [{ type: "tool", id: "c1", name: "shell", state: { status: "completed", input: { command: "x", background: true }, content: [{ type: "text", text: "Command moved to the background (shell ID: sh_1)." }] }, time: { created: 1, completed: 2 } }] } as never]);
  const parts = runs.shellExited("sh_1", "exited", 3);
  expect(parts).toMatchObject([{ id: "c1", status: "error", exitCode: 3, parentId: "call_a" }]);
  expect(owner.mapper.shellEnd("sh_1")).toBeDefined();
  expect(other.mapper.shellEnd("sh_1")).toBeUndefined();
  expect(runs.shellExited("sh_unknown", "killed", undefined)).toEqual([]);
  expect(other.mapper.shellEnd("sh_unknown")).toBeUndefined();
});
