// A renderer: draws ```example code fences as a card with a word count, and the input and result of mcp__example__echo.
import { call, on } from "./bridge.js";

// The page height including the body margins (scrollHeight alone leaves them out and clips the content).
const contentHeight = () => Math.ceil(document.body.getBoundingClientRect().bottom + parseFloat(getComputedStyle(document.body).marginBottom));

const card = document.getElementById("card");
const show = (title, text, extra = "") => {
  card.replaceChildren();
  const h = document.createElement("strong");
  h.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = text;
  pre.style.margin = "4px 0";
  pre.style.whiteSpace = "pre-wrap";
  const note = document.createElement("small");
  note.textContent = extra;
  card.append(h, pre, note);
  call("ui.ready", { height: contentHeight() });
};

document.body.style.margin = "8px 10px";
document.body.style.font = "13px system-ui, sans-serif";
on("theme.changed", (m) => (document.documentElement.style.colorScheme = m.mode));
on("init", (m) => (document.documentElement.style.colorScheme = m.mode));
on("render", (m) => {
  if (m.fence) {
    const words = m.fence.source.trim().split(/\s+/).filter(Boolean).length;
    return show("Example block", m.fence.source, `${words} words`);
  }
  show(m.tool.name, JSON.stringify({ input: m.tool.input, result: m.tool.result }, null, 2));
});
