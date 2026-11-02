// A band above the prompt box (view "info"): turns and the last tool of the session; asks the host for its height with ui.ready.
import { call, on } from "./bridge.js";

// The page height including the body margins (scrollHeight alone leaves them out and clips the content).
const contentHeight = () => Math.ceil(document.body.getBoundingClientRect().bottom + parseFloat(getComputedStyle(document.body).marginBottom));

const parts = new Map();
function show() {
  const all = [...parts.values()];
  const turns = all.filter((p) => p.type === "turn_result").length;
  const last = all.findLast((p) => p.type === "tool_call")?.tool ?? "none";
  document.getElementById("info").textContent = `${turns} ${turns === 1 ? "turn" : "turns"} · last tool: ${last}`;
  call("ui.ready", { height: contentHeight() });
}
const mode = (m) => (document.documentElement.style.colorScheme = m.mode);

document.body.style.margin = "6px 10px";
document.body.style.font = "13px system-ui, sans-serif";
on("theme.changed", mode);
// A narrower frame wraps the text onto more lines.
addEventListener("resize", () => call("ui.ready", { height: contentHeight() }));
on("init", async (m) => {
  mode(m);
  for (const p of (await call("session.read")).parts) parts.set(p.id, p);
  show();
});
on("session.parts", (m) => {
  for (const p of m.parts) parts.set(p.id, p);
  show();
});
