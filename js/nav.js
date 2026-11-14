// Turn-by-turn navigation: maneuvers from a planned track, and position/heading at a given time.
// A "track" is { kind: "walk"|"drive", pts:[{lat,lon,dist,t,elev,slope,rough,hazard}], stops:[{idx,stop,arrive,depart}], total:{dist,time} }

import { bearingDeg, sampleAt } from "./planner.js";

const DIRS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
export const compassWord = (b) => DIRS[Math.round((((b % 360) + 360) % 360) / 45) % 8];
const norm = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const ll = (p) => [p.lat, p.lon];

export function idxAtDist(pts, d) {
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].dist < d) lo = m + 1; else hi = m; }
  return lo;
}
const atDist = (pts, d) => pts[idxAtDist(pts, Math.max(0, Math.min(pts[pts.length - 1].dist, d)))];

function offset(site, p, brg, m) {
  const r = (brg * Math.PI) / 180;
  return [p.lat + (Math.cos(r) * m) / site.mPerDegLat, p.lon + (Math.sin(r) * m) / site.mPerDegLon];
}

// Why does the route turn here? Look straight ahead along the incoming direction.
function turnReason(site, p, brgIn) {
  let worst = null;
  for (const m of [15, 30, 45]) {
    const q = offset(site, p, brgIn, m);
    const s = sampleAt(site, q[0], q[1]);
    if (s && (!worst || s.hazard > worst.hazard)) worst = s;
  }
  if (!worst || worst.hazard < 0.35) return "";
  return worst.slope >= 18 || (worst.slope / 25) > worst.rough ? "to avoid steep ground" : "to avoid a rock ridge";
}

export function buildManeuvers(site, track) {
  const { pts, stops, kind } = track;
  const total = pts[pts.length - 1].dist;
  const out = [];
  const nextStopAfter = (d) => stops.find((s) => pts[s.idx].dist > d + 1);
  const label = (s) => (s ? s.stop.name : "your destination");

  // depart from the first stop and from every intermediate stop
  stops.forEach((s, k) => {
    if (k === stops.length - 1) return;
    const d0 = pts[s.idx].dist;
    const brg = bearingDeg(ll(atDist(pts, d0)), ll(atDist(pts, d0 + 30)));
    out.push({ d: d0 + 0.01, type: "depart", dir: 0, text: `Head ${compassWord(brg)}`, sub: `toward ${label(stops[k + 1])}`, brg });
  });

  // turns: local maxima of heading change over a ±W window
  const W = kind === "drive" ? 30 : 20;
  const cand = [];
  for (let d = W; d <= total - W; d += 4) {
    const a = atDist(pts, d - W), b = atDist(pts, d), c = atDist(pts, d + W);
    cand.push({ d, b, brgIn: bearingDeg(ll(a), ll(b)), delta: norm(bearingDeg(ll(b), ll(c)) - bearingDeg(ll(a), ll(b))) });
  }
  const stopD = stops.map((s) => pts[s.idx].dist);
  let last = -1e9;
  for (let k = 1; k < cand.length - 1; k++) {
    const c = cand[k], m = Math.abs(c.delta);
    if (m < 30 || m < Math.abs(cand[k - 1].delta) || m < Math.abs(cand[k + 1].delta)) continue;
    if (stopD.some((sd) => Math.abs(sd - c.d) < 18)) continue;
    if (c.d - last < 35) { const prev = out[out.length - 1]; if (prev?.type === "turn" && Math.abs(prev.delta) >= m) continue; if (prev?.type === "turn") out.pop(); }
    const word = m < 50 ? "Bear" : m < 120 ? "Turn" : "Sharp turn";
    const side = c.delta < 0 ? "left" : "right";
    const why = turnReason(site, c.b, c.brgIn);
    const ns = nextStopAfter(c.d);
    out.push({ d: c.d, type: "turn", delta: c.delta, dir: c.delta < 0 ? -1 : 1, sharp: m >= 50 ? (m >= 120 ? 2 : 1) : 0,
      text: `${word} ${side}`, sub: why ? `${why}, toward ${label(ns)}` : `toward ${label(ns)}` });
    last = c.d;
  }

  // steep sections
  const lim = 15;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].slope > lim && pts[i - 1].slope <= lim) {
      let j = i, mx = 0;
      while (j < pts.length && pts[j].slope > lim) { mx = Math.max(mx, pts[j].slope); j++; }
      const len = pts[Math.min(j, pts.length - 1)].dist - pts[i].dist;
      if (len >= 12) {
        const climb = pts[Math.min(j, pts.length - 1)].elev > pts[i].elev;
        out.push({ d: pts[i].dist, type: "steep", dir: 0, text: `Steep ${climb ? "climb" : "descent"} · ${Math.round(mx)}°`,
          sub: kind === "drive" ? `for ${Math.round(len)} m · slow down` : `for ${Math.round(len)} m · short steps, lean ${climb ? "forward" : "back"}` });
      }
      i = j;
    }
  }

  // arrivals
  stops.forEach((s, k) => {
    if (k === 0) return;
    const last = k === stops.length - 1;
    const st = s.stop;
    out.push({ d: pts[s.idx].dist, type: "arrive", stopK: k, dir: 0,
      text: last ? `Arrive at ${st.name}` : `Checkpoint: ${st.name}`,
      sub: last ? "End of route" : st.dwell ? `Stop here for ${st.dwell} min` : "" });
  });

  out.sort((a, b) => a.d - b.d || (a.type === "arrive" ? -1 : 1));
  // distance of each step = distance to the next maneuver
  out.forEach((m, k) => { m.len = (out[k + 1]?.d ?? total) - m.d; });
  return out;
}

// Position at time t (seconds since this track started).
export function stateAt(track, t) {
  const { pts, stops } = track;
  for (let k = 0; k < stops.length; k++) {
    const s = stops[k];
    if (s.depart > s.arrive && t >= s.arrive && t < s.depart) {
      const p = pts[s.idx];
      return { lat: p.lat, lon: p.lon, dist: p.dist, i: s.idx, dwell: k, p, heading: headingAt(pts, p.dist) };
    }
  }
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pts[m].t <= t) lo = m; else hi = m - 1; }
  const a = pts[lo], b = pts[Math.min(lo + 1, pts.length - 1)];
  const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
  const lat = a.lat + (b.lat - a.lat) * f, lon = a.lon + (b.lon - a.lon) * f, dist = a.dist + (b.dist - a.dist) * f;
  return { lat, lon, dist, i: lo, dwell: -1, p: a, heading: headingAt(pts, dist) };
}

export function headingAt(pts, d) {
  const total = pts[pts.length - 1].dist;
  const a = atDist(pts, Math.max(0, Math.min(d - 8, total - 16)));
  const b = atDist(pts, Math.min(total, Math.max(d + 8, 16)));
  return bearingDeg(ll(a), ll(b));
}

export function nextManeuver(mans, st) {
  if (st.dwell > 0) return mans.find((m) => m.type === "arrive" && m.stopK === st.dwell) || null;
  return mans.find((m) => m.d > st.dist + 0.5) || mans[mans.length - 1];
}

// Maneuver arrow icons (white on coloured banner)
export function maneuverIcon(m, size = 44) {
  const s = `width="${size}" height="${size}" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"`;
  if (!m) return "";
  if (m.type === "arrive") return `<svg ${s}><path d="M24 44s14-13 14-24a14 14 0 0 0-28 0c0 11 14 24 14 24z"/><circle cx="24" cy="20" r="5" fill="currentColor"/></svg>`;
  if (m.type === "steep") return `<svg ${s}><path d="M5 40 L22 18 L30 27 L43 10"/><path d="M34 10h9v9"/></svg>`;
  if (m.type === "depart") return `<svg ${s}><path d="M24 42V8"/><path d="M12 20 24 8l12 12"/></svg>`;
  const flip = m.dir < 0 ? ` transform="translate(48 0) scale(-1 1)"` : "";
  if (m.sharp === 2) return `<svg ${s}><g${flip}><path d="M16 44V14a8 8 0 0 1 16 0v18"/><path d="M24 26l8 8 8-8"/></g></svg>`;
  if (m.sharp === 1) return `<svg ${s}><g${flip}><path d="M14 44V22a6 6 0 0 1 6-6h20"/><path d="M30 6l10 10-10 10"/></g></svg>`;
  return `<svg ${s}><g${flip}><path d="M16 44V26l16-16"/><path d="M20 10h12v12"/></g></svg>`;
}
