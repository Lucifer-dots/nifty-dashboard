// App-shell cache only. Data (JSON snapshots / API) is always fetched from the network,
// so old numbers are never shown as if they were live.
const C = 'ra-pulse-v5', SHELL = ['./', 'static/style.css?v=5', 'static/app.js?v=5', 'static/vendor/lightweight-charts.js', 'static/icon.svg'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.pathname.includes('/api/') || u.hostname === 'raw.githubusercontent.com' || u.pathname.endsWith('.json')) return;
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request)));
});
