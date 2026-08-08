// Service Worker：離線快取 + 背景推播接收
const CACHE = '813-pwa-v1';
const ASSETS = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'logic.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/badge-96.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 靜態資源走快取優先；API 一律走網路（看診進度不能給舊資料）
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
            return res;
          })
          .catch(() => caches.match('index.html'))
    )
  );
});

// 背景推播：App 關著、螢幕鎖住時由 Worker 送過來
self.addEventListener('push', (e) => {
  let data = { title: '看診進度', body: '' };
  try {
    if (e.data) data = e.data.json();
  } catch (err) {
    if (e.data) data.body = e.data.text();
  }
  e.waitUntil(
    self.registration.showNotification(data.title || '看診進度', {
      body: data.body || '',
      tag: data.tag || 'clinic',
      renotify: true,
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-96.png',
      vibrate: data.urgent ? [220, 90, 220, 90, 320] : [140, 80, 140],
      requireInteraction: !!data.urgent,
      data: { url: './' }
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL('./', self.location).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(target) && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
