// Ask aside while a permission or question panel replaces the prompt box (docs/spec.md "Aside"): a one-line question input.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "./i18n.ts";

type Props = {
  onAside: (question: string) => Promise<unknown>;
  /** Text the app put in the prompt box (palette Ask aside: `/btw `); taken here while no prompt box is mounted. */
  insert?: string;
  onInserted: () => void;
};

export function AsideAsk({ onAside, insert, onInserted }: Props) {
  const t = useT();
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
    if (!q) return setError(t("session.asideAsk.empty"));
    setError(undefined);
    onAside(q).then(
      () => (setOpen(false), setText("")),
      (e: Error) => setError(t("session.asideAsk.failed", { message: e.message })),
    );
  };
  if (!open)
    return (
      <div className="flex px-1 pb-1">
        <Button type="button" variant="ghost" size="sm" className="max-md:h-11" data-testid="aside-ask-open" onClick={() => setOpen(true)}>
          {t("session.asideAsk.open")}
        </Button>
      </div>
    );
  return (
    <form className="flex flex-col gap-1 px-1 pb-1" data-testid="aside-ask" onSubmit={(e) => (e.preventDefault(), submit())}>
      <div className="flex gap-2">
        <input
          ref={input}
          aria-label={t("session.asideAsk.label")}
          placeholder={t("session.asideAsk.placeholder")}
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm max-md:h-11"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}
        />
        <Button type="submit" size="sm" className="max-md:h-11">
          {t("session.asideAsk.submit")}
        </Button>
      </div>
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
    </form>
  );
}
