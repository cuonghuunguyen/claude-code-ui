import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { code, type CodeHighlighterPlugin, type HighlightResult } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { defaultRehypePlugins, defaultRemarkPlugins, type Streamdown } from "streamdown";
import { MessageResponse } from "./components/ai-elements/message.tsx";
import { codeOf, unwatchBlock, watchBlock } from "./user-code-paint.ts";

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

/** Code in one message colored at once, up to this many characters in all; every block after it (or one longer) is painted when idle. */
export const LONG_CODE = 1200;

const keyOf = (o: { language: string; code: string }) => `${o.language}\0${o.code}`;

/**
 * The assistant's code plugin (it caches the tokens per code, language and theme), one per message: its first 1200
 * characters of code are colored at once by streamdown, as in the assistant's text. Further blocks stay plain DOM (a span
 * per token on every row mount made scrolling stutter, GH-188) and are reported to `onDeferred`; `user-code-paint.ts`
 * paints their colors over the plain text once they are on screen and the scroll has rested.
 */
function userCodeFor(onDeferred: () => void) {
  const deferred = new Set<string>();
  const sync = new Map<string, boolean>();
  let used = 0;
  // Streamdown keeps a block's last result until the plugin gives a new one: on the first mount that is the plain block,
  // but a block whose code changes later (the message text changed) needs its new plain result.
  let mounted = false;
  const plain = new Map<string, HighlightResult>();
  const plugin: CodeHighlighterPlugin = {
    ...code,
    highlight(options, callback) {
      const key = keyOf(options);
      if (!callback) return code.highlight(options, callback);
      if (!mounted) queueMicrotask(() => (mounted = true));
      let now = sync.get(key);
      if (now === undefined) {
        now = used + options.code.length <= LONG_CODE;
        if (now) used += options.code.length;
        sync.set(key, now);
      }
      if (now) return code.highlight(options, callback);
      deferred.add(key);
      onDeferred();
      if (!mounted) return null;
      let r = plain.get(key);
      if (!r) plain.set(key, (r = { bg: "transparent", fg: "inherit", tokens: options.code.split("\n").map((content) => [{ content, color: "inherit", bgColor: "transparent", htmlStyle: {}, offset: 0 }]) } as HighlightResult));
      return r;
    },
  };
  return { plugin, deferred };
}

/** A user message's text as markdown, through the same renderer as assistant text (code beyond the first 1200 characters painted when idle). */
export function UserMarkdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [own] = useState(() => {
    /** Watched blocks of this message and the key (language and code) each was watched for. */
    const watched = new Map<HTMLElement, string>();
    let queued = false;
    // The message's plain blocks whose code was deferred (by language and code: two equal blocks are both watched; a block
    // whose code changed is watched again).
    const scan = () => {
      queued = false;
      const root = ref.current;
      if (!root) return;
      for (const el of watched.keys()) if (!root.contains(el)) (unwatchBlock(el), watched.delete(el));
      for (const el of root.querySelectorAll<HTMLElement>('[data-streamdown="code-block"]')) {
        const lines = el.querySelector("code");
        const key = lines && keyOf({ language: el.dataset.language ?? "", code: codeOf(lines) });
        if (watched.get(el) === key) continue;
        if (watched.has(el)) (unwatchBlock(el), watched.delete(el));
        if (!key || !own.deferred.has(key)) continue;
        watched.set(el, key);
        watchBlock(el);
      }
    };
    const unwatchAll = () => {
      for (const el of watched.keys()) unwatchBlock(el);
      watched.clear();
    };
    const own = { ...userCodeFor(() => queued || ((queued = true), queueMicrotask(scan))), scan, unwatchAll };
    return own;
  });
  const plugins = useMemo(() => ({ cjk, code: own.plugin, math, mermaid }), [own]);
  useEffect(() => {
    own.scan();
    return own.unwatchAll;
  }, [own]);
  return (
    <div ref={ref} className="contents">
      <MessageResponse mode="static" plugins={plugins} remarkPlugins={USER_REMARK_PLUGINS} rehypePlugins={USER_REHYPE_PLUGINS}>
        {text}
      </MessageResponse>
    </div>
  );
}
