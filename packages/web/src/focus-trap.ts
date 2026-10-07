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
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => !el.hasAttribute("data-base-ui-focus-guard") && !el.matches(SKIP));
  if (!all.length) return;
  e.preventDefault();
  const at = all.indexOf(document.activeElement as HTMLElement);
  const next = at < 0 ? (e.shiftKey ? all.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + all.length) % all.length;
  all[next]!.focus();
}
