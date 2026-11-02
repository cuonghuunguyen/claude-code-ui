// @vitest-environment jsdom
import { join } from "node:path";
import { expect, it } from "vitest";

// The example addon's bridge.js is what authors copy: it must act only on messages from the host (`parent`).
// Tests run from the repository root.
const bridge = join(process.cwd(), "examples/addons/example/bridge.js");

it("bridge.js handles an event from the host and ignores the same message from another frame", async () => {
  const { on } = (await import(/* @vite-ignore */ bridge)) as { on: (type: string, fn: (m: { args: string }) => void) => void };
  const seen: string[] = [];
  on("command.run", (m) => seen.push(m.args));
  const other = document.createElement("iframe");
  document.body.append(other);
  const send = (source: MessageEventSource | null, args: string) => window.dispatchEvent(new MessageEvent("message", { data: { v: 1, type: "command.run", name: "cmd", args }, source }));
  // In a top-level test window `parent` is the window itself: that is the host here.
  send(window.parent, "from host");
  send(other.contentWindow, "forged by another frame");
  send(null, "no source");
  expect(seen).toEqual(["from host"]);
});
