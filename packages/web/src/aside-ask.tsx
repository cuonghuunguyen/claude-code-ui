// Ask aside while a permission or question panel replaces the prompt box (docs/spec.md "Aside"): a one-line question input.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type Props = {
  onAside: (question: string) => Promise<unknown>;
  /** Text the app put in the prompt box (palette Ask aside: `/btw `); taken here while no prompt box is mounted. */
  insert?: string;
  onInserted: () => void;
};

export function AsideAsk({ onAside, insert, onInserted }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!insert || !/^\/btw(\s|$)/.test(insert)) return;
    setText(insert.replace(/^\/btw\s*/, ""));
    setOpen(true);
    onInserted();
  }, [insert]);
  useEffect(() => void (open && input.current?.focus()), [open]);
  const submit = () => {
    const q = text.trim();
    if (!q) return setError("Type a question");
    setError(undefined);
    onAside(q).then(
      () => (setOpen(false), setText("")),
      (e: Error) => setError(`Aside not opened: ${e.message}`),
    );
  };
  if (!open)
    return (
      <div className="flex px-1 pb-1">
        <Button type="button" variant="ghost" size="sm" className="max-md:h-11" data-testid="aside-ask-open" onClick={() => setOpen(true)}>
          Ask aside
        </Button>
      </div>
    );
  return (
    <form className="flex flex-col gap-1 px-1 pb-1" data-testid="aside-ask" onSubmit={(e) => (e.preventDefault(), submit())}>
      <div className="flex gap-2">
        <input
          ref={input}
          aria-label="Aside question"
          placeholder="Ask an aside (read-only side question)…"
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm max-md:h-11"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}
        />
        <Button type="submit" size="sm" className="max-md:h-11">
          Ask
        </Button>
      </div>
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
    </form>
  );
}
