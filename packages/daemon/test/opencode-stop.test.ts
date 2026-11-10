// Where each send() of an OpenCode prompt is when Stop comes, and what Stop does there (GH-682): the state machine of opencode-stop.ts.
import { expect, it } from "vitest";
import { StopControl } from "../src/opencode-stop.ts";

const never = new Promise<void>(() => {});

it("a send that began before a Stop stays dropped when a later prompt begins its own send (the Stop is per send, not a session flag)", async () => {
  const stops = new StopControl();
  const a = stops.begin();
  stops.stop();
  const b = stops.begin(); // the next prompt
  expect(a.phase).toBe("dropped");
  expect(await a.prepare(Promise.resolve())).toBe(false);
  expect(b.phase).toBe("preparing");
  expect(await b.prepare(Promise.resolve())).toBe(true);
});

it("Stop ends every wait of a preparing send at once, steering ones included; a wait that fails after the Stop is dropped", async () => {
  const stops = new StopControl();
  const a = stops.begin();
  const b = stops.begin();
  let fail!: (e: Error) => void;
  const waits = [a.prepare(never), b.prepare(new Promise((_, r) => (fail = r)))];
  stops.stop();
  expect(await Promise.all(waits)).toEqual([false, false]);
  fail(new Error("late"));
  await new Promise((r) => setTimeout(r, 10)); // no unhandled rejection
});

it("a wait that fails before any Stop rejects the send", async () => {
  const stops = new StopControl();
  await expect(stops.begin().prepare(Promise.reject(new Error("PATCH failed")))).rejects.toThrow("PATCH failed");
});

it("Stop hands over the prompt requests on their way and leaves their sends waiting; a posted send is out of Stop's reach", async () => {
  const stops = new StopControl();
  const posting = stops.begin();
  let answer!: () => void;
  const req = posting.post(new Promise<void>((r) => (answer = r)));
  const posted = stops.begin();
  await posted.post(Promise.resolve());
  expect(posted.phase).toBe("posted");
  const ways = stops.stop();
  expect(ways).toHaveLength(1);
  expect(posting.phase).toBe("posting");
  answer();
  await req;
  expect(posting.phase).toBe("posted");
  await ways[0];
  expect(stops.stop()).toEqual([]);
  expect(stops.count).toBe(2);
});

it("a prompt request that fails is still handed over as settled, never as a rejection", async () => {
  const stops = new StopControl();
  const run = stops.begin();
  const req = run.post(new Promise((_, r) => setTimeout(() => r(new Error("500")), 5)));
  const [way] = stops.stop();
  await expect(req).rejects.toThrow("500");
  await expect(way).resolves.toBeUndefined();
});
