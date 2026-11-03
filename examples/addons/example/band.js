// @ts-check
// A band above the prompt box (view "info"): turns and the last tool of the session; its height follows the content (autoHeight).
import { autoHeight, watchSession } from "./claude-ui-addon.js";

document.body.style.margin = "6px 10px";
document.body.style.font = "13px system-ui, sans-serif";
autoHeight();
watchSession((parts) => {
  const turns = parts.filter((p) => p.type === "turn_result").length;
  const last = parts.findLast((p) => p.type === "tool_call");
  /** @type {HTMLElement} */ (document.getElementById("info")).textContent = `${turns} ${turns === 1 ? "turn" : "turns"} · last tool: ${last?.type === "tool_call" ? last.tool : "none"}`;
});
