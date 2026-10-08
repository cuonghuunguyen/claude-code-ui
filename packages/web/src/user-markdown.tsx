import type { ComponentProps } from "react";
import { code, type CodeHighlighterPlugin } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { defaultRehypePlugins, defaultRemarkPlugins, type Streamdown } from "streamdown";
import { MessageResponse } from "./components/ai-elements/message.tsx";

type Plugins<K extends "remarkPlugins" | "rehypePlugins"> = NonNullable<ComponentProps<typeof Streamdown>[K]>;
type MdNode = { type: string; value?: string; children?: MdNode[] };

/** A single newline in a prompt stays a line break (what the bubble always showed): text nodes split on "\n" into text + break nodes. */
const FLOW = new Set(["root", "blockquote", "listItem"]);
function splitNewlines(node: MdNode) {
  if (!node.children || node.type === "code") return;
  node.children = node.children.flatMap((c): MdNode[] => {
    // A paragraph starting with a tag is an HTML block (no `raw` plugin: shown as text); make it text first so its newlines split too.
    if (c.type === "html") {
      const text: MdNode = { type: "text", value: (c.value ?? "").trimEnd() };
      c = FLOW.has(node.type) ? { type: "paragraph", children: [text] } : text;
    }
    if (c.type !== "text" || !c.value?.includes("\n")) return (splitNewlines(c), [c]);
    return c.value.split("\n").flatMap((v, i): MdNode[] => [...(i ? [{ type: "break" }] : []), ...(v ? [{ type: "text", value: v }] : [])]);
  });
}
export const remarkLineBreaks = () => splitNewlines;

// Module constants: MessageResponse is memoized on `children` only.
const { raw: _raw, ...SAFE_REHYPE } = defaultRehypePlugins;
/** Typed HTML (`<Button>`) stays visible text: the default `raw` plugin would drop or restructure it. */
export const USER_REHYPE_PLUGINS = Object.values(SAFE_REHYPE) as Plugins<"rehypePlugins">;
export const USER_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkLineBreaks] as Plugins<"remarkPlugins">;

/** A code block longer than this (characters) is colored when the browser is idle, not while its row mounts. */
export const LONG_CODE = 1200;

const idleQueue: (() => void)[] = [];
let idleScheduled = false;
let lastScroll = 0;
/** Coloring waits for the scroll to rest this long (ms): a block built mid-scroll is a dropped frame. */
export const SCROLL_REST = 150;
if (typeof document !== "undefined") document.addEventListener("scroll", () => (lastScroll = performance.now()), { capture: true, passive: true });

/** One block per idle slot, once scrolling has rested: a prompt with several long blocks never builds them all in one task. */
function whenIdle(job: () => void) {
  idleQueue.push(job);
  if (idleScheduled) return;
  const schedule = () => {
    idleScheduled = true;
    const wait = lastScroll + SCROLL_REST - performance.now();
    if (wait > 0) return void setTimeout(schedule, wait);
    const ric = globalThis.requestIdleCallback;
    const next = () => {
      idleScheduled = false;
      idleQueue.shift()?.();
      if (idleQueue.length) schedule();
    };
    if (ric) ric(next, { timeout: 1000 });
    else setTimeout(next, 16);
  };
  schedule();
}

/**
 * The assistant's code plugin (it caches the tokens per code, language and theme) with long blocks deferred: highlighting
 * builds a span per token on every mount, and the virtual timeline mounts a row each time it scrolls into view, so long
 * prompts with code made scrolling stutter. A long block paints plain first and takes its colors when idle; a short one is
 * colored at once, as in the assistant's text.
 */
export const userCode: CodeHighlighterPlugin = {
  ...code,
  highlight(options, callback) {
    if (options.code.length <= LONG_CODE || !callback) return code.highlight(options, callback);
    whenIdle(() => {
      const done = code.highlight(options, callback);
      if (done) callback(done);
    });
    return null;
  },
};
const USER_PLUGINS = { cjk, code: userCode, math, mermaid };

/** A user message's text as markdown, through the same renderer as assistant text (long code blocks colored when idle). */
export function UserMarkdown({ text }: { text: string }) {
  return (
    <MessageResponse mode="static" plugins={USER_PLUGINS} remarkPlugins={USER_REMARK_PLUGINS} rehypePlugins={USER_REHYPE_PLUGINS}>
      {text}
    </MessageResponse>
  );
}
