import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { code, type CodeHighlighterPlugin, type HighlightOptions, type HighlightResult } from "@streamdown/code";
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

/** Code in one message colored at once, up to this many characters in all; every block after it (or one longer) is colored when idle. */
export const LONG_CODE = 1200;
/** Coloring waits until the user has not scrolled for this long (ms): a block built mid-scroll is a dropped frame. */
export const SCROLL_REST = 500;
/** A scroll event within this long (ms) of the user's wheel, touch, key or pointer is theirs (a fling goes on after the finger lifts). */
const FLING = 1500;

let lastInput = -Infinity;
let lastScroll = -Infinity;
if (typeof document !== "undefined") {
  for (const t of ["wheel", "touchstart", "touchmove", "keydown", "pointerdown"]) document.addEventListener(t, () => (lastScroll = lastInput = performance.now()), { capture: true, passive: true });
  document.addEventListener("pointermove", (e) => e.buttons && (lastScroll = lastInput = performance.now()), { capture: true, passive: true });
  // Programmatic scrolling (a streaming turn follows its output) is not the user's: only a scroll just after their input counts.
  document.addEventListener("scroll", () => performance.now() - lastInput < FLING && (lastScroll = performance.now()), { capture: true, passive: true });
}

type Job = { options: HighlightOptions; callbacks: Set<(r: HighlightResult) => void> };
/** Newest job last: the rows on screen mounted last, and they come first. Deduped by language and code. */
const jobs = new Map<string, Job>();
/** Results of finished jobs (a row that comes into view again is colored at once). */
const done = new Map<string, HighlightResult>();
const DONE_MAX = 40;
let epoch = 0;
let scheduled = false;
const keyOf = (o: HighlightOptions) => `${o.language}\0${o.code}`;

/** One block per idle slot, once scrolling has rested (checked again when the slot comes). */
function schedule() {
  if (scheduled || !jobs.size) return;
  scheduled = true;
  const mine = epoch;
  const wait = () => {
    if (mine !== epoch) return;
    const rest = lastScroll + SCROLL_REST - performance.now();
    if (rest > 0) return void setTimeout(wait, rest);
    const next = () => {
      if (mine !== epoch) return;
      const rest = lastScroll + SCROLL_REST - performance.now();
      if (rest > 0) return void setTimeout(wait, rest);
      scheduled = false;
      const key = [...jobs.keys()].pop();
      const job = key === undefined ? undefined : jobs.get(key);
      if (key !== undefined && job) {
        jobs.delete(key);
        const finish = (r: HighlightResult) => {
          done.delete(key);
          done.set(key, r);
          if (done.size > DONE_MAX) done.delete(done.keys().next().value!);
          job.callbacks.forEach((cb) => cb(r));
        };
        const r = code.highlight(job.options, finish);
        if (r) finish(r);
      }
      schedule();
    };
    const ric = globalThis.requestIdleCallback;
    if (ric) ric(next, { timeout: 1000 });
    else setTimeout(next, 16);
  };
  wait();
}

/** For tests: drop every queued job and timer. */
export function resetIdleQueue() {
  epoch++;
  scheduled = false;
  jobs.clear();
  done.clear();
  lastScroll = lastInput = -Infinity;
}

/**
 * The assistant's code plugin (it caches the tokens per code, language and theme) with code deferred: highlighting builds a
 * span per token on every mount, and the virtual timeline mounts a row each time it scrolls into view, so long prompts with
 * code made scrolling stutter. One plugin per message: its first 1200 characters of code are colored at once, as in the
 * assistant's text; the rest paints plain and takes its colors when idle (newest row first). `cancel` (the row unmounted)
 * drops the message's queued jobs.
 */
function userCodeFor() {
  const mine = new Map<string, (r: HighlightResult) => void>();
  const sync = new Map<string, boolean>();
  let used = 0;
  const plugin: CodeHighlighterPlugin = {
    ...code,
    highlight(options, callback) {
      const key = keyOf(options);
      if (!callback) return code.highlight(options, callback);
      let now = sync.get(key);
      if (now === undefined) {
        now = used + options.code.length <= LONG_CODE;
        if (now) used += options.code.length;
        sync.set(key, now);
      }
      if (now) return code.highlight(options, callback);
      const cached = done.get(key);
      if (cached) return cached;
      const job = jobs.get(key) ?? { options, callbacks: new Set() };
      jobs.delete(key);
      jobs.set(key, job);
      mine.get(key) && job.callbacks.delete(mine.get(key)!);
      mine.set(key, callback);
      job.callbacks.add(callback);
      schedule();
      return null;
    },
  };
  const cancel = () => {
    for (const [key, cb] of mine) {
      const job = jobs.get(key);
      job?.callbacks.delete(cb);
      if (job && !job.callbacks.size) jobs.delete(key);
    }
    mine.clear();
  };
  return { plugin, cancel };
}

/** A user message's text as markdown, through the same renderer as assistant text (code beyond the first 1200 characters colored when idle). */
export function UserMarkdown({ text }: { text: string }) {
  const [own] = useState(userCodeFor);
  const plugins = useMemo(() => ({ cjk, code: own.plugin, math, mermaid }), [own]);
  useEffect(() => () => own.cancel(), [own]);
  return (
    <MessageResponse mode="static" plugins={plugins} remarkPlugins={USER_REMARK_PLUGINS} rehypePlugins={USER_REHYPE_PLUGINS}>
      {text}
    </MessageResponse>
  );
}
