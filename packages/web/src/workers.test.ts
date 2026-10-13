import { expect, it } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";
import { emptySession } from "./store.ts";
import { agentLinks, NO_LINKS, sameLinks, workerState } from "./workers.ts";

const item = (id: string, over: Partial<SessionListItem> = {}): SessionListItem => ({
  id,
  cwd: "/p",
  state: "idle",
  model: "default",
  permissionMode: "default",
  effort: "default",
  permissionModes: ["default"],
  title: `title ${id}`,
  lastActivity: 0,
  archived: false,
  transcript: true,
  ...over,
});

it("workerState: live view state wins, idle without a CLI process is closed, closed list state stays closed", () => {
  expect(workerState(item("a", { state: "idle", live: false }), { ...emptySession(), state: "running" })).toBe("running");
  expect(workerState(item("a", { state: "idle", live: false }))).toBe("closed");
  expect(workerState(item("a", { state: "idle" }))).toBe("idle");
  expect(workerState(item("a", { state: "closed" }))).toBe("closed");
  expect(workerState(item("a", { state: "needs_input", live: false }))).toBe("needs_input");
});

it("agentLinks: workers of the session sorted by name, closed split off, archived included; others' workers left out", () => {
  const list = [
    item("C", { coordinator: true }),
    item("b", { coordinatorId: "C", workerName: "b", state: "running" }),
    item("a", { coordinatorId: "C", workerName: "a" }),
    item("c", { coordinatorId: "C", workerName: "c", live: false, archived: true }),
    item("x", { coordinatorId: "D", workerName: "x" }),
  ];
  const l = agentLinks(list, {}, "C");
  expect(l.workers.map((w) => [w.name, w.state])).toEqual([["a", "idle"], ["b", "running"]]);
  expect(l.closed.map((w) => [w.id, w.state])).toEqual([["c", "closed"]]);
  expect(l.coordinator).toBeUndefined();
});

it("agentLinks: a worker gets its listed coordinator; an unlisted coordinator gives none", () => {
  const list = [item("C", { coordinator: true, title: "Demo" }), item("w", { coordinatorId: "C", workerName: "w" }), item("o", { coordinatorId: "gone", workerName: "o" })];
  expect(agentLinks(list, {}, "w").coordinator).toEqual({ id: "C", title: "Demo" });
  expect(agentLinks(list, {}, "o")).toBe(NO_LINKS);
  expect(agentLinks(list, {}, "plain")).toBe(NO_LINKS);
});

it("sameLinks keeps the previous object while equal, takes the new one when a state changed", () => {
  const list = [item("C", { coordinator: true }), item("w", { coordinatorId: "C", workerName: "w" })];
  const a = agentLinks(list, {}, "C");
  expect(sameLinks(a, agentLinks(list, {}, "C"))).toBe(a);
  const b = agentLinks(list, { w: { ...emptySession(), state: "running" } }, "C");
  expect(sameLinks(a, b)).toBe(b);
  expect(sameLinks(undefined, a)).toBe(a);
});
