import type { KeyboardEvent } from "react";

const TABBABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';
// tabindex="-1" (a roving tabindex group's other members) is not a tab stop.
const SKIP = '[tabindex="-1"]';

/**
 * Not rendered, so focus() would do nothing: display:none, hidden or inert (the control or an ancestor within `root`),
 * a closed <details> (outside its summary), a content-visibility:hidden ancestor, or visibility:hidden (the control only:
 * a descendant can override an ancestor's visibility). checkVisibility() answers first where it exists (jsdom lacks it,
 * and it knows nothing of inert), then the ancestor walk covers the rest.
 */
function isRendered(el: HTMLElement, root: HTMLElement) {
  if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return false;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (n.hidden || n.hasAttribute("inert")) return false;
    const style = getComputedStyle(n);
    if (style.display === "none" || (n === el && style.visibility === "hidden")) return false;
    if (n !== el && style.getPropertyValue("content-visibility") === "hidden") return false;
    if (n !== el && n instanceof HTMLDetailsElement && !n.open && !isInSummary(el, n)) return false;
    if (n === root) break;
  }
  return true;
}

/** The control sits in the details' own summary (its first summary child), which stays visible when closed. */
function isInSummary(el: HTMLElement, details: HTMLDetailsElement) {
  const summary = [...details.children].find((c) => c.localName === "summary");
  return !!summary?.contains(el);
}

/** Focus the first of `candidates` that takes it; true when focus moved, so a swallowed Tab is never prevented. */
function focusFirst(candidates: (HTMLElement | undefined)[]) {
  for (const c of candidates) {
    c?.focus();
    if (c && document.activeElement === c) return true;
  }
  return false;
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
  const step = e.shiftKey ? -1 : 1;
  // Candidates in Tab order from the current place, wrapping, ending with the current control itself.
  const from = (start: number, list: HTMLElement[]) => list.map((_, i) => list[(((start + step * i) % list.length) + list.length) % list.length]);
  let candidates: HTMLElement[];
  if (at < 0) {
    // Focus is on a non-tab stop (a roving group's other member): move on from its place in the document.
    const group = active.closest('[role="radiogroup"]');
    const out = all.filter((el) => !group?.contains(el));
    const after = out.findIndex((el) => active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    const to = e.shiftKey ? (after < 0 ? out.length : after) - 1 : after < 0 ? 0 : after;
    candidates = out.length ? from(to, out) : [];
  } else candidates = from(at + step, all);
  if (focusFirst(candidates)) e.preventDefault();
}
