import type { KeyboardEvent } from "react";

const TABBABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';
// tabindex="-1" (a roving tabindex group's other members) is not a tab stop.
const SKIP = '[tabindex="-1"]';

/**
 * Not rendered, so focus() would do nothing. Uses checkVisibility (display:none or content-visibility:hidden on the control or any
 * ancestor, a closed <details>, visibility:hidden on the control) when the browser has it; jsdom lacks it, so the ancestor walk
 * (display:none, hidden, inert, closed details, content-visibility:hidden) stands in. visibility:hidden is checked only on the control:
 * a descendant may set visibility:visible again.
 */
function isRendered(el: HTMLElement, root: HTMLElement) {
  if (typeof el.checkVisibility === "function") return el.checkVisibility({ visibilityProperty: true }) && !el.closest("[inert]");
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (n.hidden || n.hasAttribute("inert")) return false;
    const style = getComputedStyle(n);
    if (style.display === "none" || (n === el && style.visibility === "hidden")) return false;
    if (n !== el && style.contentVisibility === "hidden") return false;
    const up: HTMLElement | null = n.parentElement;
    if (up instanceof HTMLDetailsElement && !up.open && n !== up.querySelector(":scope > summary")) return false;
    if (n === root) break;
  }
  return true;
}

/**
 * Keydown handler for a modal popup: Tab and Shift+Tab wrap among its controls.
 * Base UI's focus guards move the focus back asynchronously, so fast Shift+Tab presses reached the page behind the dialog.
 */
export function trapTab(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "Tab" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  // A portaled popup (a select's list) inside the dialog bubbles here: it handles its own Tab.
  if (!e.currentTarget.contains(e.target as Node)) return;
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => !el.hasAttribute("data-base-ui-focus-guard") && !el.matches(SKIP) && isRendered(el, e.currentTarget));
  if (!all.length) return;
  const active = document.activeElement as HTMLElement;
  const at = all.indexOf(active);
  let order: HTMLElement[];
  if (at >= 0) {
    // Every control once, starting at the neighbour in the direction of travel.
    const step = e.shiftKey ? -1 : 1;
    order = all.map((_, i) => all[(((at + step * (i + 1)) % all.length) + all.length) % all.length]!);
  } else {
    // Focus is on a non-tab stop (a roving group's other member): move on from its place in the document.
    const group = active.closest('[role="radiogroup"]');
    const out = all.filter((el) => !group?.contains(el));
    const after = out.findIndex((el) => active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    const to = e.shiftKey ? (after < 0 ? out.length : after) - 1 : after < 0 ? 0 : after;
    order = out.map((_, i) => out[(((to + (e.shiftKey ? -i : i)) % out.length) + out.length) % out.length]!);
  }
  // Swallow the Tab only once a control has taken the focus; a control that refuses it (a closed details, content-visibility) is skipped.
  for (const el of order) {
    el.focus();
    if (document.activeElement === el) return void e.preventDefault();
  }
}
