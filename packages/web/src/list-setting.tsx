import { useState } from "react";
import { PencilIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isImeKey } from "./ime.ts";
import { useT } from "./i18n.ts";

/** A list of strings, edited like VS Code's settings UI: a row per entry with Edit and Remove, "Add item" opens an input with OK / Cancel. Every OK saves the whole array. */
export function ListSetting({ id, label, hint, value, saving, onSave }: { id: string; label: string; hint: string; value: string[]; saving: boolean; onSave: (next: string[]) => Promise<void> }) {
  const tr = useT();
  // index of the entry being edited; value.length = a new entry.
  const [at, setAt] = useState<number>();
  const [text, setText] = useState("");
  const open = (i: number) => (setAt(i), setText(value[i] ?? ""));
  const cancel = () => setAt(undefined);
  const commit = async () => {
    const t = text.trim();
    if (at === undefined || t === "") return cancel();
    const next = [...value];
    next[at] = t;
    try {
      await onSave(next);
      setAt(undefined);
    } catch {}
  };
  const remove = (i: number) => void onSave(value.filter((_, j) => j !== i)).catch(() => {});
  const input = (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        value={text}
        aria-label={label}
        disabled={saving}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isImeKey(e.nativeEvent)) return;
          if (e.key === "Enter") void commit();
          else if (e.key === "Escape") {
            e.stopPropagation();
            cancel();
          }
        }}
        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11"
        data-testid={`${id}-input`}
      />
      <Button size="sm" className="cursor-pointer max-md:h-11" disabled={saving} onClick={() => void commit()} data-testid={`${id}-ok`}>
        OK
      </Button>
      <Button variant="outline" size="sm" className="cursor-pointer max-md:h-11" disabled={saving} onClick={cancel} data-testid={`${id}-cancel`}>
        {tr("list.cancel")}
      </Button>
    </div>
  );
  return (
    <div role="group" aria-labelledby={`${id}-label`} className="flex flex-col gap-1 border-t py-2" data-testid={id}>
      <span id={`${id}-label`} className="block text-sm">{label}</span>
      <span id={`${id}-hint`} className="block text-muted-foreground text-xs">{hint}</span>
      <ul className="flex flex-col">
        {value.map((v, i) => (
          <li key={`${i}:${v}`} className="flex items-center gap-1 py-0.5" data-testid={`${id}-item`}>
            {at === i ? (
              <div className="min-w-0 flex-1">{input}</div>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={v}>{v}</span>
                <button type="button" aria-label={tr("list.editItem", { item: v })} title={tr("list.edit")} disabled={saving} onClick={() => open(i)} className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:size-11" data-testid={`${id}-edit`}>
                  <PencilIcon className="size-3.5" />
                </button>
                <button type="button" aria-label={tr("list.removeItem", { item: v })} title={tr("list.remove")} disabled={saving} onClick={() => remove(i)} className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:size-11" data-testid={`${id}-remove`}>
                  <XIcon className="size-3.5" />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {at === value.length ? (
        input
      ) : (
        <div>
          <Button variant="outline" size="sm" className="cursor-pointer max-md:h-11" disabled={saving} onClick={() => open(value.length)} data-testid={`${id}-add`}>
            {tr("list.add")}
          </Button>
        </div>
      )}
    </div>
  );
}
