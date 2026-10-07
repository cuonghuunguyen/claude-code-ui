import { useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { BoldIcon, CodeIcon, ItalicIcon, LinkIcon, ListIcon, SquareCodeIcon } from "lucide-react";
import { formatEdit, type MarkdownFormat } from "./markdown-format.ts";
import { IS_MAC, keyLabels, matchesKey } from "./shortcuts.ts";
import { GHOST } from "./toolbar.tsx";

/** Not in `KEYS`: `mod+b` is the sidebar there; inside the prompt box it formats instead. */
export const FORMAT_KEYS = { bold: "mod+b", italic: "mod+i", code: "mod+e" } as const;

/** Apply `format` to the textarea's selection as one native edit (Ctrl+Z undoes it); React's onChange follows from the input event. */
export function applyFormat(el: HTMLTextAreaElement, format: MarkdownFormat) {
  const { from, to, insert, selectionStart, selectionEnd } = formatEdit(el.value, el.selectionStart, el.selectionEnd, format);
  el.focus();
  el.setSelectionRange(from, to);
  // execCommand is deprecated but the only way to keep the textarea's undo stack; setRangeText is the fallback (jsdom, a browser that refuses).
  const ok = typeof document.execCommand === "function" && document.execCommand("insertText", false, insert);
  if (!ok) {
    el.setRangeText(insert, from, to, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.setSelectionRange(selectionStart, selectionEnd);
}

/** Ctrl/Cmd+B, I, E in the prompt box: format and prevent the browser and the global shortcuts. */
export function formatShortcut(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  const f = (Object.keys(FORMAT_KEYS) as (keyof typeof FORMAT_KEYS)[]).find((k) => matchesKey(FORMAT_KEYS[k], e.nativeEvent));
  if (!f) return false;
  e.preventDefault();
  applyFormat(e.currentTarget, f);
  return true;
}

const ICON = "size-4";
const BUTTONS: { format: MarkdownFormat; name: string; icon: ReactNode; key?: keyof typeof FORMAT_KEYS }[] = [
  { format: "bold", name: "Bold", icon: <BoldIcon className={ICON} />, key: "bold" },
  { format: "italic", name: "Italic", icon: <ItalicIcon className={ICON} />, key: "italic" },
  { format: "code", name: "Inline code", icon: <CodeIcon className={ICON} />, key: "code" },
  { format: "codeBlock", name: "Code block", icon: <SquareCodeIcon className={ICON} /> },
  { format: "link", name: "Link", icon: <LinkIcon className={ICON} /> },
  { format: "bulletList", name: "Bullet list", icon: <ListIcon className={ICON} /> },
];

/** Formatting row at the top of the prompt box: plain-text markdown edits, no WYSIWYG. One Tab stop, arrows move (WAI-ARIA toolbar). */
export function MarkdownToolbar({ input, disabled }: { input: RefObject<HTMLTextAreaElement | null>; disabled?: boolean }) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = BUTTONS.length;
    const next = { ArrowRight: (active + 1) % n, ArrowLeft: (active + n - 1) % n, Home: 0, End: n - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
    refs.current[next]?.focus();
  };
  return (
    <div role="toolbar" aria-label="Formatting" data-testid="markdown-toolbar" className="flex items-center gap-1 px-2 pt-2 pointer-coarse:gap-2" onKeyDown={move}>
      {BUTTONS.map((b, i) => {
        const spec = b.key && FORMAT_KEYS[b.key];
        const letter = spec ? keyLabels(spec)[1]! : "";
        return (
          <button
            key={b.format}
            ref={(el) => void (refs.current[i] = el)}
            type="button"
            aria-label={b.name}
            title={spec ? `${b.name} (${IS_MAC ? `⌘${letter}` : `Ctrl+${letter}`})` : b.name}
            aria-keyshortcuts={spec ? `${IS_MAC ? "Meta" : "Control"}+${letter}` : undefined}
            data-testid={`format-${b.format}`}
            disabled={disabled}
            tabIndex={i === active ? 0 : -1}
            className={`${GHOST} flex w-7 shrink-0 items-center justify-center px-0! max-md:h-11! max-md:w-11 pointer-coarse:w-11`}
            onMouseDown={(e) => e.preventDefault()}
            onFocus={() => setActive(i)}
            onClick={() => input.current && applyFormat(input.current, b.format)}
          >
            {b.icon}
          </button>
        );
      })}
    </div>
  );
}
