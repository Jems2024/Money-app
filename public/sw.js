/**
 * STOP SPEND — Service Worker (`public/sw.js`)
 *
 * Security & Privacy Invariants (Section 10 & 11):
 * 1. Caches ONLY the static application shell (`/`, `/index.html`, `/manifest.webmanifest`, `/icon.svg`).
 * 2. NEVER caches authenticated Supabase REST/RPC responses or banking endpoints.
 * 3. Deduplicates Web Push notifications using `payload.tag` and opens deep links without
 *    exposing sensitive financial data in URLs.
 */

const CACHE_NAME = 'stop-spend-shell-v2';
const BASE_PATH = self.registration?.scope ? new URL(self.registration.scope).pathname : '/';
const STATIC_SHELL_URLS = [
  BASE_PATH,
  `${BASE_PATH.replace(/\/$/, '')}/index.html`,
  `${BASE_PATH.replace(/\/$/, '')}/manifest.webmanifest`,
  `${BASE_PATH.replace(/\/$/, '')}/icon.svg`,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_SHELL_URLS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_SHELL_CACHE_ON_LOGOUT') {
    // Only clear dynamic caches if any existed; unsynced queue lives in IndexedDB/localStorage namespaced by user
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') {
    return;
  }

  const url = new URL(req.url);
  // NEVER cache Supabase, API, Edge Functions, or bank auth callback routes
  if (
    url.pathname.startsWith('/rest/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/functions/') ||
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('enablebanking.com')
  ) {
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html'))
    );
  }
});

self.addEventListener('push', (event) => {
  let payload = {
    title: 'STOP SPEND — Aviso de presupuesto',
    body: 'Has alcanzado un umbral de tu presupuesto personal.',
    tag: 'stopspend-default-alert',
    deepLinkUrl: '/presupuestos',
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = {
        title: parsed.title || payload.title,
        body: parsed.body || payload.body,
        tag: parsed.tag || payload.tag,
        deepLinkUrl: parsed.deepLinkUrl || '/presupuestos',
      };
    } catch {
      // Fallback to privacy-safe default
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      renotify: false,
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: {
        deepLinkUrl: payload.deepLinkUrl,
      },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.deepLinkUrl) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.postMessage({ type: 'NAVIGATE_FROM_PUSH', targetUrl });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
