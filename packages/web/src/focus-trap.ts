import type { KeyboardEvent } from "react";

const TABBABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';
// tabindex="-1" (a roving tabindex group's other members) is not a tab stop.
const SKIP = '[tabindex="-1"]';

/**
 * Keydown handler for a modal popup: Tab and Shift+Tab wrap among its controls.
 * Base UI's focus guards move the focus back asynchronously, so fast Shift+Tab presses reached the page behind the dialog.
 */
export function trapTab(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "Tab" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  // A portaled popup (a select's list) inside the dialog bubbles here: it handles its own Tab.
  if (!e.currentTarget.contains(e.target as Node)) return;
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => !el.hasAttribute("data-base-ui-focus-guard") && !el.matches(SKIP));
  if (!all.length) return;
  e.preventDefault();
  const active = document.activeElement as HTMLElement;
  const at = all.indexOf(active);
  let next = (at + (e.shiftKey ? -1 : 1) + all.length) % all.length;
  if (at < 0) {
    // Focus is on a non-tab stop (a roving group's other member): move on from its place in the document.
    const group = active.closest('[role="radiogroup"]');
    const out = all.filter((el) => !group?.contains(el));
    const after = out.findIndex((el) => active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    const to = e.shiftKey ? (after < 0 ? out.length : after) - 1 : after < 0 ? 0 : after;
    return void out[(to + out.length) % out.length]?.focus();
  }
  all[next]!.focus();
}
