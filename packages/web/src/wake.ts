// Page lifecycle signals that mean "the phone woke up or the network came back": the socket may be dead without the page knowing.
// onWake(force): force = the signal itself says the connection may be stale (online, a page restored from the back/forward cache), so probe without waiting for a long hide.
export type WakeEvents = (onWake: (force?: boolean) => void, onHide: () => void) => () => void;

export const browserWakeEvents: WakeEvents = (onWake, onHide) => {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const visibility = () => (document.visibilityState === "hidden" ? onHide() : onWake());
  const pageshow = (e: PageTransitionEvent) => onWake(e.persisted);
  const online = () => onWake(true);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pageshow", pageshow);
  window.addEventListener("online", online);
  return () => {
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pageshow", pageshow);
    window.removeEventListener("online", online);
  };
};
