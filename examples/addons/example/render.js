// @ts-check
// A renderer: draws ```example code fences as a card with a word count, and the input and result of mcp__example__echo.
import { autoHeight, on } from "./claude-ui-addon.js";

const card = /** @type {HTMLElement} */ (document.getElementById("card"));
const show = (/** @type {string} */ title, /** @type {string} */ text, extra = "") => {
  const h = document.createElement("strong");
  h.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = text;
  pre.style.margin = "4px 0";
  pre.style.whiteSpace = "pre-wrap";
  const note = document.createElement("small");
  note.textContent = extra;
  card.replaceChildren(h, pre, note);
};

document.body.style.margin = "8px 10px";
document.body.style.font = "13px system-ui, sans-serif";
autoHeight();
on("render", (m) => {
  if ("fence" in m) {
    const words = m.fence.source.trim().split(/\s+/).filter(Boolean).length;
    return show("Example block", m.fence.source, `${words} words`);
  }
  show(m.tool.name, JSON.stringify({ input: m.tool.input, result: m.tool.result }, null, 2));
});
