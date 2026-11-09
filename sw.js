// Service worker: keeps the whole app on the device so it works with no connection.
// The build script rewrites CACHE_VERSION whenever any app file changes.
const CACHE_VERSION = 'b86dd36edc';
const CACHE = `expense-checker-${CACHE_VERSION}`;
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/version.js',
  'js/config.js',
  'js/access.js',
  'js/pdftext.js',
  'js/parser.js',
  'js/engine.js',
  'js/contract.js',
  'js/stations.js',
  'js/tables.js',
  'js/tablestore.js',
  'vendor/pdf.min.mjs',
  'vendor/pdf.worker.min.mjs',
  'img/howto-period.png',
  'img/howto-plus.png',
  'img/howto-exp.png',
  'img/howto-more.png',
  'img/howto-print.png',
  'img/howto-bbp-list.png',
  'img/howto-bbp-dots.png',
  'img/howto-bbp-menu.png',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('expense-checker-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // the on/off switch must always come from the network, never from the offline copy
  if (new URL(req.url).pathname.endsWith('/status.json')) return;
  if (req.mode === 'navigate') {
    event.respondWith(caches.match('index.html').then((hit) => hit || fetch(req)));
    return;
  }
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
