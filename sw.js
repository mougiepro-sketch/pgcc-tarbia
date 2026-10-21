/* PGCC Tarbia: makes the app open fast and work offline.
   - App page and config: try the network for up to 2.5 seconds, otherwise open from the phone's cache.
   - Library, icons and fonts: served straight from the phone's cache (they never change).
   - Account data (supabase.co) is never cached. */
const CACHE = "pgcc-tarbia-v8";
const SHELL = ["./", "index.html", "config.js", "supabase-adapter.js", "supabase-2.117.2.js", "manifest.webmanifest", "icon-192.png", "apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });

function put(req, res){ if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; }
function networkFirst(req, ms){
  return new Promise(resolve => {
    let done = false;
    const fromCache = () => caches.match(req, {ignoreSearch: true}).then(r => r || (req.mode === "navigate" ? caches.match("index.html") : undefined));
    const timer = setTimeout(() => fromCache().then(r => { if (r && !done) { done = true; resolve(r); } }), ms);
    fetch(req).then(res => {
      put(req, res);
      if (!done) { done = true; clearTimeout(timer); resolve(res.ok || res.status === 304 ? res : fromCache().then(r => r || res)); }
    }).catch(() => { clearTimeout(timer); if (!done) { done = true; resolve(fromCache().then(r => r || Response.error())); } });
  });
}
function cacheFirst(req){ return caches.match(req).then(r => r || fetch(req).then(res => put(req, res))); }

self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return;
  const sameOrigin = url.origin === location.origin;
  if (url.hostname.includes("fonts.") || (sameOrigin && /\.(png|js)$/.test(url.pathname) && /supabase-\d|icon|favicon|apple-touch/.test(url.pathname))) { e.respondWith(cacheFirst(req)); return; }
  if (sameOrigin) { e.respondWith(networkFirst(req, 2500)); return; }
});
