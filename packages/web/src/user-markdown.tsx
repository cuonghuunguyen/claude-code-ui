import type { ComponentProps } from "react";
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

/** A user message's text as markdown, through the same renderer as assistant text. */
export function UserMarkdown({ text }: { text: string }) {
  return (
    <MessageResponse mode="static" remarkPlugins={USER_REMARK_PLUGINS} rehypePlugins={USER_REHYPE_PLUGINS}>
      {text}
    </MessageResponse>
  );
}
