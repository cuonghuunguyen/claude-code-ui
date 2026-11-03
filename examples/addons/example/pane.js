// @ts-check
// A pane (view "stats"): part counts of the session (watchSession), and one button per bridge call.
import { call, log, setStatus, toast, watchSession } from "./claude-ui-addon.js";

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

watchSession((parts) => {
  /** @type {Record<string, number>} */
  const n = {};
  for (const p of parts) n[p.type] = (n[p.type] ?? 0) + 1;
  $("parts").textContent = `${parts.length} parts: ${Object.entries(n).map(([k, v]) => `${k} ${v}`).join(", ")}`;
});

$("status").onclick = () => setStatus("ready");
$("toast").onclick = () => toast("hello");
$("log").onclick = () => log(`pane clicked at ${new Date().toISOString()}`);
// Never allowed: an addon cannot send a prompt. The host answers with an error and logs it.
// @ts-expect-error prompt.submit is not a request: the types refuse it too
$("submit").onclick = () => call("prompt.submit", { text: "x" }).catch((e) => ($("refused").textContent = `Refused: ${e.message}`));
// Allowed by net:https://api.github.com; the API must answer CORS for Origin: null.
$("fetch").onclick = () => fetch("https://api.github.com/zen").then((r) => r.text(), (e) => String(e)).then((t) => ($("fetched").textContent = t));
