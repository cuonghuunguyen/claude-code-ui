import { expect, it } from "vitest";
import { sendHint } from "./toolbar.tsx";

it("GH-443: the send hint of a queued shell command says it queues, never steer", () => {
  expect(sendHint({ steer: true, canQueue: true, queue: true, shell: true })).toMatch(/queue/i);
  expect(sendHint({ steer: true, canQueue: true, queue: true, shell: true })).not.toMatch(/steer|alt/i);
});

it("the send hint of a prompt names both actions; none without a queue or input", () => {
  expect(sendHint({ steer: true, canQueue: true, queue: false })).toMatch(/steer .*queue/);
  expect(sendHint({ steer: true, canQueue: true, queue: true })).toMatch(/queue .*steer/);
  expect(sendHint({ steer: true, canQueue: false, queue: false })).toBe("");
  expect(sendHint({ steer: false, canQueue: true, queue: false })).toBe("");
});
