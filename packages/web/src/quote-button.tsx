import { TextQuoteIcon } from "lucide-react";
import { createContext, use, useEffect, useRef, useState } from "react";
import { MessageAction } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import {
  QUOTABLE,
  quoteText,
  selectedQuote,
  selectionTarget,
} from "./quote.ts";

/** Sends a quote to the active prompt box; absent outside App (the hover action then renders nothing). */
export const QuoteContext = createContext<
  ((quote: string) => void) | undefined
>(undefined);

/** Floating "Quote" next to a selection inside one timeline message (VS Code plan-review "Add Comment" pattern). */
export function QuoteButton({ onQuote }: { onQuote: (quote: string) => void }) {
  const [shown, setShown] = useState<{ quote: string; rect: DOMRect }>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const onChange = () => {
      clearTimeout(timer.current);
      if (!selectionTarget()) return setShown(undefined);
      timer.current = setTimeout(() => setShown(selectedQuote()), 150);
    };
    document.addEventListener("selectionchange", onChange);
    return () => (
      document.removeEventListener("selectionchange", onChange),
      clearTimeout(timer.current)
    );
  }, []);
  useEffect(() => {
    if (!shown) return;
    const hide = () => setShown(undefined);
    // Esc stops the turn only from the timeline or the body; elsewhere (dialog, prompt box) it keeps its own meaning.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const f = document.activeElement;
      if (!f || f === document.body || f.closest(".timeline"))
        e.preventDefault();
      hide();
    };
    const down = (e: Event) =>
      !(e.target as Element | null)?.closest?.(
        '[data-testid="quote-button"]',
      ) && hide();
    const focus = (e: Event) =>
      !(e.target as Element | null)?.closest?.(
        '.timeline, [data-testid="quote-button"]',
      ) && hide();
    // ponytail: hides on any scroll, also the follow-output scroll of a streaming turn; reposition instead if users select text while pinned to the bottom.
    document.addEventListener("scroll", hide, { capture: true, passive: true });
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("focusin", focus);
    return () => {
      window.removeEventListener("focusin", focus);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", down, true);
    };
  }, [shown]);
  if (!shown) return null;
  const coarse = !!window.matchMedia?.("(pointer: coarse)").matches;
  const { rect } = shown;
  const x = Math.min(
    Math.max(rect.left + rect.width / 2, 48),
    window.innerWidth - 48,
  );
  return (
    <Button
      size="sm"
      variant="secondary"
      data-testid="quote-button"
      className={`fixed z-50 shadow-md pointer-coarse:min-h-11 ${coarse ? "min-h-11 px-4" : ""}`}
      style={{
        left: x,
        top: coarse ? rect.bottom + 8 : rect.top - 8,
        transform: coarse ? "translateX(-50%)" : "translate(-50%, -100%)",
      }}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => (onQuote(shown.quote), setShown(undefined))}
    >
      <TextQuoteIcon />
      Quote
    </Button>
  );
}

/** Hover "Quote": the selection inside this message, else the whole message (cut at the cap). */
export function QuoteAction({ text }: { text: string }) {
  const quote = use(QuoteContext);
  if (!quote) return null;
  return (
    <MessageAction
      title="Quote"
      label="Quote in prompt"
      className="pointer-coarse:size-11"
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) =>
        quote(
          selectedQuote(e.currentTarget.closest(QUOTABLE) ?? undefined)
            ?.quote ?? quoteText(text),
        )
      }
    >
      <TextQuoteIcon />
    </MessageAction>
  );
}
