// The count of sessions waiting for the user, in the browser tab (docs/spec.md "Focus"): title and favicon. No blinking, no animation.
import { waitingStatus } from "./focus.ts";
import { iconSrc } from "./labels.ts";

const ICON = "/icon.svg";
const MARKER = '<path d="M400 0l112 112-112 112-112-112z" fill="#f2b705" stroke="#fff" stroke-width="24" stroke-linejoin="round"/>';
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const dataSvg = (inner: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${inner}</svg>`)}`;

/**
 * The page's own icon (or the custom `icon` of Settings › Appearance: an emoji or a raster data URL) with a marker whose shape
 * differs (a diamond at the top-right corner), so it reads without color; the plain icon at 0.
 */
export function faviconHref(waiting: number, icon = ""): string {
  const img = iconSrc(icon);
  if (!waiting) return img ?? (icon ? dataSvg(emojiText(icon)) : ICON);
  if (img) return dataSvg(`<image href="${img}" width="512" height="512"/>${MARKER}`);
  if (icon) return dataSvg(emojiText(icon) + MARKER);
  return dataSvg('<rect width="512" height="512" rx="96" fill="#d97757"/><path d="M160 176l96 80-96 80M272 352h96" fill="none" stroke="#fff" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>' + MARKER);
}
/** Same geometry as the daemon's /app-icon SVG. */
const emojiText = (e: string) => `<text x="256" y="256" font-size="400" text-anchor="middle" dominant-baseline="central">${xml(e)}</text>`;


/** What the single status region says: a full phrase, and nothing until the count was above 0 once (a page load with nothing waiting stays silent). */
export const announcement = (waiting: number, wasWaiting: boolean) => (waiting > 0 || wasWaiting ? waitingStatus(waiting) : "");

/** Sets the favicon of the page. */
export function setFavicon(href: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link && link.getAttribute("href") !== href) link.setAttribute("href", href);
}

/** The iOS home-screen icon: the daemon's /app-icon when a custom icon is set, else the built-in one. */
export function setAppleTouchIcon(icon: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  const href = icon ? "/app-icon" : "/apple-touch-icon.png";
  if (link && link.getAttribute("href") !== href) link.setAttribute("href", href);
}

/** The name iOS gives the page when it is added to the home screen (the installed app's name elsewhere comes from the manifest). */
export function setAppleTitle(name: string) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
  if (meta && meta.getAttribute("content") !== name) meta.setAttribute("content", name);
}
