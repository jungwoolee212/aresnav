// Helpers that sit beside the planner: validation against Curiosity's real traverse, USGS geologic
// context, and route export (GPX + printable route sheet). No app state lives here.

import { distM } from "./planner.js";
import { PLACES_DATA } from "./places.js";

// ---------- Curiosity's actual traverse (NASA Trek "Curiosity traverse" line) ----------
const CUR = (() => {
  const t = PLACES_DATA.traverses.find((x) => x.name === "Curiosity traverse");
  const pts = t ? t.parts.flat() : [];
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + distM(pts[i - 1], pts[i]));
  return { pts, s };
})();

// local metric projection of point p onto segment a-b: returns { d (m), f (0..1) }
function projSeg(p, a, b) {
  const k = Math.cos((p[0] * Math.PI) / 180);
  const ax = (a[1] - p[1]) * k, ay = a[0] - p[0], bx = (b[1] - p[1]) * k, by = b[0] - p[0];
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const f = L2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / L2)) : 0;
  const q = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  return { d: distM(p, q), f, q };
}
// nearest point on the traverse (optionally only between arc lengths s0..s1)
function nearestOnTraverse(p, s0 = -Infinity, s1 = Infinity) {
  let best = null;
  for (let i = 1; i < CUR.pts.length; i++) {
    if (CUR.s[i] < s0 || CUR.s[i - 1] > s1) continue;
    const r = projSeg(p, CUR.pts[i - 1], CUR.pts[i]);
    if (!best || r.d < best.d) best = { d: r.d, s: CUR.s[i - 1] + r.f * (CUR.s[i] - CUR.s[i - 1]), q: r.q };
  }
  return best;
}
function traverseBetween(s0, s1) {
  const a = Math.min(s0, s1), b = Math.max(s0, s1), out = [];
  const at = (s) => { let i = 1; while (i < CUR.s.length - 1 && CUR.s[i] < s) i++; const f = (s - CUR.s[i - 1]) / Math.max(1e-6, CUR.s[i] - CUR.s[i - 1]); const p = CUR.pts[i - 1], q = CUR.pts[i]; return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]; };
  out.push(at(a));
  for (let i = 0; i < CUR.pts.length; i++) if (CUR.s[i] > a && CUR.s[i] < b) out.push(CUR.pts[i]);
  out.push(at(b));
  return s0 <= s1 ? out : out.reverse();
}

// Legs between Curiosity's named waypoints, both ends snapped onto the traverse line.
export function curiosityLegs() {
  if (!CUR.pts.length) return [];
  const wps = PLACES_DATA.waypoints.filter((w) => w[1] === "Curiosity")
    .map(([name, , lat, lon]) => ({ name, n: nearestOnTraverse([lat, lon]) }))
    .filter((w) => w.n && w.n.d < 300).sort((a, b) => a.n.s - b.n.s);
  const legs = [];
  for (let i = 1; i < wps.length; i++) {
    const a = wps[i - 1], b = wps[i], len = b.n.s - a.n.s;
    if (len < 400 || len > 6000) continue;
    legs.push({ id: `${a.name}→${b.name}`, from: { name: a.name, lat: a.n.q[0], lon: a.n.q[1] }, to: { name: b.name, lat: b.n.q[0], lon: b.n.q[1] }, len });
  }
  return legs;
}

// How closely does a planned route follow Curiosity's real path between the same two points?
// Returns null if the route's ends aren't on the traverse.
export function compareWithCuriosity(track, tolEnd = 150) {
  if (!CUR.pts.length || !track) return null;
  const pts = track.pts, A = [pts[0].lat, pts[0].lon], B = [pts[pts.length - 1].lat, pts[pts.length - 1].lon];
  const na = nearestOnTraverse(A), nb = nearestOnTraverse(B);
  if (!na || !nb || na.d > tolEnd || nb.d > tolEnd || Math.abs(nb.s - na.s) < 200) return null;
  const line = traverseBetween(na.s, nb.s);
  const devs = [];
  for (let d = 0, i = 0; i < pts.length; d += 10) {
    while (i < pts.length && pts[i].dist < d) i++;
    if (i >= pts.length) break;
    const p = [pts[i].lat, pts[i].lon];
    let m = Infinity; for (let k = 1; k < line.length; k++) m = Math.min(m, projSeg(p, line[k - 1], line[k]).d);
    devs.push(m);
  }
  const sorted = [...devs].sort((x, y) => x - y), q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  const within = (m) => devs.filter((x) => x <= m).length / devs.length;
  return { line, curLen: Math.abs(nb.s - na.s), routeLen: track.total.dist, median: q(0.5), p90: q(0.9), max: sorted[sorted.length - 1], w50: within(50), w100: within(100), vertexSpacing: CUR.s[CUR.s.length - 1] / Math.max(1, CUR.pts.length - 1) };
}

// ---------- USGS global geologic map (Tanaka et al. 2014, SIM 3292), served by NASA Trek ----------
export const GEO_TILES = "https://trek.nasa.gov/mars/trekarcgis/rest/services/SIM3292_Global_Geology/MapServer/WMTS/tile/1.0.0/SIM3292_Global_Geology/default/default028mm/{z}/{y}/{x}.png";
const GEO_QUERY = "https://trek.nasa.gov/mars/trekarcgis/rest/services/SIM3292_Global_Geology/MapServer/0/query";
const geoCache = new Map();
export async function geologicUnit(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const q = new URLSearchParams({ geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: 104905, spatialRel: "esriSpatialRelIntersects", outFields: "Unit,UnitDesc", returnGeometry: false, f: "json" });
  const p = fetch(`${GEO_QUERY}?${q}`, { mode: "cors" }).then((r) => r.json()).then((j) => { const a = j.features?.[0]?.attributes; return a ? { unit: a.Unit, desc: a.UnitDesc } : null; });
  geoCache.set(key, p);
  p.catch(() => geoCache.delete(key));
  return p;
}
// units crossed by a route: sample start, every ~quarter, end; consecutive duplicates merged
export async function routeGeology(track) {
  const pts = track.pts, idx = [0, 0.25, 0.5, 0.75, 1].map((f) => pts[Math.round(f * (pts.length - 1))]);
  const res = await Promise.all(idx.map((p) => geologicUnit(p.lat, p.lon).catch(() => null)));
  const out = [];
  res.forEach((u, k) => { if (u && out[out.length - 1]?.unit !== u.unit) out.push({ ...u, at: idx[k].dist }); });
  return out;
}

// ---------- export ----------
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
export function toGPX(track, { name, dangers = [], mode }) {
  const pts = track.pts;
  const wpt = (lat, lon, n, desc = "") => `  <wpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><name>${xml(n)}</name>${desc ? `<desc>${xml(desc)}</desc>` : ""}</wpt>\n`;
  let s = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="AresNav" xmlns="http://www.topografix.com/GPX/1/1">\n`;
  s += `  <metadata><name>${xml(name)}</name><desc>Mars, planetocentric latitude, east-positive longitude (Mars 2000 sphere). Elevations in metres relative to the Mars areoid. ${mode === "drive" ? "Rover" : "Crew on foot"} route planned from NASA Mars Trek terrain. Planning aid only.</desc></metadata>\n`;
  for (const st of track.stops) { const p = pts[st.idx]; s += wpt(p.lat, p.lon, st.stop.name, st.stop.dwell ? `Stop ${st.stop.dwell} min` : ""); }
  for (const d of dangers) { const p = pts[d.i]; s += wpt(p.lat, p.lon, `Hazard ${d.n}: ${d.title}`, d.sub); }
  s += `  <trk><name>${xml(name)}</name><trkseg>\n`;
  const stride = Math.max(1, Math.floor(pts.length / 4000));
  for (let i = 0; i < pts.length; i += stride) s += `    <trkpt lat="${pts[i].lat.toFixed(7)}" lon="${pts[i].lon.toFixed(7)}"><ele>${pts[i].elev.toFixed(1)}</ele></trkpt>\n`;
  const L = pts[pts.length - 1];
  s += `    <trkpt lat="${L.lat.toFixed(7)}" lon="${L.lon.toFixed(7)}"><ele>${L.elev.toFixed(1)}</ele></trkpt>\n  </trkseg></trk>\n</gpx>\n`;
  return s;
}
export function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
// A printable one-page route sheet (opens in a new tab; the browser's print dialog saves it as PDF).
export function openRouteSheet({ title, summary, status, statusLvl, checks, steps, dangers, profileSvg, notes }) {
  const w = window.open("", "_blank");
  if (!w) return false;
  const e = xml, col = { ok: "#127a4c", warn: "#9a6b00", bad: "#b3132f", info: "#2662b0" };
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${e(title)}</title><style>
    body{font:13px/1.45 -apple-system,Segoe UI,Inter,sans-serif;color:#111;margin:24px;max-width:820px}
    h1{font-size:20px;margin:0 0 4px} h2{font-size:14px;margin:18px 0 6px;border-bottom:1px solid #ccc;padding-bottom:3px}
    .muted{color:#555} .status{font-weight:700;color:${col[statusLvl] || "#111"}}
    table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #e3e3e3;padding:4px 6px;text-align:left;vertical-align:top} th{font-size:12px;color:#555}
    .lvl{font-weight:700;width:16px} svg{width:100%;height:120px;background:#1a1e26;border-radius:6px} svg text{font-family:ui-monospace,Menlo,monospace}
    @media print{body{margin:10mm} button{display:none}}
  </style></head><body>
  <button onclick="print()" style="float:right;padding:6px 14px">Print / save as PDF</button>
  <h1>${e(title)}</h1><div class="muted">${e(summary)}</div>
  <p class="status">${e(status)}</p>
  <h2>Safety checks</h2><table>${checks.map((c) => `<tr><td class="lvl" style="color:${col[c.lvl]}">${c.lvl === "ok" ? "✓" : c.lvl === "warn" ? "!" : "✕"}</td><td><b>${e(c.title)}</b><br><span class="muted">${e(c.sub)}</span></td></tr>`).join("")}</table>
  <h2>Elevation profile</h2>${profileSvg}
  <h2>Turn-by-turn</h2><table><tr><th>#</th><th>Instruction</th><th>Distance / time</th></tr>${steps.map((s, k) => `<tr><td>${k + 1}</td><td><b>${e(s.text)}</b>${s.sub ? `<br><span class="muted">${e(s.sub)}</span>` : ""}</td><td>${e(s.d)}</td></tr>`).join("")}</table>
  <h2>Hazards along the route (${dangers.length})</h2>${dangers.length ? `<table><tr><th>#</th><th>Hazard</th><th>At</th></tr>${dangers.map((d) => `<tr><td>${d.n}</td><td><b>${e(d.title)}</b><br><span class="muted">${e(d.sub)}</span></td><td>${e(d.at)}</td></tr>`).join("")}</table>` : "<p>None flagged.</p>"}
  <p class="muted" style="margin-top:18px">${e(notes)}</p>
  </body></html>`);
  w.document.close();
  return true;
}
