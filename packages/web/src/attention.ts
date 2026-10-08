// The count of sessions waiting for the user, in the browser tab (docs/spec.md "Focus"): title and favicon. No blinking, no animation.
import { waitingStatus } from "./focus.ts";

const ICON = "/icon.svg";

/** The page's own icon with a marker whose shape differs (a diamond at the top-right corner), so it reads without color; the plain icon at 0. */
export function faviconHref(waiting: number): string {
  if (!waiting) return ICON;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#d97757"/>' +
    '<path d="M160 176l96 80-96 80M272 352h96" fill="none" stroke="#fff" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M400 0l112 112-112 112-112-112z" fill="#f2b705" stroke="#fff" stroke-width="24" stroke-linejoin="round"/></svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** What the single status region says: a full phrase, and nothing until the count was above 0 once (a page load with nothing waiting stays silent). */
export const announcement = (waiting: number, wasWaiting: boolean) => (waiting > 0 || wasWaiting ? waitingStatus(waiting) : "");

/** Sets the favicon of the page. */
export function setFavicon(href: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link && link.getAttribute("href") !== href) link.setAttribute("href", href);
}
