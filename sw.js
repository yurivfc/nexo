const C = 'nexo-v3.1.0';
const A = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './sync.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(A))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  const sdk = u.hostname === 'www.gstatic.com' && u.pathname.startsWith('/firebasejs/');
  if (u.origin !== location.origin && !sdk) return; // Firebase (login/banco) passa direto, sem cache
  if (sdk) { e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => { const cp = res.clone(); caches.open(C).then(c => c.put(req, cp)); return res; }))); return; }
  e.respondWith(fetch(req).then(res => { const cp = res.clone(); caches.open(C).then(c => c.put(req, cp)); return res; })
    .catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
});
