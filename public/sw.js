// ============================================================================
// SERVICE WORKER - PWA & WEB PUSH NATIVO (80% y 100% de Sobres Familiares)
// ============================================================================

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload = {
    title: "Alerta Presupuesto Familiar",
    body: "Un sobre mensual ha superado el umbral configurado.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: "envelope-threshold",
    url: "/",
  };

  try {
    const parsed = event.data.json();
    payload = { ...payload, ...parsed };
  } catch {
    payload.body = event.data.text();
  }

  const options = {
    body: payload.body,
    icon: payload.icon || "/icon.svg",
    badge: payload.badge || "/icon.svg",
    tag: payload.tag || "family-finance-alert",
    vibrate: [200, 100, 200],
    data: {
      url: payload.url || "/",
    },
    actions: [
      {
        action: "open_dashboard",
        title: "Ver Sobres",
      },
    ],
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
