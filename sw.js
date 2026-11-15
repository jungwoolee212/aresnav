// Offline support. On Mars a crew can't count on a network link: dust storms, terrain blocking the line of
// sight to a relay, or simply being far from the habitat. So once the app has been opened and a route planned
// with a connection, everything needed to follow that route keeps working with no network:
//  - the app itself, its libraries and fonts (cached on first visit),
//  - the prebuilt Gale crater terrain (data/),
//  - every NASA Mars Trek map tile and elevation tile the app has already loaded (the planned route and its
//    surroundings), kept between visits.
// New places that were never loaded still need a connection.

const VERSION = "2026-11-15k";                 // bump to ship a new app version
const SHELL = `marswalk-shell-${VERSION}`;     // app code: replaced on each version
const LIBS = "marswalk-libs";                  // CDN libraries and fonts: pinned versions, kept
const TREK = "marswalk-trek";                  // NASA Mars Trek tiles and elevation: kept across versions
const TREK_MAX = 6000;                         // oldest Trek entries are dropped past this

const APP_FILES = [
  "./", "index.html", "css/app.css",
  "js/app.js", "js/catalog.js", "js/conditions.js", "js/science.js", "js/extras.js", "js/hud.js", "js/map3d.js", "js/mission.js", "js/nav.js", "js/places.js", "js/planner.js",
  "js/sun.js", "js/terrain-live.js", "js/terrain3d.js", "js/ui-ko.js", "js/voice-ko.js", "js/voice.js",
  "data/site.json", "data/elev.bin", "data/terrain.bin", "data/hazard.png", "data/rough.png", "data/slope.png",
];
const LIB_FILES = [
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
  "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
  "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js",
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600;700&display=swap",
];
const LIB_HOSTS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(APP_FILES.map((f) => new Request(f, { cache: "reload" })));
    const libs = await caches.open(LIBS);
    await Promise.all(LIB_FILES.map(async (u) => { if (!(await libs.match(u))) { try { await libs.add(u); } catch {} } }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("marswalk-shell-") && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                                  // Claude API calls etc. go straight out
  const url = new URL(req.url);
  if (url.origin === self.location.origin) e.respondWith(appFile(req));
  else if (LIB_HOSTS.includes(url.hostname)) e.respondWith(cacheFirst(LIBS, req));
  else if (url.hostname === "trek.nasa.gov") e.respondWith(cacheFirst(TREK, req, TREK_MAX));
});

// App files: network first so updates show up at once; the cached copy when offline (or the network is slow)
async function appFile(req) {
  const cache = await caches.open(SHELL);
  const net = fetch(req).then((res) => { if (res.ok) cache.put(stripSearch(req), res.clone()); return res; });
  net.catch(() => {});
  try {
    return await withTimeout(net, 4000);
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === "navigate" && await cache.match("index.html"));
    return hit || net;                                               // nothing saved yet: wait for the network after all
  }
}

// Libraries and Trek tiles never change at a given URL: serve the saved copy, fetch and save it otherwise
async function cacheFirst(name, req, max = 0) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") {
    await cache.put(req, res.clone());
    if (max && Math.random() < 0.02) trim(cache, max);
  }
  return res;
}

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}
const stripSearch = (req) => { const u = new URL(req.url); u.search = ""; return u.toString(); };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
