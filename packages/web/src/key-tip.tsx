// Key promoter toast (docs/spec.md "Keyboard shortcuts" › Shortcut tips): after the 2nd, 5th and 10th mouse click on a command button,
// a toast names its shortcut, or offers to assign one. Never on touch; never takes focus; role=status (polite).
import { useEffect, useRef, useState } from "react";
import { Toast } from "./toast.tsx";
import { useKeymap } from "./keymap.ts";
import { keyText, shortcutById } from "./shortcuts.ts";
import { shortcutTitle } from "./shortcut-titles.ts";
import { recordClick, setKeyTipsOn, useKeyTipsOn } from "./key-tips.ts";
import { Switch } from "./plugins-dialog.tsx";
import { useT } from "./i18n.ts";

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

/** A modal dialog (any `aria-modal`: MCP servers, plugins, worktree name, viewers, ...) is open: the tip would sit over it, out of reach of its focus trap. */
function useModalOpen() {
  const [open, setOpen] = useState(() => !!document.querySelector('[aria-modal="true"]'));
  useEffect(() => {
    const check = () => setOpen(!!document.querySelector('[aria-modal="true"]'));
    check();
    const mo = new MutationObserver(check);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-modal"] });
    return () => mo.disconnect();
  }, []);
  return open;
}

export function KeyTips({ hidden, onAssign, onTurnedOff }: { hidden: boolean; onAssign: (id: string) => void; onTurnedOff: () => void }) {
  const t = useT();
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
  const modal = useModalOpen();
  const shown = !!tip && !hidden && !modal;
  const s = tip && shortcutById(tip.id);
  const spec = tip && specOf(tip.id);
  const text = !tip || !s ? "" : spec ? `${shortcutTitle(s.id)}: ${keyText(spec)}` : t("keyTip.noShortcut", { title: shortcutTitle(s.id) });
  // The polite live region is always mounted and gets its text after mount: screen readers announce a change, not a region created with its text.
  const [said, setSaid] = useState("");
  useEffect(() => setSaid(shown ? text : ""), [shown, text, tip?.n]);
  const live = <div role="status" aria-live="polite" className="sr-only" data-testid="key-tip-status">{said}</div>;
  if (!tip || !s || !shown) return live;
  const close = () => setTip(undefined);
  return (
    <>
      {live}
      {spec ? (
        <Toast key={tip.n} message={text} action={{ label: t("keyTip.turnOff"), onClick: () => (setKeyTipsOn(false), onTurnedOff()) }} onClose={close} bigTargets silent />
      ) : (
        <Toast key={tip.n} message={text} action={{ label: t("keyTip.assign"), onClick: () => onAssign(tip.id) }} onClose={close} bigTargets silent />
      )}
    </>
  );
}

/** Settings › Keyboard row. */
export function KeyTipsRow() {
  const t = useT();
  const on = useKeyTipsOn();
  return (
    <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
      <div className="min-w-0 flex-1">
        <span className="block text-sm">{t("keyTip.label")}</span>
        <span id="settings-key-tips-hint" className="block text-muted-foreground text-xs">
          {t("keyTip.hint")}
        </span>
      </div>
      <Switch on={on} label={t("keyTip.label")} held={false} onToggle={setKeyTipsOn} title={t("keyTip.label")} describedBy="settings-key-tips-hint" testId="settings-key-tips" />
    </div>
  );
}
