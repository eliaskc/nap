// Nap's service worker for notifications on the dashboard's origin (the bell in the bar). It
// only shows what Nap pushes and opens the page on a tap; it caches nothing.
self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { title: event.data ? event.data.text() : "" };
  }
  const title = message.title || "Nap";
  const body = [message.subtitle, message.body].filter(Boolean).join(" · ");
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/android-chrome-192x192.png",
      badge: "/favicon-32x32.png",
      data: { url: message.url || "/" },
      // A picture from the page (nap.notify's image), where the browser shows one.
      ...(message.image ? { image: message.image } : {}),
      // A newer one with the same tag replaces it; a quiet one replaces it without a sound.
      ...(message.tag ? { tag: message.tag, renotify: !message.quiet } : {}),
      silent: Boolean(message.quiet),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => client.url === url);
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
