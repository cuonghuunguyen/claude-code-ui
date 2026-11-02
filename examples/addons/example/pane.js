// A pane (view "stats"): part counts of the session (session.read, then session.parts), and one button per bridge call.
import { call, on } from "./bridge.js";

const $ = (id) => document.getElementById(id);
const parts = new Map();

function show() {
  const n = {};
  for (const p of parts.values()) n[p.type] = (n[p.type] ?? 0) + 1;
  $("parts").textContent = `${parts.size} parts: ${Object.entries(n).map(([k, v]) => `${k} ${v}`).join(", ")}`;
}
const mode = (m) => (document.documentElement.style.colorScheme = m.mode); // CSSOM is allowed by the page CSP, inline <style> is not

on("theme.changed", mode);
on("init", async (m) => {
  mode(m);
  for (const p of (await call("session.read")).parts) parts.set(p.id, p);
  show();
});
on("session.parts", (m) => {
  for (const p of m.parts) parts.set(p.id, p);
  show();
});

$("status").onclick = () => call("ui.status", { text: "ready" });
$("toast").onclick = () => call("ui.toast", { text: "hello" });
// Never allowed: an addon cannot send a prompt. The host answers with an error and logs it.
$("submit").onclick = () => call("prompt.submit", { text: "x" }).catch((e) => ($("refused").textContent = `Refused: ${e.message}`));
// Allowed by net:https://api.github.com; the API must answer CORS for Origin: null.
$("fetch").onclick = () => fetch("https://api.github.com/zen").then((r) => r.text(), (e) => String(e)).then((t) => ($("fetched").textContent = t));
