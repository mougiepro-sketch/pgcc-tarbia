/* PGCC Tarbia: makes the app open instantly and work offline.
   - App page, config and adapter: opened straight from the phone's cache, then quietly refreshed
     from the internet in the background, so the next open has any update.
   - Library, icons and fonts: served straight from the phone's cache (they never change).
   - Account data (supabase.co) is never cached. */
const CACHE = "pgcc-tarbia-v10";
const SHELL = ["./", "index.html", "config.js", "supabase-adapter.js", "supabase-2.117.2.js", "manifest.webmanifest", "icon-192.png", "apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, {cache: "reload"})))).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });

function put(key, res){ if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); } return res; }
/* cache first, refresh in the background; with nothing cached, wait for the network */
function staleWhileRevalidate(e, key){
  const net = fetch(e.request, {cache: "no-cache"}).then(res => put(key, res));
  e.waitUntil(net.catch(() => {}));
  return caches.match(key, {ignoreSearch: true}).then(r => r || net.catch(() => caches.match("index.html")));
}
function cacheFirst(req){ return caches.match(req).then(r => r || fetch(req).then(res => put(req, res))); }

self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return;
  const sameOrigin = url.origin === location.origin;
  if (url.hostname.includes("fonts.") || (sameOrigin && /\.(png|js)$/.test(url.pathname) && /supabase-\d|icon|favicon|apple-touch/.test(url.pathname))) { e.respondWith(cacheFirst(req)); return; }
  if (sameOrigin && req.mode === "navigate") { e.respondWith(staleWhileRevalidate(e, "index.html")); return; }
  if (sameOrigin && /\/(config|supabase-adapter)\.js$/.test(url.pathname)) { e.respondWith(staleWhileRevalidate(e, req)); return; }
  if (sameOrigin) { e.respondWith(fetch(req).then(res => put(req, res)).catch(() => caches.match(req, {ignoreSearch: true}))); }
});
