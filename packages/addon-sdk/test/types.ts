// Type tests, run by `npm run typecheck` (tsconfig.json of this package): each @ts-expect-error must be an error.
import { call, on, setStatus } from "../claude-ui-addon.js";

void call("ui.toast", { text: "ok" });
void call("session.read").then((r) => r.parts.filter((p) => p.type === "tool_call").map((p) => p.tool));
void setStatus(null);
on("render", (m) => ("fence" in m ? m.fence.source : m.tool.name));
// @ts-expect-error not a request an addon can send
void call("prompt.submit", { text: "x" });
// @ts-expect-error text is required
void call("prompt.insert");
// @ts-expect-error text must be a string
void call("ui.toast", { text: 1 });
// @ts-expect-error no such event
on("session.changed", () => {});
on("command.run", (m) => {
  // @ts-expect-error command.run has name and args, no text
  void m.text;
});
