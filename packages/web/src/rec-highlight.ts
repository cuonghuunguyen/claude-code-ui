// GH-722: Show me for a recommendation that points at a button or menu item: the locate ring (locate.ts), and focus.
import { ringLocate } from "./locate.ts";

/** Rings and focuses the first rendered element matching `selector` and returns it; none rendered: undefined. */
export function highlight(selector: string): HTMLElement | undefined {
  const el = [...document.querySelectorAll<HTMLElement>(selector)].find((e) => e.checkVisibility?.() !== false);
  if (!el) return undefined;
  ringLocate(el);
  el.focus?.({ preventScroll: true });
  return el;
}

/** Show me for a context-menu item: opens the context menu of `row` again, then rings `selector` once the menu has rendered. */
export function reopenMenu(row: HTMLElement | undefined, selector: string, tries = 20) {
  if (!row) return;
  const r = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + Math.min(r.width / 2, 40), clientY: r.top + r.height / 2 }));
  const poll = (n: number) => {
    if (!highlight(selector) && n > 0) setTimeout(() => poll(n - 1), 50);
  };
  poll(tries);
}

/** The session's sidebar row when the user can see it: rendered, not display:none and inside the window (a closed phone drawer is only moved off screen). */
export function sessionRow(id: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="session-item"][data-session-id="${CSS.escape(id)}"]`)].find((e) => {
    if (e.checkVisibility?.() === false) return false;
    const r = e.getBoundingClientRect();
    return r.right > 0 && r.left < window.innerWidth;
  });
}
