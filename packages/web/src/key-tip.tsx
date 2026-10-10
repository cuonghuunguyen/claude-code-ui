// Key promoter toast (docs/spec.md "Keyboard shortcuts" › Shortcut tips): after the 2nd, 5th and 10th mouse click on a command button,
// a toast names its shortcut, or offers to assign one. Never on touch; never takes focus; role=status (polite).
import { useEffect, useRef, useState } from "react";
import { Toast } from "./toast.tsx";
import { useKeymap } from "./keymap.ts";
import { keyText, shortcutById } from "./shortcuts.ts";
import { recordClick, setKeyTipsOn, useKeyTipsOn } from "./key-tips.ts";
import { Switch } from "./plugins-dialog.tsx";

/** The command a click counts for, or undefined: a mouse click (not touch, pen or keyboard) on an enabled [data-command] in the registry. */
export function clickedCommand(e: MouseEvent, lastPointer: string | undefined): string | undefined {
  if (e.detail === 0) return undefined; // keyboard Enter/Space, el.click()
  const type = "pointerType" in e ? (e as PointerEvent).pointerType : lastPointer; // older Safari sends a MouseEvent: the pointerdown's type
  if (type !== "mouse") return undefined;
  const el = (e.target as Element | null)?.closest?.("[data-command]");
  if (!el || el.closest('[aria-disabled="true"]')) return undefined;
  const id = el.getAttribute("data-command")!;
  return shortcutById(id) ? id : undefined;
}

export function KeyTips({ hidden, onAssign, onTurnedOff }: { hidden: boolean; onAssign: (id: string) => void; onTurnedOff: () => void }) {
  const on = useKeyTipsOn();
  const specOf = useKeymap();
  const [tip, setTip] = useState<{ n: number; id: string }>();
  const n = useRef(0);
  useEffect(() => {
    if (!on) return setTip(undefined); // switching off removes a shown or waiting tip
    let last: string | undefined;
    const down = (e: PointerEvent) => void (last = e.pointerType);
    const click = (e: MouseEvent) => {
      const id = clickedCommand(e, last);
      if (id && recordClick(id)) setTip({ n: ++n.current, id });
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("click", click, true);
    return () => (document.removeEventListener("pointerdown", down, true), document.removeEventListener("click", click, true));
  }, [on]);
  if (!tip || hidden) return null;
  const s = shortcutById(tip.id)!;
  const spec = specOf(tip.id);
  const close = () => setTip(undefined);
  return spec ? (
    <Toast key={tip.n} message={`${s.title}: ${keyText(spec)}`} action={{ label: "Turn off tips", onClick: () => (setKeyTipsOn(false), onTurnedOff()) }} onClose={close} />
  ) : (
    <Toast key={tip.n} message={`${s.title} has no shortcut.`} action={{ label: "Assign a shortcut…", onClick: () => onAssign(tip.id) }} onClose={close} />
  );
}

/** Settings › Keyboard row. */
export function KeyTipsRow() {
  const on = useKeyTipsOn();
  return (
    <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
      <div className="min-w-0 flex-1">
        <span className="block text-sm">Show shortcut tips</span>
        <span id="settings-key-tips-hint" className="block text-muted-foreground text-xs">
          After the 2nd, 5th and 10th click on a button, a tip shows its shortcut or offers to assign one. Not on touch screens. Kept in this browser.
        </span>
      </div>
      <Switch on={on} label="Show shortcut tips" held={false} onToggle={setKeyTipsOn} title="Show shortcut tips" describedBy="settings-key-tips-hint" testId="settings-key-tips" />
    </div>
  );
}
