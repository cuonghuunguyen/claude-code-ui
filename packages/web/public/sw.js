// Service worker for Web Push (docs/spec.md "Push notifications"). The payload is a PushPayload from @claude-ui/protocol.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  const p = e.data?.json();
  if (!p) return;
  // tag: a newer push with the same tag (default: the session) replaces the older notification, silently when `silent`
  // (a replace push shows "No longer needs input" over a request that settled: a push must always show something).
  e.waitUntil(self.registration.showNotification(p.title, { body: p.body, tag: p.tag ?? p.sessionId, data: p, icon: "/icon.svg", silent: !!p.silent, renotify: false }));
});

// Opens the session scrolled to the bottom: in an open tab (the app listens for "open"), else in a new window.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const { sessionId } = e.notification.data;
  e.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const tab = tabs.find((c) => new URL(c.url).hash === `#${sessionId}`) ?? tabs[0];
      if (!tab) return self.clients.openWindow(`/#${sessionId}`);
      // Message first: focus() throws without the click's user activation.
      tab.postMessage({ type: "open", sessionId });
      await tab.focus();
    })(),
  );
});
