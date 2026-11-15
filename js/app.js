// AresNav — choose a start and a destination, get the safest route, a hazard /
// elevation / sunlight / shielding assessment, and turn-by-turn guidance (map or helmet HUD).
// Data: NASA Mars Trek HiRISE mosaic + HiRISE DEM tiles (processed by tools/build_site_data.py),
// Trek global layers for context, and Mars sun astronomy. Nothing else.

import { loadSite, findPath, simplify, cellLatLon, cellOf, sampleAt, elevAt, distM, inSite, profileFor, passable,
  nearestPassable, horizons, skyOpen, horizonToward, MARS_R } from "./planner.js";
import { DEFAULTS, EXAMPLE, ABOUT_SITE } from "./mission.js";
import { marsClock, sunAt, daylight, seasonName } from "./sun.js";
import { buildManeuvers, stateAt, nextManeuver, maneuverIcon, headingAt, idxAtDist, compassWord } from "./nav.js";
import { renderTerrainView } from "./terrain3d.js";
import { openHud, closeHud, hudIsOpen, updateHud } from "./hud.js";
import { initVoice, voiceNavStart, voiceNavEnd, voiceTick, voiceToggleListen, voiceLang, voiceAsk } from "./voice.js";
import { nameKo } from "./voice-ko.js";
import { SCIENCE_SITES, OBJECTIVES } from "./science.js";
import { sandboxExport } from "./sandbox.js";
import { commsAlongRoute, walkDoseUSv, RAD_USV_PER_DAY, dustSeason, marsSpaceWeather, stormNow, BASE_ANT_M, SUIT_ANT_M, effortModel, CREW_SUIT_KG, BUDDY_PACE, RESCUE_PACE } from "./conditions.js";
import { curiosityLegs, compareWithCuriosity, GEO_TILES, routeGeology, toGPX, download, openRouteSheet } from "./extras.js";
import { uiKo, navKo, applyStatic } from "./ui-ko.js";
import { inExtent, normLon, sourcesFor, sourceLabel, corridorFor, covers, buildSite, hasData } from "./terrain-live.js";
import { CATALOG } from "./catalog.js";
import { open3d, close3d, is3dOpen, update as update3d, updatePosition as pos3d, clearPosition as clear3dPos } from "./map3d.js";
import { SITES } from "./mission.js";
import { PLACES_DATA } from "./places.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const hhmm = (sec) => { const m = Math.round(sec / 60); return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(((m % 60) + 60) % 60).padStart(2, "0")}`; };
const dur = (sec) => { const neg = sec < 0, m = Math.round(Math.abs(sec) / 60); const s = m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; return neg ? `−${s}` : s; };
const distTxt = (m) => (m >= 1000 ? `${fmt(m / 1000, m >= 10000 ? 0 : 1)} km` : `${fmt(Math.max(0, Math.round(m / 10) * 10))} m`);
const slopeColor = (s) => (s < 8 ? "#2fd68f" : s < 15 ? "#f5c84b" : s < 20 ? "#f58a3b" : "#e9354f");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// screen text follows the voice language (Korean or English)
const KOUI = () => voiceLang() === "ko";
const U = (s) => (KOUI() ? uiKo(s) : s);
const coordTxt = (p) => `${fmt(Math.abs(p.lat), 4)}°${p.lat < 0 ? "S" : "N"} ${fmt(p.lon, 4)}°E`;
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

// ---------------- state ----------------
const S = {
  site: null,
  opts: { ...DEFAULTS },
  mode: "walk",
  start: null, end: null, cps: [],   // points: {lat, lon, name, dwell?, id?}
  pick: null,                        // "start" | "end" | "cp" | null
  track: null, mans: null, ana: null, checks: null, error: null,
  busy: false,
};
let cpSeq = 1;
const startSec = () => { const [h, m] = (S.opts.startLMST || "09:00").split(":").map(Number); return h * 3600 + m * 60; };
const save = () => store.set("marswalk.v2", { mode: S.mode, opts: S.opts, start: S.start, end: S.end, cps: S.cps });

// ---------------- clock ----------------
function tickClock() {
  const t = marsClock();
  $("#clkSol").textContent = t.sol;
  $("#clkLmst").textContent = hhmm(t.lmstH * 3600);
  $("#clkUtc").textContent = new Date().toISOString().slice(11, 16);
}

// ---------------- map ----------------
const MarsCRS = L.extend({}, L.CRS.EPSG4326, { R: MARS_R });
const TREK = (id, ext = "png") => `https://trek.nasa.gov/tiles/Mars/EQ/${id}/1.0.0/default/default028mm/{z}/{y}/{x}.${ext}`;
const TREK_ATTR = '<a href="https://trek.nasa.gov/mars/" target="_blank" rel="noopener">NASA/JPL Mars Trek</a>';
// crossOrigin: tiles come back as normal (not opaque) responses, so the offline cache stores them compactly
const trek = (id, ext, maxNative, extra = {}) => L.tileLayer(TREK(id, ext), { maxNativeZoom: maxNative, maxZoom: 20, noWrap: true, crossOrigin: "anonymous", attribution: TREK_ATTR, ...extra });
let map, layerDefs, routeGroup, altGroup, casing, doneLine, markerGroup, dangerGroup, hoverDot, meMarker, sitePopup, siteRect, coverageLayer;

// ---- fitting the map to the route ----
// A map that has no size yet (layout not finished) would fit to the maximum zoom and look blank, so a fit
// waits until the map is laid out, never zooms past 18, and the first finished plan re-fits once.
let userMoved = false, fitPending = false, fitOnPlan = true;
function fitPad() {
  if (innerWidth > 760) return { paddingTopLeft: [420, 60], paddingBottomRight: [40, 40], maxZoom: 18 };
  // phones: the route card sits on top and the summary sheet at the bottom, so fit into the gap between them
  const mr = $("#map").getBoundingClientRect(), vis = (el) => el && !el.classList.contains("hidden") && el.offsetParent !== null;
  const topEl = vis($("#voice.in-plan")) ? $("#voice") : $(".route-card"), sheet = vis($("#sheet")) ? $("#sheet") : $("#emptyCard");
  let top = topEl ? topEl.getBoundingClientRect().bottom - mr.top + 12 : 60, bottom = vis(sheet) ? mr.bottom - sheet.getBoundingClientRect().top + 12 : 40;
  if (mr.height - top - bottom < 140) { const k = (mr.height - 140) / Math.max(1, top + bottom); top *= k; bottom *= k; }
  return { paddingTopLeft: [24, Math.max(0, top)], paddingBottomRight: [24, Math.max(0, bottom)], maxZoom: 18 };
}
function routeBounds() {
  if (S.track) return L.latLngBounds(S.track.pts.map((p) => [p.lat, p.lon]));
  const pts = [S.start, ...S.cps, S.end].filter(Boolean);
  return pts.length ? L.latLngBounds(pts.map((p) => [p.lat, p.lon])) : null;
}
function fitRoute(animate = true) {
  const b = routeBounds();
  if (!b || !map) return;
  const sz = map.getSize();
  if (sz.x < 200 || sz.y < 200) { fitPending = true; return; }
  fitPending = false;
  map.fitBounds(b.getNorthEast().equals(b.getSouthWest()) ? b.pad(0.01) : b, { ...fitPad(), animate });
}

// switch the terrain grid the planner uses (prebuilt site or a corridor analysed in the browser)
function setSite(site) {
  if (S.site === site) return;
  S.site = site;
  const b = site.bbox, bounds = L.latLngBounds([[b.south, b.west], [b.north, b.east]]);
  for (const d of layerDefs.overlays) if (d.key) { d.layer.setUrl(site.overlays[d.key]); d.layer.setBounds(bounds); }
  siteRect.setBounds(bounds);
  renderAbout();
  sync3d(true);
}
const points3d = () => [S.start && { ...S.start, kind: "start" }, ...S.cps.map((c) => ({ ...c, kind: "cp" })), S.end && { ...S.end, kind: "end" }].filter(Boolean);
function sync3d(refit = false) { if (is3dOpen()) update3d({ site: S.site, track: S.track, points: points3d() }, refit); }
async function setView(mode) {
  const three = mode === "3d";
  $("#view3d").classList.toggle("on", three); $("#view2d").classList.toggle("on", !three);
  $("#view3d").setAttribute("aria-pressed", three); $("#view2d").setAttribute("aria-pressed", !three);
  $$("[data-view]").forEach((b) => b.classList.toggle("active", (b.dataset.view === "3d") === three));
  if (!three) { close3d(); $("#map").style.visibility = ""; map.invalidateSize(); return; }
  $("#map").style.visibility = "hidden";
  try {
    await open3d($("#map3d"), { site: S.site, track: S.track, points: points3d(), pick: (lat, lon) => {
      if (NAV) return;
      if (S.start && S.end && !S.pick) { toast("Start and destination are set. Use + Add checkpoint, then click the ground, or edit in 2D."); return; }
      onMapClick({ latlng: { lat, lng: lon } });
    } });
  } catch (e) { toast(`The 3D view couldn't load (${e.message}).`); setView("2d"); }
}

function initMap() {
  const b = S.site.bbox;
  map = L.map("map", { crs: MarsCRS, zoomControl: false, minZoom: 2, maxZoom: 20, attributionControl: true, zoomSnap: 0.25 });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  const FitCtl = L.Control.extend({ options: { position: "topright" }, onAdd() {
    const el = L.DomUtil.create("button", "fit-ctl");
    el.title = "Show the whole route"; el.setAttribute("aria-label", el.title);
    el.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
    L.DomEvent.disableClickPropagation(el);
    el.addEventListener("click", () => fitRoute());
    return el;
  } });
  new FitCtl().addTo(map);
  L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
  map.attributionControl.setPrefix(false);
  map.setView([(b.south + b.north) / 2, (b.west + b.east) / 2], 12, { animate: false });
  new ResizeObserver(() => { map.invalidateSize({ pan: false }); if (fitPending) fitRoute(false); }).observe($("#map"));
  for (const ev of ["pointerdown", "wheel", "touchstart"]) map.getContainer().addEventListener(ev, () => { userMoved = true; }, { passive: true });
  buildLayers();
  // white: where routes can be planned (Gale HiRISE coverage); orange: ground analysed for the current route
  // where Trek has a regional elevation model sharp enough for EVA planning (elsewhere: global 200 m blend)
  coverageLayer = L.layerGroup(CATALOG.dems.map((d) => L.rectangle([[d.bbox[1], d.bbox[0]], [d.bbox[3], d.bbox[2]]],
    { color: d.pxM <= 2 ? "#7dffc8" : "#b48cff", opacity: 0.7, weight: 1, dashArray: "2 5", fill: false, interactive: true })
    .bindTooltip(`${esc(d.title)}<br>${d.pxM < 10 ? d.pxM.toFixed(1) : Math.round(d.pxM)} m/px · ${d.kind === "image" ? "metres from Trek" : "8-bit tiles, metre scale fitted to MOLA+HRSC"}`, { sticky: true }))).addTo(map);
  siteRect = L.rectangle([[b.south, b.west], [b.north, b.east]], { color: "#e8743b", weight: 1.5, dashArray: "6 6", fill: false, interactive: false }).addTo(map);
  altGroup = L.layerGroup().addTo(map);
  routeGroup = L.layerGroup().addTo(map);
  dangerGroup = L.layerGroup().addTo(map);
  markerGroup = L.layerGroup().addTo(map);
  map.on("click", onMapClick);
  map.on("mousemove", (e) => probe(e.latlng.lat, e.latlng.lng));
  map.on("dragstart", () => { if (NAV) { NAV.follow = false; $("#navRecenter").classList.remove("hidden"); } });
}

function buildLayers() {
  const b = S.site.bbox, siteBounds = [[b.south, b.west], [b.north, b.east]];
  const msl = [[-4.93, 137.12], [-4.25, 137.73]];
  const viking = () => trek("Mars_Viking_MDIM21_ClrMosaic_global_232m", "jpg", 7);
  const ctx = () => trek("curiosity_ctx_mosaic", "png", 10, { bounds: [[-7.21, 136.28], [-3.58, 139.39]] });
  const hirise = () => L.layerGroup([trek("curiosity_hirise_mosaic", "png", 16, { bounds: msl }),
    // every other regional mosaic in the catalog, CTX under HiRISE
    ...CATALOG.mosaics.filter((m) => m.layer !== "curiosity_hirise_mosaic").sort((a, b) => (a.instrument === "CTX" ? -1 : 1) - (b.instrument === "CTX" ? -1 : 1))
      .map((m) => trek(m.layer, m.fmt, m.zmax, { bounds: [[m.bbox[1], m.bbox[0]], [m.bbox[3], m.bbox[2]]] }))]);
  layerDefs = {
    base: [
      { name: "HiRISE imagery", kind: "optical", desc: "MRO HiRISE ~25 cm/px mosaic over CTX 6 m/px and Viking colour.", make: () => L.layerGroup([viking(), ctx(), hirise()]), on: true },
      { name: "HiRISE elevation (DEM)", kind: "topographic", desc: "HiRISE stereo DEM of Gale crater; brighter = higher.", make: () => L.layerGroup([viking(), trek("Gale_DEM_SMG_1m", "png", 14, { bounds: msl })]) },
      { name: "CTX imagery", kind: "optical", desc: "MRO Context Camera mosaic of Gale crater, 6 m/px.", make: () => L.layerGroup([viking(), ctx()]) },
      { name: "MOLA colour shaded relief", kind: "topographic", desc: "MGS laser altimeter, 463 m/px. Blue low, red/white high.", make: () => trek("Mars_MGS_MOLA_ClrShade_merge_global_463m", "jpg", 7) },
      { name: "Viking colour mosaic", kind: "optical", desc: "Global true-colour context, 232 m/px (Viking MDIM 2.1, made by USGS Astrogeology).", make: () => viking() },
    ],
    overlays: [
      { name: "Mission sites & traverses", kind: "NASA Trek", desc: "Trek's mission bookmarks (dashed), rover traverses and waypoints: Curiosity, Perseverance, Spirit, Opportunity, Sojourner, Viking, InSight, Phoenix, The Martian. Click a point to start or end a route there.", make: missionLayer, on: true, noOpacity: true },
      { name: "IAU place names", kind: "NASA Trek", desc: "All 1,783 named features in Trek (craters, montes, valles…). Hover for the name; click to route there.", make: namesLayer, on: true, noOpacity: true },
      { name: "EVA hazard", kind: "safety", desc: "Slope + rock score the route planner uses. Red = no-go.", key: "hazard", make: () => L.imageOverlay(S.site.overlays.hazard, siteBounds), on: true, opacity: 0.45, legend: ["Hazard", "linear-gradient(90deg,rgba(30,220,140,.3),#ffd23c,#ff7828,#eb1e3c)", "low", "no-go"] },
      { name: "Slope", kind: "topographic", desc: "Slope from the HiRISE DEM (≈70 m baseline).", key: "slope", make: () => L.imageOverlay(S.site.overlays.slope, siteBounds), opacity: 0.7, legend: ["Slope", "linear-gradient(90deg,rgba(60,210,120,.4),#fadc3c,#fa7828,#e61e3c)", "0°", "30°+"] },
      { name: "Rock & ridge density", kind: "optical", desc: "Texture of the HiRISE imagery: boxwork ridges, blocks and outcrop edges light up.", key: "rough", make: () => L.imageOverlay(S.site.overlays.rough, siteBounds), opacity: 0.75, legend: ["Rocks", "linear-gradient(90deg,rgba(0,180,255,.15),#be50ff,#ff28c8)", "smooth", "dense"] },
      { name: "USGS geologic map (SIM 3292)", kind: "USGS", desc: "USGS global geologic map of Mars (Tanaka et al. 2014), 1:20,000,000, via NASA Trek. Regional context: units are tens of km across, so it can't choose between routes. The report names the units your route crosses.", make: () => L.tileLayer(GEO_TILES, { maxNativeZoom: 11, maxZoom: 20, noWrap: true, attribution: 'USGS SIM 3292 via <a href="https://trek.nasa.gov/mars/" target="_blank" rel="noopener">NASA Trek</a>' }), opacity: 0.45 },
      { name: "THEMIS night-time IR", kind: "thermal", desc: "Mars Odyssey 100 m/px. Bright = warm at night = bedrock / cemented ground; dark = dust and sand.", make: () => trek("THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018", "png", 9), opacity: 0.6 },
      { name: "THEMIS daytime IR", kind: "thermal", desc: "Mars Odyssey 100 m/px daytime infrared: morphology and sun-facing slopes.", make: () => trek("THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018", "png", 9), opacity: 0.6 },
      { name: "TES thermal inertia", kind: "thermal", desc: "MGS TES, regional dusty vs rocky ground.", make: () => trek("TES_Thermal_Inertia", "png", 1), opacity: 0.5 },
      { name: "TES glass / clay", kind: "spectral", desc: "MGS TES regional clay/glass abundance (water-altered minerals).", make: () => trek("TES_Glass_Clay", "png", 1), opacity: 0.5 },
      { name: "TES plagioclase", kind: "spectral", desc: "MGS TES regional plagioclase abundance (basaltic sand and rock).", make: () => trek("TES_Plagioclase", "png", 1), opacity: 0.5 },
      { name: "MOLA roughness", kind: "topographic", desc: "MGS MOLA km-scale surface roughness.", make: () => trek("mola_roughness", "png", 1), opacity: 0.5 },
    ],
  };
  let currentBase = null;
  for (const d of layerDefs.base) {
    d.layer = d.make();
    const lab = document.createElement("label");
    lab.innerHTML = `<input type="radio" name="base" ${d.on ? "checked" : ""}/><span class="ln">${d.name}<span class="kind">${d.kind}</span></span><span class="ld">${d.desc}</span>`;
    lab.querySelector("input").addEventListener("change", () => { if (currentBase) map.removeLayer(currentBase); currentBase = d.layer.addTo(map); });
    $("#baseLayers").appendChild(lab);
    if (d.on) currentBase = d.layer.addTo(map);
  }
  for (const d of layerDefs.overlays) {
    d.layer = d.make();
    d.layer.setOpacity?.(d.opacity);
    const lab = document.createElement("label");
    lab.innerHTML = `<input type="checkbox" ${d.on ? "checked" : ""}/><span class="ln">${d.name}<span class="kind">${d.kind}</span></span><span class="ld">${d.desc}</span>${d.noOpacity ? "" : `<input type="range" min="0.1" max="1" step="0.05" value="${d.opacity}" aria-label="${d.name} opacity"/>`}`;
    const cb = lab.querySelector("input[type=checkbox]"), rg = lab.querySelector("input[type=range]");
    cb.addEventListener("change", () => { cb.checked ? d.layer.addTo(map) : map.removeLayer(d.layer); renderLegend(); });
    rg?.addEventListener("input", () => d.layer.setOpacity(+rg.value));
    rg?.addEventListener("click", (e) => e.preventDefault());
    $("#overlayLayers").appendChild(lab);
    if (d.on) d.layer.addTo(map);
  }
  renderLegend();
  renderSites();
  $("#siteSearch").addEventListener("input", renderSites);
  renderOffline(); $("#btnSaveOffline").addEventListener("click", saveOfflineRoutes);
}
// jump-to list: mission sites, then every regional elevation model in the catalog

// ---------------- places NASA Trek marks: bookmarks, mission waypoints, traverses, IAU names ----------------
let placesRenderer = null;
const NAME_ZOOM = { Crater: 10, Mons: 7, Tholus: 9, Patera: 8, Vallis: 8, Planitia: 5, Planum: 6, Terra: 5, "Albedo Feature": 5, Chasma: 7, Fossa: 8, Labyrinthus: 7 };
const placeZoom = (kind) => NAME_ZOOM[kind] || 8;
// click a marked place: start, end or checkpoint there
function placePopup(p) {
  if (NAV) return;
  const html = `<div class="pop-read"><b>${esc(p.name)}</b><br><span class="muted">${esc(p.sub)}</span><br>${coordTxt(p)}</div>
    <div class="pop-btns"><button data-act="start"><span class="dot start"></span>Start here</button><button data-act="end"><span class="dot end"></span>Make this the destination</button>${S.start && S.end ? '<button data-act="cp"><span class="dot cp"></span>Add as checkpoint</button>' : ""}</div>`;
  const pop = L.popup({ maxWidth: 260 }).setLatLng([p.lat, p.lon]).setContent(html).openOn(map);
  pop.getElement().querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
    map.closePopup();
    if (setPoint(b.dataset.act, p.lat, p.lon, p.name)) { setPick(b.dataset.act === "start" && !S.end ? "end" : null); changed(); }
  }));
}
const TRAVERSE_COLOR = { "Curiosity traverse": "#ffb347", "Perseverance traverse": "#4aa3ff", "Opportunity traverse": "#c58cff", "Spirit traverse": "#7dffc8", "The Martian (Watney's route)": "#ff6b6b" };
function missionLayer() {
  placesRenderer ||= L.canvas({ padding: 0.5 });
  const g = L.layerGroup();
  for (const b of PLACES_DATA.bookmarks) if (b.bbox[2] - b.bbox[0] < 60)
    L.rectangle([[b.bbox[1], b.bbox[0]], [b.bbox[3], b.bbox[2]]], { color: "#ffd479", weight: 1, opacity: 0.55, dashArray: "4 6", fill: false, interactive: false }).addTo(g);
  for (const t of PLACES_DATA.traverses) for (const part of t.parts)
    L.polyline(part, { color: TRAVERSE_COLOR[t.name] || "#ffd479", weight: 2.5, opacity: 0.9 }).bindTooltip(esc(t.name), { sticky: true }).addTo(g);
  for (const [name, mission, lat, lon] of PLACES_DATA.waypoints)
    L.circleMarker([lat, lon], { radius: 5, color: "#1b0d05", weight: 1.5, fillColor: "#ffd479", fillOpacity: 1, renderer: placesRenderer, bubblingMouseEvents: false })
      .bindTooltip(`${esc(name)} · ${esc(mission)}`).on("click", () => placePopup({ name, sub: `${mission} · NASA Trek waypoint`, lat, lon })).addTo(g);
  return g;
}
function namesLayer() {
  placesRenderer ||= L.canvas({ padding: 0.5 });
  const g = L.layerGroup();
  for (const [name, lat, lon, kind] of PLACES_DATA.names)
    L.circleMarker([lat, lon], { radius: 3, color: "#cfd6e4", weight: 1, fillColor: "#cfd6e4", fillOpacity: 0.75, renderer: placesRenderer, bubblingMouseEvents: false })
      .bindTooltip(`${esc(name)}${kind ? ` · ${esc(kind)}` : ""}`).on("click", () => placePopup({ name, sub: `${kind || "Named feature"} · IAU name`, lat, lon })).addTo(g);
  return g;
}

function renderSites() {
  const bookmarks = PLACES_DATA.bookmarks.map((b) => ({ name: b.name, sub: "NASA Trek bookmark", lat: b.lat, lon: b.lon, zoom: 3,
    bounds: b.bbox[2] - b.bbox[0] < 60 ? [[b.bbox[1], b.bbox[0]], [b.bbox[3], b.bbox[2]]] : null }));
  const items0 = [...bookmarks, ...SITES.map((s) => ({ name: s.name, sub: sourceLabel(sourcesFor([s])[0]), lat: s.lat, lon: s.lon, zoom: s.zoom })),
    ...CATALOG.dems.filter((d) => !SITES.some((s) => sourcesFor([s])[0].id === d.id))
      .map((d) => ({ name: d.title.replace(/^(MRO|Mars Reconnaissance Orbiter|MEX) (HiRISE|CTX|HRSC),\s*(DEM\s*)?/, "").replace(/,? ?DEM\b,?/, "").trim(), sub: sourceLabel(d),
        bounds: [[d.bbox[1], d.bbox[0]], [d.bbox[3], d.bbox[2]]] }))];
  const q = ($("#siteSearch")?.value || "").trim().toLowerCase();
  let items = items0;
  if (q) {
    const all = [...items0, ...PLACES_DATA.waypoints.map(([name, m, lat, lon]) => ({ name, sub: `${m} waypoint`, lat, lon, zoom: 15, pick: true })),
      ...PLACES_DATA.names.map(([name, lat, lon, k]) => ({ name, sub: `${k || "Named feature"} · IAU`, lat, lon, zoom: placeZoom(k), pick: true }))];
    const lo = (it) => it.name.toLowerCase();
    items = [...all.filter((it) => lo(it).startsWith(q)), ...all.filter((it) => !lo(it).startsWith(q) && lo(it).includes(q))].slice(0, 40);
  }
  $("#siteList").innerHTML = items.length ? items.map((it, i) => `<button data-i="${i}">${esc(it.name)}<small>${esc(it.sub)}</small></button>`).join("") : '<p class="hint">No marked place by that name.</p>';
  $$("#siteList button").forEach((b) => b.addEventListener("click", () => {
    const it = items[+b.dataset.i]; flyToSite(it); if (innerWidth <= 760) closeDrawer();
    if (it.pick) setTimeout(() => placePopup(it), 1300);   // a single point: offer start / destination
  }));
}
// ---------------- offline routes ----------------
// Key traverses at real rover sites (Trek mission waypoints), all on sharp HiRISE / CTX elevation models. "Save all" plans each one once while online, which
// stores its terrain and map tiles in the offline cache (sw.js); afterwards they open with no network.
const KEY_ROUTES = [
  { id: "gale-boxwork", en: "Gale: Landing plain → Upper boxwork ridges", ko: "게일: 착륙 평원 → 상부 박스워크 능선", start: EXAMPLE.start, end: EXAMPLE.end },
  { id: "gale-murray", en: "Gale: Pahrump Hills → Murray Buttes", ko: "게일: 파럼프 힐스 → 머레이 뷰트",
    start: { name: "Pahrump Hills", lat: -4.6624, lon: 137.3772 }, end: { name: "Murray Buttes", lat: -4.6954, lon: 137.3533 } },
  { id: "gusev-homeplate", en: "Gusev: Columbia Memorial Station → Home Plate", ko: "구세프: 컬럼비아 기념 기지 → 홈 플레이트",
    start: { name: "Columbia Memorial Station", lat: -14.5719, lon: 175.4785 }, end: { name: "Home Plate", lat: -14.6061, lon: 175.5313 } },
  { id: "endeavour-marathon", en: "Endeavour: Matijevic Hill → Marathon Valley", ko: "인데버: 마티예비치 힐 → 마라톤 밸리",
    start: { name: "Matijevic Hill", lat: -2.2317, lon: -5.3554 }, end: { name: "Marathon Valley", lat: -2.3148, lon: -5.3525 } },
];
const offlineSaved = () => store.get("marswalk.offline") || {};
function renderOffline(status) {
  const saved = offlineSaved(), ko = KOUI();
  $("#offlineList").innerHTML = KEY_ROUTES.map((r, i) => `<button data-i="${i}">${esc(ko ? r.ko : r.en)}<small>${saved[r.id] ? (ko ? "✓ 오프라인 저장됨" : "✓ saved for offline") : (ko ? "연결이 있을 때 저장" : "not saved yet")}</small></button>`).join("");
  $$("#offlineList button").forEach((b) => b.addEventListener("click", () => { openKeyRoute(KEY_ROUTES[+b.dataset.i]); if (innerWidth <= 760) closeDrawer(); }));
  if (status !== undefined) $("#offlineStatus").textContent = status;
}
function openKeyRoute(r, cb) {
  routeTo({ start: r.start, end: r.end, cps: [] }, (res) => {
    if (res.ok && navigator.onLine) { const s = offlineSaved(); s[r.id] = 1; store.set("marswalk.offline", s); renderOffline(); }
    cb?.(res);
  });
}
async function saveOfflineRoutes() {
  const ko = KOUI(), btn = $("#btnSaveOffline");
  if (!navigator.onLine) return renderOffline(ko ? "연결이 없어요. 연결된 상태에서 저장하세요." : "No connection: save while online.");
  if (NAV) return renderOffline(ko ? "안내를 끝낸 뒤 저장하세요." : "End guidance first, then save.");
  const prev = S.start && S.end ? { start: S.start, end: S.end, cps: S.cps.map((c) => ({ lat: c.lat, lon: c.lon, name: c.name })) } : null;
  btn.disabled = true;
  let ok = 0;
  for (const [i, r] of KEY_ROUTES.entries()) {
    renderOffline(`${ko ? "저장 중" : "Saving"} ${i + 1}/${KEY_ROUTES.length}: ${ko ? r.ko : r.en}…`);
    const res = await new Promise((done) => openKeyRoute(r, done));
    if (res.ok) { ok++; await new Promise((t) => setTimeout(t, 2500)); }   // let this view's map tiles load into the cache
  }
  btn.disabled = false;
  if (prev) routeTo(prev, () => {});
  renderOffline(ko ? `${ok}/${KEY_ROUTES.length}개 경로를 오프라인으로 저장했어요.` : `Saved ${ok} of ${KEY_ROUTES.length} routes for offline use.`);
}
function flyToSite(it) { if (it.bounds) map.flyToBounds(it.bounds, { duration: 1.2 }); else map.flyTo([it.lat, it.lon], it.zoom || 11, { duration: 1.2 }); }
function renderLegend() {
  const overlays = layerDefs.overlays.filter((d) => d.legend && map.hasLayer(d.layer)).map((d) => {
    const [n, g, a, z] = d.legend;
    return `<div>${n}</div><div class="ramp" style="background:${g}"></div><div class="legend-row" style="justify-content:space-between"><span>${a}</span><span>${z}</span></div>`;
  }).join("");
  // the route line is coloured by the slope of each stretch (slopeColor)
  const ko = KOUI(), route = !S.track ? "" : `<div>${ko ? "경로 경사" : "Route slope"}</div><div class="slope-key">${[["#2fd68f", "< 8°"], ["#f5c84b", "8–15°"], ["#f58a3b", "15–20°"], ["#e9354f", "> 20°"]]
    .map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join("")}</div>`;
  $("#mapLegend").innerHTML = route + overlays;
}

function probe(lat, lon) {
  const s = sampleAt(S.site, lat, lon);
  $("#probe").innerHTML = s
    ? `${coordTxt({ lat, lon })}<br>elevation ${fmt(s.elev)} m · slope ${fmt(s.slope, 1)}°<br>rock density ${fmt(s.rough * 100)}% · ${s.nogo ? "<b style='color:#ff7083'>no-go</b>" : `hazard ${fmt(s.hazard * 100)}%`}`
    : `${coordTxt({ lat, lon })}<br>Not analysed yet: put a route here and its terrain loads. ${sourceLabel(sourcesFor([{ lat, lon }])[0])}.`;
}

// ---------------- picking points ----------------
function toast(msg, ms = 3200) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; $(".stage").appendChild(el); }
  el.textContent = msg; el.classList.remove("hidden");
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add("hidden"), ms);
}

function setPick(kind) {
  S.pick = kind;
  $("#map").classList.toggle("picking", !!kind);
  $("#fieldStart").classList.toggle("picking", kind === "start");
  $("#fieldEnd").classList.toggle("picking", kind === "end");
  $("#pickBanner").classList.toggle("hidden", !kind);
  $("#pickText").textContent = U(kind === "start" ? "Tap the map to set your start point" : kind === "end" ? "Tap the map to set your destination" : "Tap the map where you want a checkpoint");
  map?.closePopup();
}

// make a point object; snaps onto ground that is passable for the current mode
function makePoint(lat, lon, name) {
  lon = normLon(lon);
  if (!inExtent(lat, lon)) { toast("Pick a point between 88°S and 88°N."); return null; }
  // terrain here isn't loaded yet: keep the point and snap it once the corridor has been analysed
  if (!inSite(S.site, lat, lon)) return { lat, lon, name: name || null, unchecked: true };
  const prof = profileFor(S.mode, S.opts);
  let k = cellOf(S.site, lat, lon), moved = 0;
  if (!passable(S.site, k, prof)) {
    const k2 = nearestPassable(S.site, k, prof, 40);
    if (k2 < 0) { toast("No safe ground near there. Try another spot."); return null; }
    const [la, lo] = cellLatLon(S.site, k2);
    moved = distM([lat, lon], [la, lo]); lat = la; lon = lo;
    toast(`That spot is too steep or rocky, so it was moved ${fmt(moved)} m to the nearest safe ground.`);
  }
  return { lat, lon, name: name || null };
}
const pointLabel = (p) => { if (p.name) return KOUI() ? nameKo(p.name) : p.name; const e = elevAt(S.site, p.lat, p.lon); return e == null ? coordTxt(p) : `${coordTxt(p)} · ${fmt(e)} m`; };

function setPoint(kind, lat, lon, name) {
  const p = makePoint(lat, lon, name);
  if (!p) return false;
  if (kind === "start") S.start = p;
  else if (kind === "end") S.end = p;
  else insertCheckpoint(p);
  return true;
}
function insertCheckpoint(p) {
  p.id = cpSeq++; p.name = p.name || `Checkpoint ${S.cps.length + 1}`; p.dwell = S.opts.checkpointMin;
  const chain = [S.start, ...S.cps, S.end];
  let best = S.cps.length, bc = Infinity;
  for (let i = 0; i < chain.length - 1; i++) {
    const a = [chain[i].lat, chain[i].lon], b = [chain[i + 1].lat, chain[i + 1].lon], q = [p.lat, p.lon];
    const c = distM(a, q) + distM(q, b) - distM(a, b);
    if (c < bc) { bc = c; best = i; }
  }
  S.cps.splice(best, 0, p);
}

function onMapClick(e) {
  if (NAV) return;
  const lat = e.latlng.lat, lng = normLon(e.latlng.lng);
  if (S.pick) {
    const kind = S.pick;
    if (kind === "cp" && !(S.start && S.end)) return;
    if (!setPoint(kind, lat, lng)) return;
    setPick(kind === "start" && !S.end ? "end" : null);
    changed();
    return;
  }
  if (!S.start) { if (setPoint("start", lat, lng)) { setPick("end"); changed(); } return; }
  if (!S.end) { if (setPoint("end", lat, lng)) { setPick(null); changed(); } return; }
  // both set: offer actions, like a long-press in a phone navigation app
  const s = sampleAt(S.site, lat, lng);
  if (!s && !inExtent(lat, lng)) return;
  const read = s
    ? `elev <b>${fmt(s.elev)} m</b> · slope <b>${fmt(s.slope, 1)}°</b><br>rocks <b>${fmt(s.rough * 100)}%</b> · sky open <b>${fmt(skyOpen(horizons(S.site, lat, lng)) * 100)}%</b>${s.nogo ? "<br><b style='color:#ff7083'>No-go ground</b>" : ""}`
    : "Not analysed yet. Terrain loads when a route uses it.";
  const html = `<div class="pop-read"><b>${coordTxt({ lat, lon: lng })}</b><br>${read}</div>
    <div class="pop-btns"><button data-act="cp"><span class="dot cp"></span>Add checkpoint here</button><button data-act="end"><span class="dot end"></span>Make this the destination</button><button data-act="start"><span class="dot start"></span>Make this the start</button></div>`;
  sitePopup = L.popup({ maxWidth: 260 }).setLatLng(e.latlng).setContent(html).openOn(map);
  sitePopup.getElement().querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
    map.closePopup();
    if (setPoint(b.dataset.act, lat, lng)) changed();
  }));
}

// ---------------- route card ----------------
function renderCard() {
  const set = (el, p) => { el.textContent = p ? pointLabel(p) : U("Tap to choose on the map"); el.classList.toggle("placeholder", !p); };
  set($("#rcFrom"), S.start); set($("#rcTo"), S.end);
  const list = $("#cpList");
  list.innerHTML = "";
  S.cps.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "cp-row";
    row.innerHTML = `<span class="dot cp"></span><input class="cp-name" value="${esc(c.name)}" aria-label="Checkpoint name"/><select aria-label="Time at checkpoint">${[0, 5, 10, 15, 20, 30, 45, 60].map((m) => `<option value="${m}" ${m === c.dwell ? "selected" : ""}>${m ? m + " min" : "pass"}</option>`).join("")}</select><button class="cp-del" title="Remove checkpoint" aria-label="Remove checkpoint">✕</button>`;
    row.querySelector("input").addEventListener("change", (e) => { c.name = e.target.value.trim() || `Checkpoint ${i + 1}`; changed(); });
    row.querySelector("select").addEventListener("change", (e) => { c.dwell = +e.target.value; changed(); });
    row.querySelector(".cp-del").addEventListener("click", () => { S.cps.splice(i, 1); changed(); });
    row.addEventListener("mouseenter", () => map.panInside([c.lat, c.lon], { padding: [60, 60] }));
    list.appendChild(row);
  });
  $("#btnAddCp").disabled = !(S.start && S.end);
  $("#btnClear").classList.toggle("hidden", !(S.start || S.end));
  $("#btnExample").classList.toggle("hidden", !!(S.start || S.end));
  $$(".mode").forEach((b) => { const on = b.dataset.mode === S.mode; b.classList.toggle("active", on); b.setAttribute("aria-checked", on); });
  $("#emptyCard").classList.toggle("hidden", !!(S.start && S.end));
  $("#sheet").classList.toggle("hidden", !(S.start && S.end));
}

function pinIcon(kind, label = "") {
  const size = kind === "cp" ? 22 : 20;
  return L.divIcon({ className: "", html: `<div class="pin-${kind}" style="width:${size}px;height:${size}px">${label}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}
function renderMarkers() {
  sync3d();
  markerGroup.clearLayers();
  const add = (p, kind, label, title, onMove) => {
    const m = L.marker([p.lat, p.lon], { icon: pinIcon(kind, label), draggable: !NAV, zIndexOffset: kind === "cp" ? 500 : 800, autoPan: true }).addTo(markerGroup);
    m.bindTooltip(title, { direction: "top", offset: [0, -10] });
    m.on("dragend", () => { const ll = m.getLatLng(); const q = makePoint(ll.lat, ll.lng); if (q) onMove(q); changed(); });
  };
  if (S.start) add(S.start, "start", "", `Start · ${esc(pointLabel(S.start))}`, (q) => { q.name = null; S.start = q; });
  S.cps.forEach((c, i) => add(c, "cp", i + 1, esc(c.name), (q) => { c.lat = q.lat; c.lon = q.lon; }));
  if (S.end) add(S.end, "end", "", `Destination · ${esc(pointLabel(S.end))}`, (q) => { q.name = null; S.end = q; });
}

// ---------------- planning ----------------
let planTimer = 0, planSeq = 0;
function changed() {
  hideAlts(); save(); renderCard(); renderMarkers();
  if (!(S.start && S.end)) { planSeq++; clearTimeout(planTimer); buildAbort?.abort(); S.busy = false; $("#computing").classList.add("hidden"); $("#sheet").classList.remove("busy"); clearRoute(); return; }
  S.busy = true; $("#computing").classList.remove("hidden"); $("#sheet").classList.add("busy");
  clearTimeout(planTimer);
  const id = ++planSeq;
  planTimer = setTimeout(() => { if (id === planSeq) prepareAndPlan(id); }, 120);
}

// make sure the terrain grid covers every point (load a corridor from Trek if needed), snap points, then plan
let buildAbort = null;
async function prepareAndPlan(id) {
  if (!(S.start && S.end)) return;
  const pts = [S.start, ...S.cps, S.end];
  const fail = (msg) => {
    if (id !== planSeq) return;
    S.busy = false; $("#computing").classList.add("hidden"); $("#computing").textContent = "Finding the safest route…"; $("#sheet").classList.remove("busy");
    clearRoute(); S.error = msg; renderSheet(); planDone();
  };
  // sharpest elevation model covering every point; "high" detail uses finer cells and skips the prebuilt box
  const detail = S.opts.detail === "high" ? "high" : "standard", hi = detail === "high";
  // a surface traverse longer than this isn't meaningful (and would cross the 180° meridian or exceed Trek's image limits)
  for (let i = 1; i < pts.length; i++) {
    const km = distM([pts[i - 1].lat, pts[i - 1].lon], [pts[i].lat, pts[i].lon]) / 1000;
    if (km > 1500 || Math.abs(pts[i - 1].lon - pts[i].lon) > 180)
      return fail(U(`These points are ${fmt(km)} km apart. The planner handles surface traverses up to 1,500 km: pick points closer together, or plan in legs.`));
  }
  const srcs = sourcesFor(pts);
  // reuse the current grid only if it isn't much bigger than this route needs (a big grid has coarser cells
  // and may have skipped rock density)
  const want = corridorFor(pts, srcs[0]), area = (b) => (b.east - b.west) * (b.north - b.south);
  const reuse = S.site !== S.baseSite && S.site.live && covers(S.site, pts) && S.site.detail === detail && S.site.source.id === srcs[0].id
    && area(S.site.bbox) <= 4 * area(want);
  if (!hi && covers(S.baseSite, pts)) setSite(S.baseSite);
  else if (!reuse) {
    buildAbort?.abort(); const ac = buildAbort = new AbortController();
    const msg = (t) => { if (id === planSeq) $("#computing").textContent = U(t); };
    let site = null, lastErr = null;
    for (const src of srcs) {
      msg(`Loading ${src.title}…`);
      try {
        site = await buildSite(corridorFor(pts, src), src, { signal: ac.signal, maxCells: hi ? 8e6 : 3e6, minCell: hi ? 4 : 8,
          progress: (d, t) => msg(`Analysing terrain around your route (${src.instrument || "MOLA/HRSC"})… ${Math.round((d / t) * 100)}%`) });
      } catch (e) { if (ac.signal.aborted || id !== planSeq) return; lastErr = e; site = null; continue; }
      if (id !== planSeq) return;
      // every point must sit on ground this model actually covers (bounding boxes include no-data corners)
      if (pts.every((p) => hasData(site, cellOf(site, p.lat, p.lon)))) break;
      site = null;
    }
    if (!site) return fail(!navigator.onLine || /fetch|network/i.test(lastErr?.message || "")
      ? "No connection, and the terrain for this area isn't saved on this device yet. Routes and places already loaded still work offline; connect once to plan here."
      : `Couldn't load terrain from NASA Mars Trek${lastErr ? ` (${lastErr.message})` : ""}. Check the connection and try again.`);
    site.detail = detail;
    setSite(site);
    if (site.lowRes) toast(KOUI() ? `이 경로는 ${Math.round(site.cell_m)}m 간격의 거친 지형 데이터밖에 없어요. 큰 지형으로 대략적인 길은 보여 주지만, 수백 m보다 작은 절벽·턱·바위는 안 보이니 걸어도 안전한지 판단하는 데는 쓰지 마세요.`
      : `Only coarse ${Math.round(site.cell_m)} m terrain exists for this route. It shows the general way, but cliffs, ledges and rocks smaller than a few hundred metres don't show up, so don't rely on it to judge whether the walk is safe.`, 8000);
  }
  for (const p of pts) if (p.unchecked) {
    const q = makePoint(p.lat, p.lon, p.name);
    if (!q) return fail(`No safe ground near ${p.name || coordTxt(p)}.`);
    delete p.unchecked; Object.assign(p, q);
  }
  $("#computing").textContent = U("Finding the safest route…");
  renderCard(); renderMarkers(); save();
  plan();
}
function clearRoute() {
  S.track = S.mans = S.ana = S.checks = null; S.error = null;
  routeGroup.clearLayers(); dangerGroup.clearLayers();
  sync3d(); renderLegend();
}

// Build the track through start → checkpoints → destination for one vehicle profile.
// Returns { track, notes } or { err }.
function buildTrack(prof) {
  const site = S.site, order = [S.start, ...S.cps, S.end];
  const pts = [], stops = [], notes = [];
  let t = 0, err = null;
  const push = (lat, lon) => {
    const s = sampleAt(site, lat, lon) || { slope: 0, rough: 0, hazard: 0 };
    const elev = elevAt(site, lat, lon) ?? s.elev;
    if (pts.length) {
      const a = pts[pts.length - 1], d = distM([a.lat, a.lon], [lat, lon]);
      if (d < 0.01) return;
      const v = prof.speed((elev - a.elev) / d, (s.rough + a.rough) / 2, s.slope) / 3.6;
      t += d / Math.max(v, 0.05);
      pts.push({ lat, lon, dist: a.dist + d, t, elev, slope: s.slope, rough: s.rough, hazard: s.hazard });
    } else pts.push({ lat, lon, dist: 0, t: 0, elev, slope: s.slope, rough: s.rough, hazard: s.hazard });
  };
  const addStop = (p, k) => {
    const dwell = k > 0 && k < order.length - 1 ? (p.dwell || 0) * 60 : 0;
    stops.push({ idx: pts.length - 1, stop: { name: k === 0 ? p.name || "Start" : k === order.length - 1 ? p.name || "Destination" : p.name, dwell: dwell / 60, k }, arrive: t, depart: t + dwell });
    t += dwell; pts[pts.length - 1].t = t;
  };
  for (let k = 0; k < order.length; k++) {
    if (k === 0) { push(order[0].lat, order[0].lon); addStop(order[0], 0); continue; }
    const a = order[k - 1], b = order[k];
    const r = findPath(site, [a.lat, a.lon], [b.lat, b.lon], prof);
    if (r.error) { err = { leg: k, kind: r.error }; break; }
    const raw = r.cells.map((c) => cellLatLon(site, c));
    // use the exact tapped points only when they're on ground this vehicle can use
    const okA = passable(site, cellOf(site, a.lat, a.lon), prof), okB = passable(site, cellOf(site, b.lat, b.lon), prof);
    if (okA) raw[0] = [a.lat, a.lon]; else if (k === 1) notes.push(`Start is on ground the ${S.mode === "drive" ? "rover can't drive" : "crew can't walk"}; the route begins ${fmt(distM([a.lat, a.lon], raw[0]))} m away.`);
    if (okB) raw[raw.length - 1] = [b.lat, b.lon]; else notes.push(`${k === order.length - 1 ? "The destination" : b.name} is on ground the ${S.mode === "drive" ? "rover can't drive" : "crew can't walk"}; the route ends ${fmt(distM([b.lat, b.lon], raw[raw.length - 1]))} m away.`);
    // smooth the grid staircase, but never let a shortcut cross ground the planner ruled out
    const dense = (ll) => {
      const out = [];
      for (let i = 1; i < ll.length; i++) {
        const [la0, lo0] = ll[i - 1], [la1, lo1] = ll[i];
        const n = Math.max(1, Math.ceil(distM(ll[i - 1], ll[i]) / Math.max(5, site.cell_m / 2)));
        for (let j = 1; j <= n; j++) out.push([la0 + ((la1 - la0) * j) / n, lo0 + ((lo1 - lo0) * j) / n]);
      }
      return out;
    };
    const safe = (arr) => arr.every(([la, lo], i) => i < 2 || i > arr.length - 3 || passable(site, cellOf(site, la, lo), prof));
    let path = null;
    for (const tol of [3, 1.5]) { const d = dense(simplify(raw, tol)); if (safe(d)) { path = d; break; } }
    if (!path) path = dense(raw);
    for (const [la, lo] of path) push(la, lo);
    addStop(b, k);
  }
  if (err) return { err };
  const track = { kind: S.mode, pts, stops, total: { dist: pts[pts.length - 1].dist, time: t } };
  let up = 0, down = 0;
  for (let i = 1; i < pts.length; i++) { const d = pts[i].elev - pts[i - 1].elev; d > 0 ? (up += d) : (down -= d); }
  Object.assign(track.total, { ascent: up, descent: down });
  return { track, notes };
}

function plan() {
  const prof = profileFor(S.mode, S.opts), order = [S.start, ...S.cps, S.end];
  const { track, notes, err } = buildTrack(prof);
  S.busy = false; $("#computing").classList.add("hidden"); $("#sheet").classList.remove("busy");
  if (err) {
    clearRoute();
    const leg = err.leg === order.length - 1 && order.length === 2 ? "the destination" : `stop ${err.leg + 1}`;
    S.error = err.kind === "blocked"
      ? `No safe ${S.mode === "drive" ? "drivable" : "walkable"} path reaches ${leg}: it's cut off by ground steeper than ${prof.maxSlope}°${S.mode === "drive" ? " or too rocky for the rover" : ""}.`
      : `No safe ground near ${err.kind === "start" ? "the start" : leg}.`;
    renderSheet(); planDone(); return;
  }
  S.error = null;
  S.track = track;
  S.mans = buildManeuvers(S.site, track);
  S.ana = analyse(track);
  S.checks = assess(track, S.ana);
  S.cmp = compareWithCuriosity(track);
  for (const n of notes) S.checks.push({ lvl: "warn", title: "Point moved to usable ground", sub: n });
  renderRoute(); renderSheet();
  if (!$("#drawer").classList.contains("open") || $("#drawer").dataset.pane === "report" || $("#drawer").dataset.pane === "steps") renderPanes();
  planDone();
}

// ---------------- route requests from the voice assistant ----------------
// spec: { start?, end?, cps?, addCp?, mode?, autoStart?, navIntro? }  points are {lat, lon, name};
// a key left out keeps the current value. cb gets { ok, error?, need? } once the plan is finished.
let planCb = null;
function planDone() { sync3d(); if (fitOnPlan && S.track) { fitOnPlan = false; if (!userMoved) fitRoute(); } const f = planCb; planCb = null; f?.({ ok: !!S.track && !S.error, error: S.error }); }
function routeTo(spec, cb) {
  const wasNav = !!NAV;
  if (NAV) endNav();
  if (spec.mode) S.mode = spec.mode;
  const mk = (p) => { const q = makePoint(p.lat, p.lon, p.name); if (!q) throw new Error(`No safe ground near ${p.name || "that spot"}.`); return q; };
  try {
    if (spec.start !== undefined) S.start = spec.start && mk(spec.start);
    if (spec.end !== undefined) S.end = spec.end && mk(spec.end);
    if (spec.cps !== undefined) S.cps = spec.cps.map((p) => { const q = mk(p); q.id = cpSeq++; q.dwell = S.opts.checkpointMin; return q; });
    if (spec.addCp) { if (!(S.start && S.end)) throw new Error("Set a start and a destination before adding a checkpoint."); insertCheckpoint(mk(spec.addCp)); }
  } catch (e) { changed(); cb?.({ ok: false, error: e.message }); return; }
  setPick(null);
  if (!(S.start && S.end)) { changed(); setPick(S.start ? "end" : "start"); cb?.({ ok: false, need: S.start ? "end" : "start" }); return; }
  planCb = (res) => {
    if (res.ok) {
      if (spec.autoStart || wasNav) startNav(spec.navIntro);
      else fitRoute();
    }
    cb?.({ ...res, navigating: !!NAV });
  };
  changed();
}
function planSummary() {
  if (!S.track) return null;
  const t = S.track.total, worst = S.checks.find((c) => c.lvl === "bad") || S.checks.find((c) => c.lvl === "warn");
  return { from: S.start?.name || "the start", to: S.end?.name || "the destination", dist: t.dist, time: t.time, arrive: startSec() + t.time,
    checkpoints: S.cps.map((c) => c.name), status: worst ? worst.title : "All checks passed", checks: S.checks.map((c) => ({ level: c.lvl, title: c.title, detail: c.sub })), mode: S.mode };
}

// ---------------- analysis: dangers, shielding, sunlight ----------------
function runs(pts, pred, minLen, gap = 25) {
  // stretches where pred holds; stretches separated by less than `gap` metres are merged
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (!pred(pts[i])) continue;
    let j = i, k = i + 1;
    while (k < pts.length && (pts[k].dist ?? pts[k].d) - (pts[j].dist ?? pts[j].d) <= gap) { if (pred(pts[k])) j = k; k++; }
    if ((pts[j].dist ?? pts[j].d) - (pts[i].dist ?? pts[i].d) >= minLen) out.push([i, j]);
    i = j;
  }
  return out;
}
function nearNogo(site, p) {
  const k = cellOf(site, p.lat, p.lon), i0 = k % site.nx, j0 = (k / site.nx) | 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const i = i0 + di, j = j0 + dj;
    if (i >= 0 && j >= 0 && i < site.nx && j < site.ny && site.nogo[j * site.nx + i]) return true;
  }
  return false;
}

function analyse(tr) {
  const site = S.site, pts = tr.pts, walk = tr.kind === "walk", today = new Date(), t0 = startSec();
  // reverse (walk-back) time from each point to the start, moving time only
  const prof = profileFor(tr.kind, S.opts);
  const back = new Float32Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i], b = pts[i - 1], d = a.dist - b.dist;
    const v = prof.speed((b.elev - a.elev) / d, (a.rough + b.rough) / 2, b.slope) / 3.6;
    back[i] = back[i - 1] + d / Math.max(v, 0.05);
  }
  // oxygen used, weighted by effort (grade over ~50 m, pace, load, ground): "seconds at the flat-walking rate"
  const eff = effortModel(S.opts), o2Out = new Float32Array(pts.length), o2Back = new Float32Array(pts.length);
  const gradeAt = (d) => { const a = pts[idxAtDist(pts, Math.max(0, d - 25))], b = pts[idxAtDist(pts, Math.min(tr.total.dist, d + 25))];
    return b.dist - a.dist > 5 ? (b.elev - a.elev) / (b.dist - a.dist) : 0; };
  let effMax = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], d = b.dist - a.dist, r = (a.rough + b.rough) / 2, g = gradeAt((a.dist + b.dist) / 2);
    const dt = b.t - a.t, fo = dt > 0 ? eff(d > 0.01 ? g : 0, d / dt, r) : 1;
    o2Out[i] = o2Out[i - 1] + Math.max(0, dt) * fo;
    const db = back[i] - back[i - 1], fb = db > 0 ? eff(-g, d / db, r) : 1;
    o2Back[i] = o2Back[i - 1] + db * fb;
    if (d > 0.01) effMax = Math.max(effMax, fo);
  }
  const effAvg = pts[pts.length - 1].t > 0 ? o2Out[pts.length - 1] / pts[pts.length - 1].t : 1;
  // samples every 25 m: sky view (terrain shielding) and sun / shadow at the time you pass
  const samples = [];
  const step = Math.max(25, site.cell_m, tr.total.dist / 400);
  for (let d = 0; ; d += step) {
    const i = idxAtDist(pts, Math.min(d, tr.total.dist)), p = pts[i];
    const hz = horizons(site, p.lat, p.lon);
    const sun = sunAt((t0 + p.t) / 3600, today);
    const shade = sun.el <= 0 || horizonToward(hz, sun.az) > sun.el;
    samples.push({ d: p.dist, i, lat: p.lat, lon: p.lon, hz, sky: skyOpen(hz), sun, shade });
    if (d >= tr.total.dist) break;
  }
  // best radiation shelter near the route: most enclosed passable spot within ~150 m
  let shelter = null;
  for (let s = 0; s < samples.length; s += 4) {
    const a = samples[s], hd = headingAt(pts, a.d) + 90;
    for (const off of [-150, -100, -50, 0, 50, 100, 150]) {
      const r = (hd * Math.PI) / 180;
      const lat = a.lat + (Math.cos(r) * off) / site.mPerDegLat, lon = a.lon + (Math.sin(r) * off) / site.mPerDegLon;
      if (!inSite(site, lat, lon) || !passable(site, cellOf(site, lat, lon), prof)) continue;
      const sky = off === 0 ? a.sky : skyOpen(horizons(site, lat, lon));
      if (!shelter || sky < shelter.sky) shelter = { lat, lon, sky, off: Math.abs(off), d: a.d };
    }
  }
  // dangers along the route
  const D = [];
  const steepLim = walk ? 15 : S.opts.roverMaxSlope * 0.8, rockLim = walk ? 0.6 : S.opts.roverMaxRough * 0.85;
  for (const [i, j] of runs(pts, (p) => p.slope > steepLim, walk ? 10 : 20, walk ? 25 : 60)) {
    let mx = 0; for (let k = i; k <= j; k++) mx = Math.max(mx, pts[k].slope);
    const climb = pts[j].elev > pts[i].elev;
    D.push({ i, j, sev: mx >= (walk ? 20 : S.opts.roverMaxSlope * 0.9) ? "bad" : "warn", title: `Steep ${climb ? "climb" : "descent"} up to ${fmt(mx)}°`,
      sub: `${distTxt(pts[j].dist - pts[i].dist)} long · ${walk ? "risk of slipping; short steps" : "slow down, watch rover tilt"}` });
  }
  for (const [i, j] of runs(pts, (p) => p.rough > rockLim, 15)) {
    let mx = 0; for (let k = i; k <= j; k++) mx = Math.max(mx, pts[k].rough);
    D.push({ i, j, sev: mx > 0.85 ? "bad" : "warn", title: "Rocky ground / ridges", sub: `${distTxt(pts[j].dist - pts[i].dist)} · rock density up to ${fmt(mx * 100)}% · ${walk ? "trip hazard, suit and glove abrasion" : "wheel damage risk"}` });
  }
  for (const [i, j] of runs(pts, (p) => nearNogo(site, p), 8)) {
    D.push({ i, j, sev: "warn", title: "Passes close to no-go ground", sub: `within ~10 m of a cliff, scarp or boulder field for ${distTxt(pts[j].dist - pts[i].dist)}` });
  }
  const sh = runs(samples, (s) => s.shade, 40);
  for (const [a, b] of sh) {
    const i = samples[a].i, j = samples[b].i;
    D.push({ i, j, sev: "info", title: "In terrain shadow", sub: `${hhmm(t0 + pts[i].t)}–${hhmm(t0 + pts[j].t)} LMST · colder, poor light on footing` });
  }
  D.sort((x, y) => x.i - y.i);
  D.forEach((d, n) => { d.n = n + 1; d.dist = pts[d.i].dist; });
  let emin = Infinity, emax = -Infinity, smax = 0;
  for (const p of pts) { emin = Math.min(emin, p.elev); emax = Math.max(emax, p.elev); smax = Math.max(smax, p.slope); }
  const skyAvg = samples.reduce((s, x) => s + x.sky, 0) / samples.length;
  const shadeFrac = samples.filter((s) => s.shade).length / samples.length;
  // radio line of sight from the base antenna at the route start to the crew, at every sample
  const comms = commsAlongRoute(site, samples, pts[0]);
  samples.forEach((s, k) => { s.los = comms.los[k]; });
  // two-person EVA: margin if the pair has to walk back at BUDDY_PACE (one crew member hurt); rover rescue time
  const usableS = (S.opts.plssHours - S.opts.reserveHours) * 3600;
  let buddyMin = Infinity, buddyAt = 0;
  for (let i = 0; i < pts.length; i++) { const m = usableS - o2Out[i] - o2Back[i] / BUDDY_PACE; if (m < buddyMin) { buddyMin = m; buddyAt = pts[i].dist; } }
  const rescueS = tr.total.dist / ((S.opts.roverSpeed * RESCUE_PACE) / 3.6);
  return { step, back, o2Out, o2Back, effAvg, effMax, buddyMin, buddyAt, rescueS, samples, shelter, dangers: D, emin, emax, smax, skyAvg, shadeFrac, comms, day: daylight(today), Ls: sunAt(12, today).Ls };
}

function assess(tr, A) {
  const o = S.opts, walk = tr.kind === "walk", t0 = startSec(), tot = tr.total, C = [];
  const backEnd = A.back[A.back.length - 1];
  if (walk) {
    const usable = (o.plssHours - o.reserveHours) * 3600, outO2 = A.o2Out[A.o2Out.length - 1], backO2 = A.o2Back[A.o2Back.length - 1], need = outO2 + backO2;
    let minM = Infinity, at = 0;
    tr.pts.forEach((p, i) => { const m = usable - A.o2Out[i] - A.o2Back[i]; if (m < minM) { minM = m; at = p.dist; } });
    const lvl = need <= usable * 0.85 ? "ok" : need <= usable ? "warn" : "bad";
    C.push({ lvl, title: lvl === "bad" ? "Not enough oxygen to walk back" : lvl === "warn" ? "Oxygen is tight for the walk back" : "Enough oxygen to walk back",
      sub: `O₂ out ${dur(outO2)} + back ${dur(backO2)} = ${dur(need)} of ${dur(usable)} usable (${o.plssHours} h suit − ${o.reserveHours} h reserve). ${minM < 0 ? `Walk-back margin runs out ${distTxt(at)} along.` : `Lowest walk-back margin ${dur(minM)}.`}` });
  }
  if (walk) C.push({ lvl: A.buddyMin < 0 ? "warn" : "ok",
    title: A.buddyMin < 0 ? "Not enough oxygen to help a partner back" : "Enough oxygen to help a partner back",
    sub: `If one crew member is hurt, the pair walks back at ${Math.round(BUDDY_PACE * 100)}% pace: ${A.buddyMin < 0 ? `oxygen runs short ${distTxt(A.buddyAt)} along.` : `lowest margin ${dur(A.buddyMin)}.`} A rover from base reaches the farthest point in about ${dur(A.rescueS)}.` });
  if (A.comms) {
    const cm = A.comms, out = cm.runs.reduce((s, r) => s + r.len, 0);
    C.push({ lvl: "ok", title: cm.runs.length ? `Out of radio line of sight to base for ${distTxt(out)} (${fmt((1 - cm.frac) * 100)}% of the route)` : "Radio line of sight to base the whole way",
      sub: cm.runs.length ? `Longest gap ${distTxt(cm.longest.len)}, from ${distTxt(cm.longest.from)} along. Base antenna ${BASE_ANT_M} m, suit ${SUIT_ANT_M} m. Guidance keeps working offline there.`
        : `Base antenna ${BASE_ANT_M} m, suit ${SUIT_ANT_M} m: the terrain never blocks the straight path.` });
  }
  const finish = t0 + tot.time + (walk ? backEnd : 0);
  if (A.day.rise != null) {
    const rise = A.day.rise * 3600, set = A.day.set * 3600;
    const lvl = t0 < rise || finish > set ? "bad" : finish > set - 3600 ? "warn" : "ok";
    C.push({ lvl, title: lvl === "ok" ? "Finishes in daylight" : lvl === "warn" ? "Finishes close to sunset" : "Runs outside daylight",
      sub: `Sunrise ${hhmm(rise)}, sunset ${hhmm(set)} LMST today. ${walk ? "Back at the start" : "Arrive"} by ${hhmm(finish)}.` });
  }
  const steep = A.dangers.filter((d) => d.title.startsWith("Steep")), rocky = A.dangers.filter((d) => d.title.startsWith("Rocky"));
  const lim = walk ? o.maxSlope : o.roverMaxSlope;
  C.push({ lvl: A.smax > lim + 0.5 ? "bad" : steep.some((d) => d.sev === "bad") ? "warn" : "ok", title: `Steepest ground ${fmt(A.smax)}° (limit ${lim}°)`,
    sub: steep.length ? `${steep.length} steep section${steep.length > 1 ? "s" : ""} · ${rocky.length} rocky stretch${rocky.length === 1 ? "" : "es"}. Open the report for where.` : `No sections over ${walk ? 15 : fmt(lim * 0.8)}°. ${rocky.length} rocky stretch${rocky.length === 1 ? "" : "es"}.` });
  C.push({ lvl: A.shadeFrac > 0.25 ? "warn" : "ok", title: A.shadeFrac > 0.01 ? `${fmt(A.shadeFrac * 100)}% of the route in terrain shadow` : "Sunlit the whole way",
    sub: "From the Sun's position at the time you pass each point and the terrain horizon." });
  const sh = A.shelter;
  C.push({ lvl: "ok", title: `Radiation shielding (relative): sky ${fmt(A.skyAvg * 100)}% open on average`,
    sub: `Share of the sky not blocked by terrain: lower means more shielding. A relative measure from the elevation model, not a radiation dose.${sh ? ` Most sheltered spot near the route: ${fmt(sh.sky * 100)}% sky open, ${sh.off ? `${fmt(sh.off)} m off the route` : "on the route"} at ${distTxt(sh.d)}. Use it if a solar particle event is called.` : ""}` });
  const site = S.site;
  if (site.lowRes) C.unshift({ lvl: walk ? "bad" : "warn", title: `Rough guide only: ${fmt(site.cell_m)} m terrain can't show small cliffs or rocks`,
    sub: `No sharp elevation model covers this route, so it uses ${sourceLabel(site.source)}. Cliffs, scarps and boulder fields smaller than a few hundred metres don't show at this scale: not an EVA safety check.` });
  else if (site.live && !site.rock) C.push({ lvl: "warn", title: "Rock density not assessed", sub: "No HiRISE image mosaic covers this ground, so only slope is checked. Watch for boulders and ridges." });
  return C;
}

// ---------------- rendering the route ----------------
function renderRoute() {
  routeGroup.clearLayers(); dangerGroup.clearLayers();
  const pts = S.track.pts, ll = pts.map((p) => [p.lat, p.lon]);
  casing = L.polyline(ll, { color: "#0b0d10", weight: 11, opacity: 0.85, interactive: false }).addTo(routeGroup);
  let seg = [ll[0]], col = slopeColor(pts[0].slope);
  for (let i = 1; i < pts.length; i++) {
    const c = slopeColor(pts[i].slope);
    seg.push(ll[i]);
    if (c !== col || i === pts.length - 1) { L.polyline(seg, { color: col, weight: 6, opacity: 1, interactive: false }).addTo(routeGroup); seg = [ll[i]]; col = c; }
  }
  doneLine = L.polyline([], { color: "#9aa3b2", weight: 6, opacity: 1, interactive: false }).addTo(routeGroup);
  renderLegend();
  for (const d of S.ana.dangers) {
    const p = pts[d.i];
    L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "", html: `<div class="danger-pin ${d.sev === "bad" ? "bad" : ""}" style="${d.sev === "info" ? "background:#4aa3ff;color:#fff" : ""}">${d.n}</div>`, iconSize: [18, 18] }), zIndexOffset: 200 })
      .bindTooltip(`<b>${d.n}. ${esc(d.title)}</b><br>${esc(d.sub)}`, { direction: "top" }).addTo(dangerGroup);
  }
  if (S.cmp) L.polyline(S.cmp.line, { color: "#ffb347", weight: 3, opacity: 0.95, dashArray: "2 7", interactive: true }).bindTooltip("Curiosity's actual path", { sticky: true }).addTo(dangerGroup);
  const sh = S.ana.shelter;
  if (sh) L.marker([sh.lat, sh.lon], { icon: L.divIcon({ className: "", html: '<div class="shelter-pin" title="Best radiation shelter">⛨</div>', iconSize: [20, 20] }) })
    .bindTooltip(`<b>Best radiation shelter (relative)</b><br>${fmt(sh.sky * 100)}% of the sky open: surrounding terrain blocks the rest`, { direction: "top" }).addTo(dangerGroup);
}

// terrain detail used for this route, with a button to analyse the route corridor more finely
function renderDetail() {
  const el = $("#sumDetail"), site = S.site;
  if (!el) return;
  const src = site.live ? `${site.source.instrument || "MOLA+HRSC"} ${site.source.pxM < 10 ? site.source.pxM.toFixed(1) : Math.round(site.source.pxM)} m data` : "HiRISE 1 m DEM (prebuilt)";
  const canRefine = S.opts.detail !== "high" && (!site.live || site.cell_m > Math.max(4, Math.round(site.source.pxM)));
  const ko = KOUI(), srcK = ko ? src.replace(/ data$/, " 데이터").replace("(prebuilt)", "(사전 제작)") : src;
  el.innerHTML = `<span class="det ${site.lowRes ? "low" : ""}">${ko ? "지형" : "Terrain"}: ${fmt(site.cell_m)} m ${ko ? "격자" : "grid"} · ${esc(srcK)}${site.lowRes ? (ko ? " · 대략적인 길만 (작은 절벽·바위 안 보임)" : " · rough guide only (small cliffs and rocks not shown)") : ""}</span>${canRefine ? `<button class="link-btn" id="btnRefine" title="Re-analyse the ground along this route on a finer grid">${ko ? "경로 지형 정밀 분석" : "Refine route terrain"}</button>` : S.opts.detail === "high" ? `<button class="link-btn" id="btnStd">${ko ? "기본 정밀도" : "Standard detail"}</button>` : ""}`;
  $("#btnRefine")?.addEventListener("click", () => { S.opts.detail = "high"; $("#inDetail").value = "high"; changed(); });
  $("#btnStd")?.addEventListener("click", () => { S.opts.detail = "standard"; $("#inDetail").value = "standard"; changed(); });
}
function renderSheet() {
  const st = $("#statusBtn");
  if (S.error) {
    $("#sumTime").textContent = U("No route"); $("#sumTime").className = "sum-time bad";
    $("#sumDist").textContent = ""; $("#sumSub").textContent = U("Move the start, destination or a checkpoint, or relax the limits in Settings.");
    st.className = "status bad"; $("#statusText").textContent = U(S.error); $("#checks").innerHTML = "";
    $("#btnStart").disabled = true; $("#btnHud").disabled = true; $("#firstTip").classList.add("hidden"); $("#profileSvg").innerHTML = ""; $("#profileInfo").textContent = ""; return;
  }
  if (!S.track) return;
  const tot = S.track.total, C = S.checks;
  const worst = C.some((c) => c.lvl === "bad") ? "bad" : C.some((c) => c.lvl === "warn") ? "warn" : "ok";
  $("#sumTime").textContent = U(dur(tot.time)); $("#sumTime").className = `sum-time ${worst === "ok" ? "" : worst}`;
  $("#sumDist").textContent = distTxt(tot.dist);
  const ncp = S.cps.length;
  $("#sumSub").textContent = U(`${S.mode === "drive" ? "Drive" : "Walk"} · arrive ${hhmm(startSec() + tot.time)} LMST · ↑${fmt(tot.ascent)} m ↓${fmt(tot.descent)} m${ncp ? ` · ${ncp} checkpoint${ncp > 1 ? "s" : ""}` : ""}`);
  renderDetail();
  st.className = `status ${worst}`;
  const nb = C.filter((c) => c.lvl !== "ok").length;
  $("#statusText").textContent = KOUI() && worst === "bad" ? `현재 계획은 위험: ${uiKo(C.find((c) => c.lvl === "bad").title)}`
    : U(worst === "ok" ? "Safe to go: all checks passed" : worst === "warn" ? `Go with caution: ${nb} thing${nb > 1 ? "s" : ""} to watch` : `Not safe as planned: ${C.find((c) => c.lvl === "bad").title.toLowerCase()}`);
  $("#checks").innerHTML = C.map((c) => `<div class="check ${c.lvl}"><span class="ic">${c.lvl === "ok" ? "✓" : c.lvl === "warn" ? "!" : "✕"}</span><span>${esc(U(c.title))}<small>${esc(U(c.sub))}</small></span></div>`).join("");
  $("#btnStart").disabled = false; $("#btnHud").disabled = false;
  const ex = S.start && S.end && distM([S.start.lat, S.start.lon], [EXAMPLE.start.lat, EXAMPLE.start.lon]) < 30 && distM([S.end.lat, S.end.lon], [EXAMPLE.end.lat, EXAMPLE.end.lon]) < 30 && !S.cps.length;
  $("#firstTip").classList.toggle("hidden", !ex || !!store.get("marswalk.tip"));
  renderProfile();
}

function renderProfile() {
  const svg = $("#profileSvg"), pts = S.track.pts, tot = S.track.total;
  const W = svg.clientWidth || 340, H = svg.clientHeight || 96;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const padL = 40, padR = 6, padT = 8, padB = 16;
  let zmin = S.ana.emin, zmax = S.ana.emax;
  const zr = Math.max(20, zmax - zmin); zmin -= zr * 0.1; zmax += zr * 0.15;
  const X = (d) => padL + (d / tot.dist) * (W - padL - padR), Y = (z) => padT + (1 - (z - zmin) / (zmax - zmin)) * (H - padT - padB);
  const T = (x, y, s, a = "end") => `<text x="${x}" y="${y}" fill="#8f98a8" font-size="10" text-anchor="${a}" font-family="JetBrains Mono">${s}</text>`;
  let h = "";
  const step = zr > 300 ? 100 : zr > 120 ? 50 : zr > 50 ? 20 : 10;
  for (let z = Math.ceil(zmin / step) * step; z <= zmax; z += step) h += `<line x1="${padL}" x2="${W - padR}" y1="${Y(z)}" y2="${Y(z)}" stroke="#2a303b"/>${T(padL - 5, Y(z) + 3, fmt(z))}`;
  const dstep = tot.dist > 4000 ? 1000 : tot.dist > 1500 ? 500 : tot.dist > 600 ? 200 : 100;
  for (let d = 0; d <= tot.dist; d += dstep) h += T(X(d), H - 3, d >= 1000 ? `${d / 1000} km` : `${d} m`, "middle");
  h += `<path d="M${X(0)},${Y(zmin)} ${pts.map((p) => `L${X(p.dist).toFixed(1)},${Y(p.elev).toFixed(1)}`).join(" ")} L${X(tot.dist)},${Y(zmin)}Z" fill="rgba(232,116,59,.12)"/>`;
  let seg = [], col = null;
  const flush = () => { if (seg.length > 1) h += `<polyline points="${seg.join(" ")}" fill="none" stroke="${col}" stroke-width="2.5"/>`; };
  for (const p of pts) { const c = slopeColor(p.slope), xy = `${X(p.dist).toFixed(1)},${Y(p.elev).toFixed(1)}`; if (c !== col) { if (seg.length) { seg.push(xy); flush(); } seg = [xy]; col = c; } else seg.push(xy); }
  flush();
  S.track.stops.forEach((s, k) => { if (k === 0 || k === S.track.stops.length - 1) return; const p = pts[s.idx]; h += `<circle cx="${X(p.dist)}" cy="${Y(p.elev)}" r="4" fill="#e8743b" stroke="#fff" stroke-width="1.5"/>`; });
  h += `<line id="pfCursor" y1="${padT}" y2="${H - padB}" stroke="#7dffc8" opacity="0"/>`;
  svg.innerHTML = h;
  $("#profileInfo").textContent = `${fmt(S.ana.emin)} to ${fmt(S.ana.emax)} m`;
  const at = (e) => { const r = svg.getBoundingClientRect(); const d = (((e.clientX - r.left) * (W / r.width) - padL) / (W - padL - padR)) * tot.dist; return d < 0 || d > tot.dist ? null : pts[idxAtDist(pts, d)]; };
  svg.onmousemove = (e) => {
    const p = at(e); if (!p) return;
    const cur = $("#pfCursor"); cur.setAttribute("x1", X(p.dist)); cur.setAttribute("x2", X(p.dist)); cur.setAttribute("opacity", 1);
    const tip = $("#profileTip"), r = svg.getBoundingClientRect();
    tip.classList.remove("hidden");
    tip.innerHTML = `${distTxt(p.dist)} · ${fmt(p.elev)} m<br>slope ${fmt(p.slope, 1)}° · rocks ${fmt(p.rough * 100)}%<br>pass at ${hhmm(startSec() + p.t)} LMST`;
    const x = e.clientX - r.left; tip.style.left = `${Math.min(r.width - 150, Math.max(0, x - 70))}px`; tip.style.top = "-52px";
    showHover(p.lat, p.lon);
  };
  svg.onmouseleave = () => { $("#profileTip").classList.add("hidden"); $("#pfCursor")?.setAttribute("opacity", 0); hoverDot?.remove(); hoverDot = null; };
  svg.onclick = (e) => { const p = at(e); if (p) map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 17)); };
}
function showHover(lat, lon) {
  if (!hoverDot) hoverDot = L.circleMarker([lat, lon], { radius: 7, color: "#fff", weight: 2, fillColor: "#7dffc8", fillOpacity: 1, interactive: false }).addTo(map);
  else hoverDot.setLatLng([lat, lon]);
}

// ---------------- drawer panes ----------------
function openDrawer(name) {
  const dr = $("#drawer");
  $$(".drawer-body").forEach((b) => b.classList.toggle("active", b.dataset.pane === name));
  const pane = $(`.drawer-body[data-pane="${name}"]`);
  $("#drawerTitle").textContent = pane.dataset.title;
  dr.dataset.pane = name; dr.classList.add("open"); dr.setAttribute("aria-hidden", "false");
  if (name === "steps" || name === "report") renderPanes();
}
function closeDrawer() { const dr = $("#drawer"); dr.classList.remove("open"); dr.setAttribute("aria-hidden", "true"); }
function flyToIdx(i, zoom = 17.5) { const p = S.track.pts[i]; map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), zoom)); showHover(p.lat, p.lon); if (innerWidth <= 760) closeDrawer(); }

// Oxygen plan: the same walk-back model the safety check uses, shown along the whole route so the crew can see
// where the margin is smallest. It is a planning estimate (steady use over the suit's rated time), not a sensor reading.
function oxygenCard(tr, A) {
  const o = S.opts, ko = KOUI(), pts = tr.pts;
  if (tr.kind !== "walk") return `<div class="card"><div class="eyebrow">${ko ? "산소 계획" : "Oxygen plan"}</div><p class="small">${ko
    ? "로버 이동이라 우주복 산소를 쓰지 않아요. 로버 생명유지장치는 이 앱에서 계산하지 않습니다."
    : "Rover traverse: suit oxygen isn't drawn, and the rover's cabin life support isn't modelled here."}</p></div>`;
  const usable = (o.plssHours - o.reserveHours) * 3600, D = (s) => (ko ? navKo.dur(s) : dur(s));
  const margin = (i) => usable - A.o2Out[i] - A.o2Back[i];
  let minI = 0; pts.forEach((_, i) => { if (margin(i) < margin(minI)) minI = i; });
  // rows: start, quarter points, every stop, the tightest point and the destination
  const idx = new Set([0, pts.length - 1, minI]);
  for (const f of [0.25, 0.5, 0.75]) idx.add(idxAtDist(pts, tr.total.dist * f));
  for (const s of tr.stops || []) idx.add(s.idx);
  const rows = [...idx].sort((a, b) => a - b).map((i) => {
    const m = margin(i), cls = m < 0 ? "bad" : m < 1800 ? "warn" : "";
    const where = i === 0 ? (ko ? "출발" : "Start") : i === pts.length - 1 ? (ko ? "도착" : "Destination") : distTxt(pts[i].dist);
    return `<tr${i === minI ? ' class="tight"' : ""}><td>${where}${i === minI && i !== 0 ? (ko ? " · 가장 빠듯" : " · tightest") : ""}</td><td>${D(pts[i].t)}</td><td>${D(o.plssHours * 3600 - A.o2Out[i])}</td><td>${D(A.o2Back[i])}</td><td class="${cls}">${m < 0 ? "−" + D(-m) : D(m)}</td></tr>`;
  }).join("");
  const strip = A.samples.map((s) => { const m = margin(Math.min(pts.length - 1, s.i));
    return `<i style="flex:1;background:${m < 0 ? "#e9354f" : m < 1800 ? "#f5c84b" : "#2fd68f"}"></i>`; }).join("");
  return `<div class="card"><div class="eyebrow">${ko ? "산소 계획 · 계획용 예상치, 센서 값 아님" : "Oxygen plan · planning estimate, not a sensor reading"}</div>
    <div class="kv"><div>${ko ? "우주복 산소" : "Suit oxygen"}<b>${fmt(o.plssHours, 1)} h</b></div><div>${ko ? "예비" : "Reserve"}<b>${fmt(o.reserveHours, 1)} h</b></div><div>${ko ? "사용 가능" : "Usable"}<b>${D(usable)}</b></div></div>
    <div class="kv"><div>${ko ? "짐" : "Carried load"}<b>${fmt(o.loadKg ?? 10)} kg</b></div><div>${ko ? "평균 노력" : "Avg effort"}<b>×${fmt(A.effAvg, 2)}</b></div><div>${ko ? "최대 노력" : "Peak effort"}<b>×${fmt(A.effMax, 2)}</b></div></div>
    <div class="kv"><div>${ko ? "2인 조 비상 귀환 여유" : "Buddy-return margin"}<b>${A.buddyMin < 0 ? "−" + D(-A.buddyMin) : D(A.buddyMin)}</b></div><div>${ko ? "로버 구조 도착" : "Rover rescue"}<b>${D(A.rescueS)}</b></div><div>${ko ? "부상 시 속도" : "Pace if hurt"}<b>${Math.round(BUDDY_PACE * 100)}%</b></div></div>
    <table class="o2-table"><thead><tr><th>${ko ? "위치" : "Where"}</th><th>${ko ? "경과" : "Time out"}</th><th>${ko ? "산소 잔량" : "O₂ left"}</th><th>${ko ? "귀환에 드는 산소" : "O₂ to walk back"}</th><th>${ko ? "귀환 여유" : "Margin"}</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="strip">${strip}</div><div class="legend-row" style="justify-content:space-between"><span>${ko ? "출발" : "start"}</span><span>${ko ? "초록 = 여유 30분 이상 · 노랑 = 빠듯 · 빨강 = 부족" : "green = 30 min+ margin · yellow = tight · red = short"}</span><span>${ko ? "도착" : "end"}</span></div>
    <p class="small">${ko
      ? `계산 방법: 우주복 산소는 <b>평지를 계획 속도로 걸을 때</b> ${fmt(o.plssHours, 1)}시간 가는 것으로 보고(설정 → 우주복 산소), ${fmt(o.reserveHours, 1)}시간은 비상용으로 남겨요. 오르막·빠른 걸음·무거운 짐·바위 지대에서는 더 빨리 줄고, 멈춰 있을 때는 덜 줄어요(Pandolf 1977 하중 보행식으로 평지 대비 노력 배수를 계산, 대원+우주복 ${CREW_SUIT_KG} kg + 짐). 경로의 모든 지점에서 <b>지금까지 쓴 산소 + 같은 길로 출발지까지 걸어 돌아가는 데 드는 산소</b>가 사용 가능한 산소 안에 들어와야 하고, 남는 만큼이 <b>귀환 여유</b>예요. 표의 시간은 모두 "평지 보행 기준 산소 시간"이에요. 센서 값이 아닌 계획용 추정이라, 실제 장비에서는 우주복의 산소 측정값으로 바꿔야 해요.`
      : `How it's planned: the suit is rated for ${fmt(o.plssHours, 1)} h <b>walking on the flat at the planned pace</b> (Settings → Suit oxygen), with ${fmt(o.reserveHours, 1)} h kept for emergencies. Climbs, a faster pace, a heavier load and rocky ground use it faster, and standing still uses less (effort relative to the flat from the Pandolf 1977 load-carriage equation, crew + suit ${CREW_SUIT_KG} kg plus the load). At every point, <b>oxygen already used + oxygen to walk back to the start along the same path</b> must fit in the usable oxygen; what's left over is the <b>walk-back margin</b>. All times in the table are oxygen in "hours of flat walking". It's a planning estimate, not a sensor reading: a real system would use the suit's own oxygen readings.`}</p></div>`;
}

// Science along the way: catalogued Curiosity science sites near the route, added as timed stops in one tap
let sciFilter = "all";
export function scienceNear(tr, maxKm = 3) {
  const pts = tr.pts, step = Math.max(1, Math.floor(pts.length / 300));
  const onRoute = new Set([S.start?.name, ...S.cps.map((c) => c.name), S.end?.name]);
  return SCIENCE_SITES.filter((s) => s.lat != null).map((s) => {
    let d = Infinity; for (let i = 0; i < pts.length; i += step) d = Math.min(d, distM([pts[i].lat, pts[i].lon], [s.lat, s.lon]));
    return { ...s, off: d, on: onRoute.has(s.name) };
  }).filter((s) => s.on || s.off <= maxKm * 1000).sort((a, b) => a.off - b.off);
}
function scienceCard(tr) {
  const ko = KOUI(), near = scienceNear(tr);
  if (!near.length) return "";
  const list = near.filter((s) => sciFilter === "all" || s.obj === sciFilter);
  const chips = ["all", ...new Set(near.map((s) => s.obj))].map((k) => `<button class="sci-chip${k === sciFilter ? " on" : ""}" data-sci-filter="${k}">${k === "all" ? (ko ? "전체" : "All") : esc(OBJECTIVES[k][ko ? "ko" : "en"])}</button>`).join("");
  return `<div class="card"><div class="eyebrow">${ko ? "가는 길의 과학 · 큐리오시티 조사 지점" : "Science along the way · Curiosity science sites"}</div>
    <div class="sci-chips">${chips}</div>
    ${list.map((s) => `<div class="sci-site"><div><b>${esc(ko ? nameKo(s.name) : s.name)}</b> <span class="sci-tag">${esc(OBJECTIVES[s.obj][ko ? "ko" : "en"])}</span></div>
      <div class="small">${esc(ko ? s.ko : s.en)}</div>
      <div class="sci-row"><span class="muted small">${s.on ? (ko ? "이 경로에 포함됨" : "on this route") : ko ? `경로에서 ${distTxt(s.off)}` : `${distTxt(s.off)} off the route`}</span>
      ${s.on ? "" : `<button class="btn small" data-sci-add="${esc(s.name)}">${ko ? `${s.min}분 조사 정차로 추가` : `Add as a ${s.min}-min science stop`}</button>`}</div></div>`).join("")}
    <p class="small muted">${ko ? "추가하면 조사 시간까지 넣어 경로를 다시 짜고, 산소·일조·귀환 점검이 그 시간을 반영해요. 위치는 NASA Trek의 큐리오시티 경유지예요." : "Adding a stop re-plans the route with the time on site, so the oxygen, daylight and walk-back checks include it. Locations are NASA Trek's Curiosity waypoints."}</p></div>`;
}
function bindScience() {
  $$("#reportBody [data-sci-filter]").forEach((b) => b.addEventListener("click", () => { sciFilter = b.dataset.sciFilter; renderPanes(); }));
  $$("#reportBody [data-sci-add]").forEach((b) => b.addEventListener("click", () => {
    const s = SCIENCE_SITES.find((x) => x.name === b.dataset.sciAdd); if (!s || !S.start || !S.end) return;
    const p = makePoint(s.lat, s.lon, s.name); if (!p) { toast(KOUI() ? "그 지점 근처에 갈 수 있는 땅이 없어요." : "No usable ground near that site."); return; }
    insertCheckpoint(p); p.dwell = s.min; changed();
  }));
}
// Radio contact, radiation dose, dust season and space weather for the route report
function conditionsCard(tr, A) {
  const ko = KOUI(), cm = A.comms, walk = tr.kind === "walk";
  const strip = A.samples.map((s) => `<i style="flex:1;background:${s.los === false ? "#9b6bff" : "#2fd68f"}"></i>`).join("");
  const shadow = cm ? cm.runs.reduce((s, r) => s + r.len, 0) : 0;
  const secs = tr.total.time + (walk ? A.back[A.back.length - 1] : 0), dose = walkDoseUSv(secs, A.skyAvg);
  const dust = dustSeason(A.Ls);
  return `<div class="card"><div class="eyebrow">${ko ? "기지와의 무선 가시선" : "Radio line of sight to base"}</div>
    <div class="kv"><div>${ko ? "가시선 구간" : "In sight"}<b>${fmt((cm?.frac ?? 1) * 100)}%</b></div><div>${ko ? "음영 합계" : "In shadow"}<b>${distTxt(shadow)}</b></div><div>${ko ? "가장 긴 음영" : "Longest gap"}<b>${cm?.runs.length ? distTxt(cm.longest.len) : "—"}</b></div></div>
    <div class="strip">${strip}</div><div class="legend-row" style="justify-content:space-between"><span>${ko ? "출발(기지)" : "start (base)"}</span><span>${ko ? "초록 = 가시선 · 보라 = 통신 음영" : "green = line of sight · purple = radio shadow"}</span><span>${ko ? "도착" : "end"}</span></div>
    <p class="small">${ko
      ? `출발점의 기지 안테나(높이 ${BASE_ANT_M} m)에서 우주복 안테나(${SUIT_ANT_M} m)까지 지형이 직선을 가리는지, 화성의 곡률까지 넣어 계산해요. 음영 구간에서는 기지와 교신이 끊길 수 있지만, 안내·안전 점검·음성 해석은 기기 안에서 계속돼요. 중계 위성은 계산하지 않아요.`
      : `Whether the terrain blocks the straight path from the base antenna at the start (${BASE_ANT_M} m mast) to the suit antenna (${SUIT_ANT_M} m), including the planet's curvature. In radio shadow the link to base can drop, but guidance, the safety checks and the voice assistant keep running on the device. Relay orbiters aren't modelled.`}</p></div>
    <div class="card"><div class="eyebrow">${ko ? "방사선량 · 먼지 · 우주 날씨" : "Radiation dose · dust · space weather"}</div>
    <div class="kv"><div>${ko ? "이번 EVA 예상 선량" : "Est. dose this EVA"}<b>≈ ${fmt(dose)} µSv</b></div><div>${ko ? "개활지 하루" : "Open ground, per day"}<b>${RAD_USV_PER_DAY} µSv</b></div><div>${ko ? "먼지 폭풍 철" : "Dust-storm season"}<b>${dust ? (ko ? "예" : "yes") : (ko ? "아니요" : "no")}</b></div></div>
    <p class="small">${ko
      ? `선량: 큐리오시티 RAD가 게일 크레이터 지표에서 측정한 하루 약 ${RAD_USV_PER_DAY} µSv(Hassler 외 2014)에, 이동 시간${walk ? "(귀환 포함)" : ""}과 경로의 평균 하늘 개방률(${fmt(A.skyAvg * 100)}%)을 곱한 대략적인 값이에요. 태양 입자 폭풍 때는 몇 배로 늘 수 있어요.`
      : `Dose: Curiosity's RAD measured about ${RAD_USV_PER_DAY} µSv a day on the surface in Gale crater (Hassler et al. 2014). This scales it by the time outside${walk ? " (including the walk back)" : ""} and the route's average open sky (${fmt(A.skyAvg * 100)}%): a rough estimate. A solar particle event can raise it many times.`}</p>
    <p class="small">${ko
      ? `먼지: 지금은 화성 계절 Ls ${fmt(A.Ls)}°예요. ${dust ? "Ls 180°–330°는 먼지 폭풍 철이라 지역 폭풍이 잦고, 기록된 전 지구 폭풍도 모두 이 시기에 시작했어요. 대피처와 오프라인 안내를 미리 확인하세요." : "먼지 폭풍 철(Ls 180°–330°)이 아니에요."} 공개된 화성 먼지 예보는 없어서, 실시간 날씨가 아니라 계절 통계예요.`
      : `Dust: the Mars season is now Ls ${fmt(A.Ls)}°. ${dust ? "Ls 180°–330° is dust-storm season: regional storms are common, and every recorded global storm began in it. Check your shelter and offline routes first." : "This is outside dust-storm season (Ls 180°–330°)."} No public Mars dust forecast exists, so this is climatology, not live weather.`}</p>
    <div id="swBox" class="small muted">${ko ? "NASA DONKI에서 화성 방향 태양 폭풍(CME) 예측을 확인하는 중…" : "Checking NASA DONKI for solar storms (CMEs) predicted to reach Mars…"}</div></div>`;
}
async function fillSpaceWeather() {
  const sw = await marsSpaceWeather(), box = $("#swBox"), ko = KOUI();
  if (!box) return;
  const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const ago = (ms) => { const h = Math.round((Date.now() - ms) / 3600e3); return h < 1 ? (ko ? "방금" : "just now") : ko ? `${h}시간 전` : `${h} h ago`; };
  if (sw.error) {
    box.textContent = sw.error === "offline"
      ? (ko ? "우주 날씨: 아직 받은 자료가 없어요(오프라인). 연결되면 NASA DONKI에서 받아요." : "Space weather: nothing loaded yet (offline). It comes from NASA DONKI once connected.")
      : (ko ? "우주 날씨: NASA DONKI가 지금 요청이 많아 응답하지 않아요. 15분 뒤 다시 시도해요." : "Space weather: NASA DONKI is busy right now (request limit). It will try again in 15 minutes.");
    return;
  }
  const s = stormNow(sw), next = sw.impacts.find((i) => i.arrival > Date.now());
  const src = ko ? `출처: NASA DONKI WSA-ENLIL 모델, ${ago(sw.fetched)} 갱신${sw.stale ? " (오프라인: 마지막 저장값)" : ""}.` : `Source: NASA DONKI WSA-ENLIL model runs, updated ${ago(sw.fetched)}${sw.stale ? " (offline: last saved)" : ""}.`;
  box.classList.toggle("muted", !s);
  box.innerHTML = s
    ? `<b style="color:var(--warn)">${ko ? "⚠ 태양 폭풍(CME)이 화성에 도달 예측" : "⚠ Solar storm (CME) predicted at Mars"}: ${when(s.arrival)}${s.glancing ? (ko ? " (스치는 충돌)" : " (glancing blow)") : ""}.</b> ${ko ? "가장 가까운 대피처를 미리 확인하세요." : "Know your nearest shelter before you go."} ${src}`
    : `${ko ? "앞으로 3일 안에 화성에 도달할 것으로 예측된 태양 폭풍(CME)은 없어요." : "No solar storm (CME) is predicted to reach Mars in the next 3 days."}${next ? (ko ? ` 다음 예측: ${when(next.arrival)}.` : ` Next predicted: ${when(next.arrival)}.`) : ""} ${src}`;
}

function renderPanes() {
  if (!S.track) {
    $("#stepsIntro").textContent = "Choose a start and a destination first."; $("#stepList").innerHTML = "";
    $("#reportBody").innerHTML = `<p class="muted">${S.error ? esc(S.error) : "Choose a start and a destination first."}</p>`; return;
  }
  const tr = S.track, A = S.ana, pts = tr.pts, t0 = startSec(), walk = tr.kind === "walk";
  // steps
  $("#stepsIntro").textContent = `${walk ? "Walking" : "Driving"} ${distTxt(tr.total.dist)} · ${dur(tr.total.time)} · tap a step to see it on the map.`;
  $("#stepList").innerHTML = S.mans.map((m, k) => `<li data-k="${k}"><span class="ico ${m.type}">${maneuverIcon(m, 26)}</span><span><div class="t">${esc(m.text)}</div><div class="s">${esc(m.sub || "")}</div></span><span class="d">${m.type === "arrive" && k === S.mans.length - 1 ? hhmm(t0 + tr.total.time) : distTxt(m.len)}</span></li>`).join("");
  $$("#stepList li").forEach((li) => li.addEventListener("click", () => flyToIdx(idxAtDist(pts, S.mans[+li.dataset.k].d))));
  // report
  const C = S.checks, worst = C.some((c) => c.lvl === "bad") ? "bad" : C.some((c) => c.lvl === "warn") ? "warn" : "ok";
  const dangerHtml = A.dangers.length
    ? A.dangers.map((d) => `<div class="danger-item" data-i="${d.i}"><span class="num ${d.sev}">${d.n}</span><span><div class="t">${esc(d.title)}</div><div class="s">${esc(d.sub)}</div></span><span class="at">${distTxt(d.dist)}</span></div>`).join("")
    : `<p class="muted">Nothing flagged: no steep sections, rocky stretches, no-go edges or shadow along this route.</p>`;
  // sky-open strip along the route (darker = better shielded)
  const strip = A.samples.map((s) => { const v = Math.round(60 + s.sky * 160); return `<i style="flex:1;background:rgb(${v * 0.35 | 0},${v * 0.65 | 0},${v})"></i>`; }).join("");
  const shadeStrip = A.samples.map((s) => `<i style="flex:1;background:${s.shade ? "#2b3546" : "#f5c84b"}"></i>`).join("");
  const sun0 = A.samples[0].sun, sun1 = A.samples[A.samples.length - 1].sun;
  const slopeBins = [[0, 8, "#2fd68f", "0–8°"], [8, 15, "#f5c84b", "8–15°"], [15, 20, "#f58a3b", "15–20°"], [20, 99, "#e9354f", "20°+"]].map(([a, b, c, l]) => {
    let len = 0; for (let i = 1; i < pts.length; i++) if (pts[i].slope >= a && pts[i].slope < b) len += pts[i].dist - pts[i - 1].dist;
    const f = len / tr.total.dist; return `<div class="bar-row"><span>${l}</span><span class="track"><i style="width:${f * 100}%;background:${c}"></i></span><span>${fmt(f * 100)}%</span></div>`;
  }).join("");
  const sh = A.shelter;
  $("#reportBody").innerHTML = `
    <div class="card"><div class="eyebrow">Verdict</div><h3 style="color:${worst === "ok" ? "var(--ok)" : worst === "warn" ? "var(--warn)" : "#ff7083"}">${esc($("#statusText").textContent)}</h3>
      ${C.map((c) => `<div class="check ${c.lvl}"><span class="ic">${c.lvl === "ok" ? "✓" : c.lvl === "warn" ? "!" : "✕"}</span><span>${esc(c.title)}<small>${esc(c.sub)}</small></span></div>`).join("")}</div>
    ${oxygenCard(tr, A)}
    <div class="card"><div class="eyebrow">Dangers along the route (${A.dangers.length})</div>${dangerHtml}</div>
    <div class="card"><div class="eyebrow">Elevation & slope</div>
      <div class="kv"><div>Highest<b>${fmt(A.emax)} m</b></div><div>Lowest<b>${fmt(A.emin)} m</b></div><div>Climb<b>↑${fmt(tr.total.ascent)} ↓${fmt(tr.total.descent)}</b></div></div>
      ${slopeBins}
      <p class="muted small">Heights from the HiRISE DEM tiles on Mars Trek (≈ ±5 m, see Data). Slope is measured over ~70 m, so single boulders and small steps don't show; those come from the rock-density layer.</p></div>
    <div class="card"><div class="eyebrow">Radiation shielding · relative, not a dose</div>
      <div class="kv"><div>Sky open, avg<b>${fmt(A.skyAvg * 100)}%</b></div><div>Most exposed<b>${fmt(Math.max(...A.samples.map((s) => s.sky)) * 100)}%</b></div><div>Best shelter<b>${sh ? fmt(sh.sky * 100) + "%" : "—"}</b></div></div>
      <div class="strip">${strip}</div><div class="legend-row" style="justify-content:space-between"><span>start</span><span>darker = more terrain shielding</span><span>end</span></div>
      <p class="small">Mars has no global magnetic field and a thin atmosphere, so cosmic rays and solar particles arrive from the whole open sky. Ridges and crater walls block part of it. <b>Sky open</b> is the share of the sky not hidden by terrain, from the HiRISE DEM: a relative measure only. The challenge data carry no dose measurements, so no dose is shown.</p>
      ${sh ? `<button class="btn small" id="goShelter">Show best shelter on map</button>` : ""}</div>
    <div class="card"><div class="eyebrow">Sunlight & shadow · sol ${marsClock().sol}, ${seasonName(A.Ls)} (Ls ${fmt(A.Ls)}°)</div>
      <div class="kv"><div>Sunrise<b>${A.day.rise != null ? hhmm(A.day.rise * 3600) : "—"}</b></div><div>Sunset<b>${A.day.set != null ? hhmm(A.day.set * 3600) : "—"}</b></div><div>In shadow<b>${fmt(A.shadeFrac * 100)}%</b></div></div>
      <div class="strip">${shadeStrip}</div><div class="legend-row" style="justify-content:space-between"><span>${hhmm(t0)}</span><span>yellow = sunlit · grey = terrain shadow</span><span>${hhmm(t0 + tr.total.time)}</span></div>
      <p class="small">Sun ${fmt(sun0.el)}° high (from the ${compassWord(sun0.az)}) at the start, ${fmt(sun1.el)}° (from the ${compassWord(sun1.az)}) on arrival. Sun position from the Mars24 algorithm; shadow where the terrain horizon is higher than the Sun.</p></div>
    <div class="card"><div class="eyebrow">Ground & thermal context</div>
      <p class="small">Turn on <b>THEMIS night-time IR</b> in Layers: bright ground stays warm at night (bedrock, cemented ridges, firm footing); dark ground is dust or sand (soft, can bog a rover). TES layers add regional mineral context.</p></div>
    <div class="card"><div class="eyebrow">Geologic context · USGS</div><div id="geoBox" class="small muted">Looking up the USGS geologic map…</div>
      <p class="small muted">USGS global geologic map of Mars (Tanaka et al. 2014, SIM 3292), queried through NASA Trek. At 1:20,000,000 a unit spans tens of kilometres: this is the regional setting, not ground truth for footing.</p></div>
    ${scienceCard(tr)}
    ${conditionsCard(tr, A)}
    ${curiosityCard()}
    <div class="card"><div class="eyebrow">${KOUI() ? "로버 자율주행 연구용 지형 내보내기" : "Rover-autonomy sandbox"}</div>
      <p class="small">${KOUI()
        ? "분석한 실제 화성 지형(고도·경사·바위 밀도·진입 금지 격자), 로버 한계, AresNav가 짠 경로(기준선), 이 지역을 지나간 큐리오시티의 실제 주행 경로(전문가 시연)를 JSON 하나로 내보내요. 경로 계획·강화학습 에이전트를 실제 화성 지형에서 학습·비교하는 데 쓸 수 있어요. 격자가 수 m 단위라 카메라 기반 장애물 회피나 바퀴 물리 시뮬레이션용은 아니에요."
        : "Exports the analysed real Mars terrain (elevation, slope, rock density and no-go grids), the rover limits, the route AresNav planned (a baseline) and, where it crosses this ground, the path Curiosity's drivers actually took (an expert demonstration) as one JSON file. Use it to train or benchmark path-planning and reinforcement-learning agents on real Martian ground. Cells are metres across, so it is for route choice, not camera-based hazard avoidance or wheel physics."}</p>
      <button class="btn small" id="btnSandbox">${KOUI() ? "JSON 내보내기" : "Export JSON"}</button></div>`;
  fillSpaceWeather();
  bindScience();
  $("#btnSandbox")?.addEventListener("click", () => {
    const data = sandboxExport(S.site, { track: S.track, opts: S.opts, mode: S.mode });
    download(`aresnav-sandbox-${(S.site.source?.id || "gale").toString().slice(0, 40).replace(/[^a-z0-9_-]+/gi, "-")}.json`, JSON.stringify(data), "application/json");
  });
  $$("#reportBody .danger-item").forEach((el) => el.addEventListener("click", () => flyToIdx(+el.dataset.i)));
  bindCuriosityCard();
  const trk = S.track;
  routeGeology(trk).then((units) => {
    if (S.track !== trk || !$("#geoBox")) return;
    $("#geoBox").classList.remove("muted");
    $("#geoBox").innerHTML = units.length ? units.map((u) => `<div class="geo-row"><b>${esc(u.unit)}</b> ${esc(u.desc)}<span class="muted"> · from ${distTxt(u.at)}</span></div>`).join("") : "No geologic unit found for this route.";
  }).catch(() => { if ($("#geoBox")) $("#geoBox").textContent = "Couldn't reach the USGS geologic map service."; });
  $("#goShelter")?.addEventListener("click", () => { map.flyTo([sh.lat, sh.lon], 17.5); if (innerWidth <= 760) closeDrawer(); });
}

// ---------------- validation: Curiosity's real traverse ----------------
let curLegs = null, curSel = 0;
function curiosityCard() {
  const c = S.cmp;
  if (c) {
    const verdict = c.w50 >= 0.8 ? "closely follows" : c.w50 >= 0.5 ? "mostly follows" : c.w100 >= 0.5 ? "roughly follows" : "takes a different line from";
    return `<div class="card"><div class="eyebrow">Check against Curiosity's real path</div>
      <h3>The planned route ${verdict} the path Curiosity drove</h3>
      <div class="kv"><div>Within 50 m<b>${fmt(c.w50 * 100)}%</b></div><div>Median gap<b>${fmt(c.median)} m</b></div><div>Widest gap<b>${fmt(c.max)} m</b></div></div>
      <div class="kv"><div>Planned length<b>${distTxt(c.routeLen)}</b></div><div>Curiosity's path<b>${distTxt(c.curLen)}</b></div><div>Mode<b>${S.mode === "drive" ? "rover" : "on foot"}</b></div></div>
      <p class="small">Curiosity's path is drawn as a dashed orange line on the map. NASA Trek's traverse line has a vertex every ~${fmt(c.vertexSpacing)} m, so gaps under about 30 m are within its precision. Rover drivers also steered toward science targets and used sub-metre images, so a perfect match isn't expected; a close match means the planner picks ground that real Mars drivers judged safe.</p>
      ${legPicker()}</div>`;
  }
  return `<div class="card"><div class="eyebrow">Check against Curiosity's real path</div>
    <p class="small">Test the planner on ground a real rover crossed: pick a stretch of Curiosity's drive between two named waypoints. The app plans it in rover mode from NASA Trek terrain and compares its route with the path Curiosity's drivers chose.</p>${legPicker()}</div>`;
}
function legPicker() {
  curLegs ||= curiosityLegs();
  if (!curLegs.length) return "";
  return `<div class="leg-pick"><select id="curLeg" aria-label="Stretch of Curiosity's drive">${curLegs.map((l, i) => `<option value="${i}" ${i === curSel ? "selected" : ""}>${esc(l.from.name)} → ${esc(l.to.name)} (${distTxt(l.len)})</option>`).join("")}</select><button class="btn small" id="curGo">Plan &amp; compare</button></div>`;
}
function bindCuriosityCard() {
  $("#curGo")?.addEventListener("click", () => {
    curSel = +$("#curLeg").value; const l = curLegs[curSel];
    fitOnPlan = true; userMoved = false;
    routeTo({ start: l.from, end: l.to, cps: [], mode: "drive" }, (r) => { if (r.ok) openDrawer("report"); else toast(r.error || "Couldn't plan that stretch."); });
    if (innerWidth <= 760) closeDrawer();
  });
}

// ---------------- alternative routes ----------------
const ALTS = [{ label: "Fastest", risk: 0, color: "#4aa3ff" }, { label: "Balanced", risk: 1, color: "#f5c84b" }, { label: "Safest", risk: 3, color: "#c58cff" }];
function routeStats(tr) {
  const walk = tr.kind === "walk", lim = walk ? 15 : S.opts.roverMaxSlope * 0.8, pts = tr.pts;
  let steep = 0, near = 0, haz = 0, smax = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i].dist - pts[i - 1].dist, p = pts[i];
    if (p.slope > lim) steep += d;
    if (nearNogo(S.site, p)) near += d;
    haz += p.hazard * d; smax = Math.max(smax, p.slope);
  }
  return { steep, near, haz: haz / tr.total.dist, smax };
}
function hideAlts() { altGroup?.clearLayers(); $("#altBox")?.classList.add("hidden"); }
function compareRoutes() {
  if (!S.track) return;
  const box = $("#altBox");
  box.classList.remove("hidden"); box.innerHTML = '<p class="small muted">Planning the alternatives…</p>';
  const base = S.track;
  setTimeout(() => {
    if (S.track !== base) return;
    const cur = S.opts.risk, rows = ALTS.map((a) => ({ ...a }));
    if (!rows.some((a) => Math.abs(a.risk - cur) < 0.01)) rows.push({ label: "Your setting", risk: cur, color: "#2fd68f" });
    rows.sort((a, b) => a.risk - b.risk);
    for (const a of rows) {
      a.current = Math.abs(a.risk - cur) < 0.01;
      a.track = a.current ? S.track : buildTrack(profileFor(S.mode, { ...S.opts, risk: a.risk })).track;
      if (a.track) a.stats = routeStats(a.track);
    }
    altGroup.clearLayers();
    for (const a of rows) if (a.track && !a.current)
      L.polyline(a.track.pts.map((p) => [p.lat, p.lon]), { color: a.color, weight: 4, opacity: 0.9, dashArray: "8 7" }).bindTooltip(`${a.label}: ${dur(a.track.total.time)}`, { sticky: true }).addTo(altGroup);
    const best = (f) => Math.min(...rows.filter((a) => a.stats).map(f));
    const cell = (v, b, txt) => `<td class="${Math.abs(v - b) < 1e-6 ? "best" : ""}">${txt}</td>`;
    const tT = best((a) => a.track.total.time), tS = best((a) => a.stats.steep), tN = best((a) => a.stats.near), tH = best((a) => a.stats.haz);
    box.innerHTML = `<div class="alt-head"><b>Route options</b><button class="icon-btn" id="altClose" aria-label="Close route options">✕</button></div>
      <table class="alt-table"><tr><th></th><th>Time</th><th>Steep</th><th>Near no-go</th><th>Hazard</th><th></th></tr>
      ${rows.map((a, i) => a.track ? `<tr><td><span class="alt-sw" style="background:${a.color}"></span>${a.label}</td>${cell(a.track.total.time, tT, dur(a.track.total.time))}${cell(a.stats.steep, tS, distTxt(a.stats.steep))}${cell(a.stats.near, tN, distTxt(a.stats.near))}${cell(a.stats.haz, tH, fmt(a.stats.haz * 100) + "%")}<td>${a.current ? '<span class="muted small">current</span>' : `<button class="btn small" data-alt="${i}">Use</button>`}</td></tr>` : `<tr><td>${a.label}</td><td colspan="5" class="muted">no route</td></tr>`).join("")}</table>
      <p class="small muted">Same start, stops and limits; only the route preference changes. Steep = ground over ${S.mode === "walk" ? 15 : fmt(S.opts.roverMaxSlope * 0.8)}°. Hazard = average slope-and-rock score along the way. Best in each column is highlighted; dashed lines on the map.</p>`;
    $("#altClose").addEventListener("click", hideAlts);
    $$("[data-alt]", box).forEach((b) => b.addEventListener("click", () => { const a = rows[+b.dataset.alt]; const r = $("#inRisk"); r.value = a.risk; r.dispatchEvent(new Event("input")); toast(`Using the ${a.label.toLowerCase()} route.`); }));
  }, 30);
}

// ---------------- export ----------------
function routeName() { return `${S.start?.name || coordTxt(S.start)} to ${S.end?.name || coordTxt(S.end)}`; }
function exportGpx() {
  if (!S.track) return;
  const slug = routeName().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "route";
  download(`aresnav-${slug}.gpx`, toGPX(S.track, { name: `AresNav: ${routeName()}`, dangers: S.ana.dangers, mode: S.mode }), "application/gpx+xml");
}
function exportSheet() {
  if (!S.track) return;
  const tr = S.track, t0 = startSec(), C = S.checks;
  const worst = C.some((c) => c.lvl === "bad") ? "bad" : C.some((c) => c.lvl === "warn") ? "warn" : "ok";
  const ok = openRouteSheet({
    title: `AresNav route sheet: ${routeName()}`,
    summary: `${tr.kind === "drive" ? "Rover" : "Crew on foot"} · ${distTxt(tr.total.dist)} · ${dur(tr.total.time)} · start ${hhmm(t0)} LMST, arrive ${hhmm(t0 + tr.total.time)} · ↑${fmt(tr.total.ascent)} m ↓${fmt(tr.total.descent)} m · terrain ${fmt(S.site.cell_m)} m grid (${S.site.live ? sourceLabel(S.site.source) : "HiRISE 1 m DEM, prebuilt"}) · sol ${marsClock().sol}`,
    status: $("#statusText").textContent, statusLvl: worst, checks: C,
    steps: S.mans.map((m, k) => ({ text: m.text, sub: m.sub, d: m.type === "arrive" && k === S.mans.length - 1 ? `${hhmm(t0 + tr.total.time)} LMST` : distTxt(m.len) })),
    dangers: S.ana.dangers.map((d) => ({ n: d.n, title: d.title, sub: d.sub, at: distTxt(d.dist) })),
    profileSvg: $("#profileSvg").outerHTML,
    notes: "Planning aid for a concept study, not flight software. Terrain from NASA Mars Trek; radiation shielding is a relative sky-openness measure, not a dose. Generated by AresNav.",
  });
  if (!ok) toast("Allow pop-ups for this page to open the route sheet.");
}

function renderAbout() {
  const d = S.baseSite.dem_scale;   // the 8-bit scale disclosure is about the prebuilt box
  $("#aboutBody").innerHTML = `
    <h3>The site</h3><p>${esc(ABOUT_SITE)} Routes can be planned anywhere on Mars. Dotted outlines mark the ${CATALOG.dems.length} regions where Trek has a sharp regional elevation model (green: HiRISE ~1 m, purple: CTX / HRSC); elsewhere only the global 200 m blend exists, which is good for reconnaissance but can't show cliffs or boulder fields. The orange dashed box is the ground analysed for the current route: ${fmt((S.site.nx * S.site.cell_m) / 1000, 1)} × ${fmt((S.site.ny * S.site.cell_m) / 1000, 1)} km on a ${fmt(S.site.cell_m)} m grid from ${S.site.live ? `${esc(sourceLabel(S.site.source))}${S.site.rock ? `, rock density from ${esc(S.site.rock.mosaic)}` : ", rock density not assessed (no HiRISE mosaic)"}` : "the prebuilt lower Mount Sharp data"}. Context: NASA's <a href="https://science.nasa.gov/resource/curiositys-proposed-path-up-mount-sharp/" target="_blank" rel="noopener">Curiosity's proposed path up Mount Sharp</a>.</p>
    <h3>Radio contact, dose, dust and space weather</h3><p><b>Radio:</b> line of sight from a 5 m base antenna at the route start to a 2 m suit antenna, over the terrain grid and the planet's curvature; relay orbiters aren't modelled. <b>Dose:</b> Curiosity RAD's ~640 µSv/day on the surface at Gale (Hassler et al. 2014), scaled by time outside and the route's average open sky; a rough estimate. <b>Dust:</b> Ls 180°–330° is dust-storm season (climatology; no public Mars dust forecast exists). <b>Space weather:</b> CMEs that NASA DONKI's WSA-ENLIL model runs predict to reach Mars, refreshed at most every 3 hours and kept for offline use.</p>
    <h3>How oxygen is planned</h3><p>A planning estimate, not a sensor reading. The suit's rated time (Settings → Suit oxygen, default 8 h, 1 h kept in reserve) is taken to hold for walking on the flat at the planned pace; climbs, pace, carried load (Settings → Carried load) and rocky ground scale the use up or down with the Pandolf et al. 1977 load-carriage equation. At every point the time already out plus the time to walk back to the start along the same path must fit in the usable oxygen; the leftover is the walk-back margin. Two-person EVAs are also checked for the case where one crew member is hurt and the pair walks back at 60% pace, and the report gives how long a pressurized rover from base needs to reach the farthest point (route distance at 60% of the rover's flat speed). The route report's <b>Oxygen plan</b> shows it along the whole route, and guidance warns when the margin runs low. Real use varies with effort, slope and the suit.</p>
    <h3>How a route is planned</h3><ul>
      <li>A* search over the grid finds the quickest path, with extra cost near steep or rocky ground (the <i>route preference</i> setting).</li>
      <li>Crew on foot: no ground steeper than ${S.opts.maxSlope}°; walking speed from Tobler's hiking function, slowed by rocks.</li>
      <li>Rover: slope and rock limits from Settings; speed falls with slope and rocks.</li>
      <li>Turn instructions come from where the path bends; each says why (steep ground or a rock ridge straight ahead).</li></ul>
    <h3>Data used: NASA Mars Trek only</h3><ul>
      <li><b>HiRISE mosaic</b> of Curiosity's roving site (MRO, ~25 cm/px): rock and ridge density from image texture.</li>
      <li><b>HiRISE Gale crater DEM</b>: elevation, slope, terrain horizons (shadow and sky-view).</li>
      <li>Anywhere else on Mars, the app picks the sharpest elevation model Trek has for your route (${CATALOG.dems.length} regional HiRISE / CTX / HRSC models, outlined on the map; otherwise the global MOLA + HRSC 200 m blend) and analyses a corridor around the route in the browser. Metres come from Trek's elevation services where they exist; for models served only as 8-bit tiles, a metre scale was fitted against the global blend. Rock density uses HiRISE image texture where a HiRISE mosaic covers the ground.</li>
      <li><b>USGS global geologic map of Mars</b> (Tanaka et al. 2014, SIM 3292), served by Trek: map layer, and the report names the geologic units a route crosses. At 1:20,000,000 it gives regional context only.</li>
      <li>CTX, Viking (MDIM 2.1, made by USGS Astrogeology), MOLA, THEMIS and TES layers as map context.</li>
      <li><b>Curiosity's actual traverse</b> (Trek): used to check the planner against the route NASA's rover drivers chose.</li>
      <li>Sun position: the published Mars24 algorithm (Allison &amp; McEwen 2000), no data feed.</li></ul>
    <h3>Elevation scale (disclosure)</h3><p>Trek serves the HiRISE DEM as 8-bit display tiles, not metres. We convert with <code>metres = ${d.a} × DN ${d.b < 0 ? "−" : "+"} ${Math.abs(d.b)}</code>, fitted once against Curiosity's published traverse elevations (RMS ${d.rms_m} m). No Curiosity data is shipped or shown in the app; slopes, shadows and shielding don't depend on the constant, only the absolute heights do.</p>
    <h3>Not used</h3><p>The Mars 2020 raw-image feed was reviewed; this build draws a synthetic 3D terrain view instead of rover photos. The USGS geologic map is used for context but not for routing: the whole lower Mount Sharp planning area falls in just two of its map units, so it can't tell one route from another. No Gale-scale USGS geologic map was found on the Astrogeology hub.</p>
    <h3>Limits</h3><ul><li>Planning aid for a concept study, not flight software.</li><li>Features smaller than a few metres (single rocks, sand ripples) are not in the slope grid.</li><li>Radiation shown as relative terrain shielding only, no dose.</li></ul>`;
}

// ---------------- settings ----------------
function bindSettings() {
  const o = S.opts;
  const rng = [["#inSpeed", "#oSpeed", "flatSpeed", (v) => fmt(v, 1)], ["#inSlope", "#oSlope", "maxSlope", fmt], ["#inPlss", "#oPlss", "plssHours", (v) => fmt(v, 1)], ["#inLoad", "#oLoad", "loadKg", fmt],
    ["#inRisk", "#oRisk", "risk", (v) => (v < 0.5 ? "fastest" : v < 1.5 ? "balanced" : v < 2.5 ? "cautious" : "safest")],
    ["#inRvSpeed", "#oRvSpeed", "roverSpeed", (v) => fmt(v, 1)], ["#inRvSlope", "#oRvSlope", "roverMaxSlope", fmt], ["#inRvRough", "#oRvRough", "roverMaxRough", (v) => fmt(v * 100) + "%"]];
  const sync = () => { for (const [i, out, k, f] of rng) { $(i).value = o[k]; $(out).textContent = f(o[k]); } $("#inStart").value = o.startLMST; };
  for (const [i, out, k, f] of rng) $(i).addEventListener("input", (e) => { o[k] = +e.target.value; $(out).textContent = f(o[k]); changed(); });
  $("#inStart").addEventListener("change", (e) => { o.startLMST = e.target.value || "09:00"; changed(); });
  $("#inDetail").value = o.detail === "high" ? "high" : "standard";
  $("#inDetail").addEventListener("change", (e) => { o.detail = e.target.value; changed(); });
  $("#btnReset").addEventListener("click", () => { Object.assign(o, DEFAULTS); S.start = S.end = null; S.cps = []; sync(); setPick("start"); changed(); closeDrawer(); });
  sync();
}

// ---------------- navigation ----------------
let NAV = null;

function live(t) {
  const tr = S.track, A = S.ana, o = S.opts, walk = tr.kind === "walk", pts = tr.pts;
  const st = stateAt(tr, t), man = nextManeuver(S.mans, st);
  const mi = S.mans.indexOf(man), after = S.mans[mi + 1];
  const distTo = man ? Math.max(0, man.d - st.dist) : 0;
  const lmst = startSec() + t;
  const smp = A.samples[Math.min(A.samples.length - 1, Math.round(st.dist / A.step))];
  const sun = sunAt(lmst / 3600, new Date());
  const shade = sun.el <= 0 || horizonToward(smp.hz, sun.az) > sun.el;
  const i = st.i, f = pts[i + 1] ? (st.dist - pts[i].dist) / Math.max(1e-6, pts[i + 1].dist - pts[i].dist) : 0;
  const back = A.back[i] + (A.back[Math.min(i + 1, pts.length - 1)] - A.back[i]) * Math.min(1, Math.max(0, f));
  let slopeAhead = 0; for (let k = i; k < pts.length && pts[k].dist <= st.dist + 50; k++) slopeAhead = Math.max(slopeAhead, pts[k].slope);
  const out = { t, st, man, after, distTo, lmst, sun, shade, sky: smp.sky, los: smp.los !== false, slopeAhead, back, walk,
    arrive: startSec() + tr.total.time, remainDist: tr.total.dist - st.dist, remainTime: Math.max(0, tr.total.time - t), done: t >= tr.total.time };
  if (walk) {
    const lerp = (arr) => arr[i] + (arr[Math.min(i + 1, pts.length - 1)] - arr[i]) * Math.min(1, Math.max(0, f));
    const used = t >= tr.total.time ? A.o2Out[pts.length - 1] + (t - tr.total.time) * 0.65 : lerp(A.o2Out);
    out.o2Left = o.plssHours * 3600 - used; out.o2Back = lerp(A.o2Back); out.margin = out.o2Left - o.reserveHours * 3600 - out.o2Back;
  }
  else {
    const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
    out.speed = b.t > a.t ? ((b.dist - a.dist) / (b.t - a.t)) * 3.6 : 0;
    if (st.dwell >= 0) out.speed = 0;
  }
  // what the banner shows: long straight stretches read "Continue …, then …" like a car navigator
  out.disp = man && distTo > 250 && man.type !== "depart"
    ? { m: { type: "depart" }, text: `Continue ${compassWord(st.heading)}`, sub: `then ${man.text.charAt(0).toLowerCase()}${man.text.slice(1)}` }
    : { m: man, text: man?.text || "", sub: man?.sub || "" };
  // stop card
  const stops = tr.stops;
  if (st.dwell > 0 && st.dwell < stops.length - 1) out.station = { s: stops[st.dwell], left: stops[st.dwell].depart - t, here: true };
  else { const nx = stops.find((s, k) => k > 0 && pts[s.idx].dist > st.dist && pts[s.idx].dist - st.dist < 40); if (nx) out.station = { s: nx, here: false, dist: pts[nx.idx].dist - st.dist }; }
  // alert (one, most important first)
  if (walk && out.margin < 0) out.alert = "Turn back now: not enough oxygen left to walk back with reserve";
  else if (walk && out.margin < 1800) out.alert = `Walk-back margin ${dur(out.margin)}: plan to turn back soon`;
  else if (slopeAhead > (walk ? 20 : o.roverMaxSlope * 0.85)) out.alert = `Steep ground ahead: ${fmt(slopeAhead)}°`;
  else if (sun.el > 0 && shade && !A.samples[Math.max(0, Math.round(st.dist / A.step) - 2)].shade) out.alert = "Entering terrain shadow: colder, check footing";
  return out;
}

function startNav(intro) {
  marsSpaceWeather().catch(() => {});
  if (!S.track) return;
  if (typeof intro !== "string" && intro !== false) intro = undefined; // click events pass an Event
  closeDrawer(); setPick(null); map.closePopup();
  NAV = { t: 0, playing: true, rate: +$("#navRate").value, follow: true, lastTs: 0, lastDom: 0 };
  $("#planView").classList.add("hidden"); $("#navView").classList.remove("hidden");
  $(".map-legend").classList.add("hidden");
  renderMarkers();
  meMarker = L.marker([S.start.lat, S.start.lon], { icon: L.divIcon({ className: "me-marker", html: '<svg width="30" height="30" viewBox="0 0 30 30"><circle cx="15" cy="15" r="13" fill="#4aa3ff" stroke="#fff" stroke-width="3"/><path d="M15 6 21 21 15 18 9 21z" fill="#fff"/></svg>', iconSize: [30, 30] }), zIndexOffset: 2000, interactive: false }).addTo(map);
  map.setView([S.start.lat, S.start.lon], 17.5);
  document.body.classList.add("navigating");
  $("#navScrub").value = 0;
  voiceNavStart(live(0), intro);
  requestAnimationFrame(navLoop);
}
function endNav() {
  if (hudIsOpen()) closeHud();
  voiceNavEnd(); clear3dPos();
  NAV = null; document.body.classList.remove("navigating"); meMarker?.remove(); meMarker = null; doneLine?.setLatLngs([]);
  $("#navView").classList.add("hidden"); $("#planView").classList.remove("hidden"); $(".map-legend").classList.remove("hidden");
  renderMarkers();
  fitRoute();
}
function setPlaying(p) {
  if (!NAV) return;
  if (p && NAV.t >= S.track.total.time) NAV.t = 0;
  NAV.playing = p;
  const ic = p ? "❚❚" : "▶";
  $("#navPlay").textContent = ic; $("#hudPlay").textContent = ic;
}
function navLoop(ts) {
  if (!NAV) return;
  const dt = NAV.lastTs ? Math.min(0.25, (ts - NAV.lastTs) / 1000) : 0;
  NAV.lastTs = ts;
  const total = S.track.total.time;
  if (NAV.playing) { NAV.t = Math.min(total, NAV.t + dt * NAV.rate); if (NAV.t >= total) setPlaying(false); }
  const Lv = live(NAV.t);
  meMarker.setLatLng([Lv.st.lat, Lv.st.lon]);
  const svg = meMarker.getElement()?.querySelector("svg"); if (svg) svg.style.transform = `rotate(${Lv.st.heading}deg)`;
  if (NAV.follow) map.setView([Lv.st.lat, Lv.st.lon], map.getZoom(), { animate: false });
  if (ts - NAV.lastDom > 100) { NAV.lastDom = ts; renderNav(Lv); }
  if (hudIsOpen()) updateHud(Lv);
  if (is3dOpen()) pos3d(Lv.st.lat, Lv.st.lon);
  voiceTick(Lv);
  requestAnimationFrame(navLoop);
}
function renderNav(Lv) {
  const tr = S.track, m = Lv.man;
  doneLine.setLatLngs(tr.pts.slice(0, Lv.st.i + 1).map((p) => [p.lat, p.lon]).concat([[Lv.st.lat, Lv.st.lon]]));
  const banner = $("#navBanner");
  banner.className = `nav-banner ${Lv.disp.m?.type === "steep" ? "steep" : Lv.disp.m?.type === "arrive" || Lv.done ? "arrive" : ""}`;
  const ko = KOUI();
  if (Lv.done) { $("#navIco").innerHTML = maneuverIcon({ type: "arrive" }, 46); $("#navDist").textContent = ko ? "도착" : "Arrived"; $("#navMain").textContent = ko ? (tr.kind === "drive" ? "로버를 세우고 수평을 맞추세요" : "도착했습니다") : tr.kind === "drive" ? "Park and level the rover" : "You have arrived"; $("#navSub").textContent = `${hhmm(Lv.lmst)} LMST`; }
  else if (Lv.st.dwell > 0) { $("#navIco").innerHTML = maneuverIcon({ type: "arrive" }, 46); $("#navDist").textContent = ko ? `${navKo.dur(Lv.station?.left ?? 0)} 남음` : `${dur(Lv.station?.left ?? 0)} left`; $("#navMain").textContent = ko ? `${tr.stops[Lv.st.dwell].stop.name}에 정지 중` : `At ${tr.stops[Lv.st.dwell].stop.name}`; $("#navSub").textContent = ko ? "체크포인트 정지" : "Checkpoint stop"; }
  else {
    $("#navIco").innerHTML = maneuverIcon(Lv.disp.m, 46); $("#navDist").textContent = distTxt(Lv.distTo);
    const k = !ko ? Lv.disp : /^Continue /.test(Lv.disp.text) ? navKo.cont(Lv.disp.text.replace(/^Continue /, ""), Lv.man?.text) : navKo.man(Lv.disp.text, Lv.disp.sub);
    $("#navMain").textContent = k.text; $("#navSub").textContent = k.sub;
  }
  const then = $("#navThen");
  if (Lv.after && !Lv.done && Lv.disp.m === m && Lv.after.d - (m?.d ?? 0) < 60) { then.classList.remove("hidden"); then.innerHTML = `${ko ? "다음" : "Then"} ${maneuverIcon(Lv.after, 18)} ${esc(ko ? navKo.man(Lv.after.text).text : Lv.after.text)}`; } else then.classList.add("hidden");
  $("#navAlert").classList.toggle("hidden", !Lv.alert); $("#navAlert").textContent = Lv.alert ? `⚠ ${ko ? navKo.alert(Lv.alert) : Lv.alert}` : "";
  $("#navEta").textContent = ko ? `${hhmm(Lv.arrive)} 도착` : `${hhmm(Lv.arrive)} arrival`;
  $("#navRemain").textContent = ko ? `${navKo.dur(Lv.remainTime)} · ${distTxt(Lv.remainDist)} 남음` : `${dur(Lv.remainTime)} · ${distTxt(Lv.remainDist)} to go`;
  const v = (k, val, lvl = "") => `<div class="vital ${lvl}">${k}<b>${val}</b></div>`;
  $("#navVitals").innerHTML = (Lv.walk
    ? v(ko ? "산소 잔량" : "O₂ left", ko ? navKo.dur(Lv.o2Left) : dur(Lv.o2Left), Lv.o2Left < S.opts.reserveHours * 3600 ? "bad" : "") + v(ko ? "귀환 여유" : "Walk-back margin", ko ? navKo.dur(Lv.margin) : dur(Lv.margin), Lv.margin < 0 ? "bad" : Lv.margin < 1800 ? "warn" : "")
    : v(ko ? "속도" : "Speed", `${fmt(Lv.speed, 1)} km/h`) + v(ko ? "기울기" : "Tilt", `${fmt(Lv.st.p.slope)}° / ${S.opts.roverMaxSlope}°`, Lv.st.p.slope > S.opts.roverMaxSlope * 0.85 ? "warn" : ""))
    + v(ko ? "고도" : "Elevation", `${fmt(Lv.st.p.elev)} m`) + v(ko ? "하늘 개방" : "Sky open", `${fmt(Lv.sky * 100)}%`)
    + v(ko ? "기지 통신" : "Base link", Lv.los ? (ko ? "가시선" : "in sight") : (ko ? "통신 음영" : "radio shadow"), Lv.los ? "" : "warn")
    + v(ko ? "태양" : "Sun", Lv.sun.el <= 0 ? (ko ? "지평선 아래" : "below horizon") : Lv.shade ? (ko ? "그늘" : "in shadow") : `${fmt(Lv.sun.el)}° ${ko ? navKo.dir(compassWord(Lv.sun.az)) : compassWord(Lv.sun.az)}`, Lv.shade ? "warn" : "");
  $("#navScrub").value = Math.round((Lv.t / tr.total.time) * 1000);
  // checkpoint card with a 3D look ahead
  const card = $("#navStation");
  if (Lv.station && Lv.station.here) {
    const s = Lv.station.s, p = tr.pts[s.idx];
    if (card.dataset.k !== String(s.stop.k)) {
      card.dataset.k = s.stop.k;
      const nextStop = tr.stops[tr.stops.indexOf(s) + 1];
      card.innerHTML = `<div class="eyebrow">Checkpoint</div><h3>${esc(s.stop.name)}</h3><canvas width="640" height="360"></canvas><div class="small muted">Elevation ${fmt(p.elev)} m · slope ${fmt(p.slope, 1)}° · rocks ${fmt(p.rough * 100)}% · sky open ${fmt(Lv.sky * 100)}%. View: looking toward ${nextStop ? esc(nextStop.stop.name) : "the route ahead"}.</div>`;
      renderTerrainView(card.querySelector("canvas"), S.site, { lat: p.lat, lon: p.lon, heading: headingAt(tr.pts, p.dist + 10), eyeH: 1.8, route: tr.pts, dist: p.dist, pins: nextStop ? [{ lat: tr.pts[nextStop.idx].lat, lon: tr.pts[nextStop.idx].lon, label: nextStop.stop.name, hi: true }] : [] });
    }
    card.classList.remove("hidden");
  } else { card.classList.add("hidden"); card.dataset.k = ""; }
}

function hudApi() {
  return {
    site: S.site, track: S.track, mans: S.mans, opts: S.opts,
    isPlaying: () => NAV?.playing, togglePlay: () => setPlaying(!NAV.playing),
    toMap: () => closeHud(), exit: () => endNav(),
  };
}

// ---------------- help ----------------
const HELP = [
  ["Welcome to AresNav", "Plan safe EVA routes on Mars, on foot or by rover. An example route up lower Mount Sharp is already planned behind this card: press Start to try the guidance, or follow the next steps to plan your own.", '<svg width="80" height="80" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="#e8743b"/><path d="M6 18c5-3 9 2 14-1s6-2 7-1" stroke="#842e12" stroke-width="2.5" fill="none"/></svg>'],
  ["Pick your start", "Tap the map where the EVA begins (a green dot), anywhere on Mars. Dotted outlines mark sharp HiRISE / CTX elevation models; the terrain around your route is analysed when you choose it. Use Layers → Go to a site to jump to Jezero, Gale, Columbia Hills and more. Or tap the mic and say “route from the landing plain to the upper boxwork ridges”.", '<svg width="80" height="80" viewBox="0 0 80 80"><circle cx="40" cy="40" r="14" fill="#2fd68f" stroke="#fff" stroke-width="5"/></svg>'],
  ["Pick your destination", "Tap again for where you're going. The navigator finds the safest route around steep slopes and rock fields, colour-coded by slope.", '<svg width="200" height="80" viewBox="0 0 200 80"><path d="M20 60 C70 60 70 20 120 25 S170 30 180 20" stroke="#2fd68f" stroke-width="7" fill="none"/><circle cx="20" cy="60" r="8" fill="#2fd68f" stroke="#fff" stroke-width="3"/><circle cx="180" cy="20" r="8" fill="#e9354f" stroke="#fff" stroke-width="3"/></svg>'],
  ["Read the safety check", "Time, distance, oxygen walk-back margin, daylight, steep or rocky stretches, terrain shadow and radiation shielding. Open the report to see each danger on the map.", '<svg width="80" height="80" viewBox="0 0 80 80"><path d="M40 8 70 66H10z" fill="none" stroke="#f5c84b" stroke-width="6" stroke-linejoin="round"/><path d="M40 30v18M40 56v2" stroke="#f5c84b" stroke-width="6" stroke-linecap="round"/></svg>'],
  ["Checkpoints when you want them", "Tap the map once a route exists, or use “+ Add checkpoint”, to add a stop. Name it, set how long you'll stay, drag to move.", '<svg width="80" height="80" viewBox="0 0 80 80"><circle cx="40" cy="40" r="14" fill="#e8743b" stroke="#fff" stroke-width="4"/><text x="40" y="46" text-anchor="middle" font-family="monospace" font-weight="700" font-size="16" fill="#fff">1</text></svg>'],
  ["Start navigating", "Press Start for spoken turn-by-turn guidance, or HUD for the helmet display with a 3D view of the terrain ahead. During guidance, Return to start and Nearest shelter re-route you in one tap. Tap the mic (or press V) to ask the voice assistant about oxygen, the next turn or the nearest shelter.", '<svg width="80" height="80" viewBox="0 0 24 24"><path d="M12 2 4 21l8-4 8 4z" fill="#2fd68f"/></svg>'],
];
const HELP_KO = [
  ["AresNav에 오신 것을 환영합니다", "걸어서 또는 로버로 화성에서 안전한 EVA 경로를 계획하세요. 이 카드 뒤에 샤프산 아래쪽의 예제 경로가 이미 준비돼 있습니다. ‘안내 시작’을 눌러 안내를 체험하거나, 다음 단계를 따라 직접 경로를 만들어 보세요."],
  ["출발지 고르기", "EVA를 시작할 곳을 지도에서 누르세요(초록 점). 화성 어디든 됩니다. 점선 윤곽은 정밀한 HiRISE / CTX 고도 모델이 있는 곳이고, 경로를 정하면 그 주변 지형을 분석합니다. 레이어 → 사이트로 이동에서 예제로, 게일, 컬럼비아 힐스 등으로 바로 갈 수 있습니다. 또는 마이크를 누르고 “착륙 평원에서 박스워크 능선까지 안내해 줘”라고 말하세요."],
  ["목적지 고르기", "한 번 더 눌러 갈 곳을 정하세요. 내비게이터가 급경사와 바위 지대를 피해 가장 안전한 경로를 찾고, 경사에 따라 색으로 표시합니다."],
  ["안전 점검 읽기", "시간, 거리, 산소 귀환 여유, 일조, 가파르거나 바위가 많은 구간, 지형 그늘, 방사선 차폐를 보여 줍니다. 보고서를 열면 위험 지점을 지도에서 볼 수 있습니다."],
  ["원할 때 체크포인트 추가", "경로가 있을 때 지도를 누르거나 “+ 체크포인트 추가”를 눌러 들를 곳을 넣으세요. 이름을 붙이고, 머무를 시간을 정하고, 끌어서 옮길 수 있습니다."],
  ["안내 시작", "‘안내 시작’을 누르면 음성으로 길을 안내하고, HUD를 누르면 앞쪽 지형을 3D로 보여 주는 헬멧 화면이 열립니다. 안내 중에는 ‘출발지로 돌아가기’와 ‘가장 가까운 대피소’ 버튼으로 바로 경로를 바꿀 수 있습니다. 마이크를 누르거나(V 키) 산소, 다음 방향, 가장 가까운 대피소를 물어보세요."],
];
let helpK = 0;
function showHelp(k = 0) {
  helpK = k; $("#help").classList.remove("hidden");
  const [, , art] = HELP[k], [t, p] = KOUI() ? HELP_KO[k] : HELP[k];
  $("#helpStep").innerHTML = `<div class="art">${art}</div><h3>${t}</h3><p>${p}</p>`;
  $("#helpDots").innerHTML = HELP.map((_, i) => `<i class="${i === k ? "on" : ""}"></i>`).join("");
  $("#helpNext").textContent = KOUI() ? (k === HELP.length - 1 ? "확인" : "다음") : k === HELP.length - 1 ? "Got it" : "Next";
  $("#helpSkip").textContent = KOUI() ? "건너뛰기" : "Skip";
}
function hideHelp() { $("#help").classList.add("hidden"); store.set("marswalk.helped", 1); }

// ---------------- controls ----------------
function bindControls() {
  $$("[data-pick]").forEach((b) => b.addEventListener("click", () => setPick(S.pick === b.dataset.pick ? null : b.dataset.pick)));
  $("#pickCancel").addEventListener("click", () => setPick(null));
  $("#btnAddCp").addEventListener("click", () => setPick("cp"));
  $("#btnSwap").addEventListener("click", () => { [S.start, S.end] = [S.end, S.start]; S.cps.reverse(); changed(); });
  $("#btnExample").addEventListener("click", () => {
    S.start = makePoint(EXAMPLE.start.lat, EXAMPLE.start.lon, EXAMPLE.start.name); S.end = makePoint(EXAMPLE.end.lat, EXAMPLE.end.lon, EXAMPLE.end.name); S.cps = [];
    setPick(null); fitOnPlan = true; userMoved = false; changed(); fitRoute();
  });
  $("#btnClear").addEventListener("click", () => { S.start = S.end = null; S.cps = []; setPick("start"); changed(); });
  $$(".mode").forEach((b) => b.addEventListener("click", () => { S.mode = b.dataset.mode; changed(); }));
  $("#statusBtn").addEventListener("click", () => { const c = $("#checks"), open = c.classList.toggle("hidden") === false; $("#statusBtn").setAttribute("aria-expanded", open); });
  $("#btnStart").addEventListener("click", startNav);
  $("#btnHud").addEventListener("click", () => { if (!S.track) return; if (!NAV) startNav(); openHud(hudApi()); });
  $("#btnCompare").addEventListener("click", () => ($("#altBox").classList.contains("hidden") ? compareRoutes() : hideAlts()));
  $("#btnSheetExport").addEventListener("click", exportSheet);
  $("#btnGpx").addEventListener("click", exportGpx);
  $("#tipClose").addEventListener("click", () => { store.set("marswalk.tip", 1); $("#firstTip").classList.add("hidden"); });
  $("#navHome").addEventListener("click", () => { if (NAV) voiceAsk("take me back to base"); });
  $("#navShelter").addEventListener("click", () => { if (NAV) voiceAsk("take me to the nearest shelter"); });
  $("#btnSteps").addEventListener("click", () => openDrawer("steps"));
  $("#btnReport").addEventListener("click", () => openDrawer("report"));
  $$("[data-open]").forEach((b) => b.addEventListener("click", () => { const d = $("#drawer"); d.classList.contains("open") && d.dataset.pane === b.dataset.open ? closeDrawer() : openDrawer(b.dataset.open); }));
  $("#drawerClose").addEventListener("click", closeDrawer);
  $("#btnHelp").addEventListener("click", () => showHelp(0));
  $("#view2d").addEventListener("click", () => setView("2d"));
  $("#view3d").addEventListener("click", () => setView("3d"));
  $$("[data-view]").forEach((b) => b.addEventListener("click", () => { setView(b.dataset.view); if (innerWidth <= 760) closeDrawer(); }));
  $("#helpSkip").addEventListener("click", hideHelp);
  $("#helpNext").addEventListener("click", () => (helpK < HELP.length - 1 ? showHelp(helpK + 1) : hideHelp()));
  // navigation controls
  $("#navPlay").addEventListener("click", () => setPlaying(!NAV.playing));
  $("#navRate").addEventListener("change", (e) => { if (NAV) NAV.rate = +e.target.value; });
  $("#navExit").addEventListener("click", endNav);
  $("#navHud").addEventListener("click", () => openHud(hudApi()));
  $("#navRecenter").addEventListener("click", () => { NAV.follow = true; $("#navRecenter").classList.add("hidden"); });
  $("#navScrub").addEventListener("input", (e) => { NAV.t = (+e.target.value / 1000) * S.track.total.time; });
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.key === "Escape") { if (!$("#help").classList.contains("hidden")) hideHelp(); else if (hudIsOpen()) closeHud(); else if ($("#drawer").classList.contains("open")) closeDrawer(); else if (S.pick) setPick(null); else if (NAV) endNav(); }
    else if (NAV && e.key === " ") { e.preventDefault(); setPlaying(!NAV.playing); }
    else if (NAV && (e.key === "h" || e.key === "H")) hudIsOpen() ? closeHud() : openHud(hudApi());
    else if (NAV && (e.key === "m" || e.key === "M") && hudIsOpen()) closeHud();
    else if (e.key === "v" || e.key === "V") voiceToggleListen();
  });
  addEventListener("resize", () => { if (S.track && !$("#sheet").classList.contains("hidden")) renderProfile(); });
}

// ---------------- boot ----------------
async function main() {
  tickClock(); setInterval(tickClock, 10000);
  try { S.site = S.baseSite = await loadSite("data/"); S.site.overlays = { hazard: "data/hazard.png", slope: "data/slope.png", rough: "data/rough.png" }; }
  catch (e) { $("#emptyCard").innerHTML = `<div class="empty-title">Couldn't load the terrain data</div><p>${esc(e.message)}</p>`; return; }
  const saved = store.get("marswalk.v2");
  if (saved) {
    S.mode = saved.mode === "drive" ? "drive" : "walk";
    Object.assign(S.opts, saved.opts || {});
    const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && inExtent(p.lat, p.lon) && (inSite(S.site, p.lat, p.lon) || (p.unchecked = true));
    S.start = ok(saved.start) ? saved.start : null; S.end = ok(saved.end) ? saved.end : null;
    S.cps = (saved.cps || []).filter(ok).map((c) => ({ ...c, id: cpSeq++ }));
  }
  initMap(); bindControls(); bindSettings(); renderAbout();
  initVoice({
    S, live: () => (NAV ? live(NAV.t) : null), endNav, setPlaying, routeTo, planSummary,
    startNav: () => { if (S.track && !NAV) { startNav(); return true; } return false; },
    exampleRoute: () => $("#btnExample").click(),
    flyTo: (it) => flyToSite(it),
    onLang: () => { applyStatic(KOUI()); renderLegend(); renderCard(); renderOffline(); if (!$("#help").classList.contains("hidden")) showHelp(helpK); if (S.track || S.error) renderSheet(); if (NAV) renderNav(live(NAV.t)); },
    setView: (v) => setView(v),
    refine: () => { if (!S.track) return false; S.opts.detail = "high"; $("#inDetail").value = "high"; changed(); return true; },
    clearRoute: () => $("#btnClear").click(),
    getRate: () => NAV?.rate, setRate: (n) => { if (NAV) { NAV.rate = n; $("#navRate").value = String(n); } },
    openHud: () => { if (NAV && !hudIsOpen()) openHud(hudApi()); }, closeHud: () => { if (hudIsOpen()) closeHud(); },
  });
  // first visit: open on the example route, already planned, so the app shows what it does straight away
  if (!saved) { S.start = makePoint(EXAMPLE.start.lat, EXAMPLE.start.lon, EXAMPLE.start.name); S.end = makePoint(EXAMPLE.end.lat, EXAMPLE.end.lon, EXAMPLE.end.name); }
  if (S.start && S.end) { changed(); fitRoute(false); }
  else { changed(); setPick(S.start ? "end" : "start"); }
  if (!store.get("marswalk.helped")) showHelp(0);
  // Offline: dust storms or terrain can cut the link to the habitat or a relay. Everything already loaded keeps working.
  const net = () => toast(navigator.onLine
    ? (KOUI() ? "다시 연결됐어요." : "Back online.")
    : (KOUI() ? "오프라인이에요. 이미 불러온 지도·지형·경로로 안내와 음성 해석은 계속됩니다. 새 지역을 보려면 연결이 필요해요."
      : "Offline. Guidance and the voice assistant keep working with the maps, terrain and route already loaded; new places need a connection."), 7000);
  addEventListener("offline", net); addEventListener("online", net);
  if (!navigator.onLine) net();
}
main();
if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register("sw.js").catch(() => {});
