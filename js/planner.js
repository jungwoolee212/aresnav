// Terrain grid + A* route planner (crew on foot or pressurized rover).
// Grid comes from tools/build_site_data.py (HiRISE imagery + HiRISE DEM from NASA Mars Trek).

export const MARS_R = 3389500;
const DEG = Math.PI / 180;

export async function loadSite(base = "data/") {
  const [meta, eb, tb] = await Promise.all([
    fetch(base + "site.json", { cache: "no-cache" }).then((r) => r.json()),
    fetch(base + "elev.bin", { cache: "no-cache" }).then((r) => r.arrayBuffer()),
    fetch(base + "terrain.bin", { cache: "no-cache" }).then((r) => r.arrayBuffer()),
  ]);
  const { nx, ny } = meta;
  const n = nx * ny;
  const ev = new DataView(eb), tv = new Uint8Array(tb);
  const elev = new Float32Array(n), slope = new Float32Array(n), rough = new Float32Array(n), hazard = new Float32Array(n), nogo = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    elev[i] = ev.getUint16(i * 2, true) * meta.elev_scale + meta.elev_offset;
    slope[i] = tv[i * 3] / 4;
    rough[i] = tv[i * 3 + 1] / 255;
    nogo[i] = tv[i * 3 + 2];
    hazard[i] = nogo[i] ? 1 : Math.min(1, 0.65 * Math.pow(Math.min(slope[i] / 25, 1), 1.5) + 0.35 * rough[i] * rough[i]);
  }
  const b = meta.bbox, latC = (b.north + b.south) / 2;
  return {
    ...meta, elev, slope, rough, nogo, hazard,
    dLon: (b.east - b.west) / nx, dLat: (b.north - b.south) / ny,
    mPerDegLat: MARS_R * DEG, mPerDegLon: MARS_R * DEG * Math.cos(latC * DEG),
  };
}

export function inSite(site, lat, lon) {
  const b = site.bbox;
  return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
}
export function cellOf(site, lat, lon) {
  const i = Math.min(site.nx - 1, Math.max(0, Math.floor((lon - site.bbox.west) / site.dLon)));
  const j = Math.min(site.ny - 1, Math.max(0, Math.floor((site.bbox.north - lat) / site.dLat)));
  return j * site.nx + i;
}
export function cellLatLon(site, idx) {
  const i = idx % site.nx, j = (idx / site.nx) | 0;
  return [site.bbox.north - (j + 0.5) * site.dLat, site.bbox.west + (i + 0.5) * site.dLon];
}
export function sampleAt(site, lat, lon) {
  if (!inSite(site, lat, lon)) return null;
  const k = cellOf(site, lat, lon);
  return { elev: site.elev[k], slope: site.slope[k], rough: site.rough[k], hazard: site.hazard[k], nogo: !!site.nogo[k] };
}
// bilinear elevation (smooth, for 3D view and horizons)
export function elevAt(site, lat, lon) {
  const x = (lon - site.bbox.west) / site.dLon - 0.5, y = (site.bbox.north - lat) / site.dLat - 0.5;
  if (x < 0 || y < 0 || x >= site.nx - 1 || y >= site.ny - 1) return null;
  const i = x | 0, j = y | 0, fx = x - i, fy = y - j, k = j * site.nx + i, e = site.elev;
  return e[k] * (1 - fx) * (1 - fy) + e[k + 1] * fx * (1 - fy) + e[k + site.nx] * (1 - fx) * fy + e[k + site.nx + 1] * fx * fy;
}

export function distM(a, b) {
  const dLat = (b[0] - a[0]) * DEG, dLon = (b[1] - a[1]) * DEG;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * DEG) * Math.cos(b[0] * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * MARS_R * Math.asin(Math.sqrt(s));
}
export function bearingDeg(a, b) {
  const y = Math.sin((b[1] - a[1]) * DEG) * Math.cos(b[0] * DEG);
  const x = Math.cos(a[0] * DEG) * Math.sin(b[0] * DEG) - Math.sin(a[0] * DEG) * Math.cos(b[0] * DEG) * Math.cos((b[1] - a[1]) * DEG);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

// ---- vehicle models (km/h) ----
// Suited walker: Tobler's hiking function shape scaled so flat ground = flatSpeed; slowed by rock density.
export function walkSpeed(grade, rough, slopeDeg, o) {
  const tobler = Math.exp(-3.5 * Math.abs(grade + 0.05)) / Math.exp(-3.5 * 0.05);
  return o.flatSpeed * tobler * (1 - 0.45 * rough);
}
// Pressurized rover: fast on smooth flat ground, slows sharply with slope and rocks.
export function roverSpeed(grade, rough, slopeDeg, o) {
  const s = Math.max(0, 1 - Math.pow(slopeDeg / o.roverMaxSlope, 2));
  return Math.max(0.3, o.roverSpeed * s * (1 - 0.8 * rough));
}
export function profileFor(mode, o) {
  return mode === "drive"
    ? { speed: (g, r, s) => roverSpeed(g, r, s, o), maxSlope: o.roverMaxSlope, maxRough: o.roverMaxRough, vmax: o.roverSpeed, risk: o.risk }
    : { speed: (g, r, s) => walkSpeed(g, r, s, o), maxSlope: o.maxSlope, maxRough: null, vmax: o.flatSpeed * 1.2, risk: o.risk };
}

export function passable(site, k, prof) {
  return !site.nogo[k] && site.slope[k] <= prof.maxSlope && (prof.maxRough == null || site.rough[k] <= prof.maxRough);
}
export function nearestPassable(site, idx, prof, maxR = 60) {
  if (passable(site, idx, prof)) return idx;
  const i0 = idx % site.nx, j0 = (idx / site.nx) | 0;
  for (let r = 1; r <= maxR; r++) {
    let best = -1, bd = 1e9;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const i = i0 + di, j = j0 + dj;
      if (i < 0 || j < 0 || i >= site.nx || j >= site.ny) continue;
      const k = j * site.nx + i, d = di * di + dj * dj;
      if (passable(site, k, prof) && d < bd) { bd = d; best = k; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

class Heap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(key, pri) {
    const k = this.k, p = this.p; let i = k.length; k.push(key); p.push(pri);
    while (i > 0) { const q = (i - 1) >> 1; if (p[q] <= pri) break; k[i] = k[q]; p[i] = p[q]; i = q; }
    k[i] = key; p[i] = pri;
  }
  pop() {
    const k = this.k, p = this.p, top = k[0], lk = k.pop(), lp = p.pop(), n = k.length;
    if (n) {
      let i = 0;
      while (true) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && p[c + 1] < p[c]) c++;
        if (p[c] >= lp) break;
        k[i] = k[c]; p[i] = p[c]; i = c;
      }
      k[i] = lk; p[i] = lp;
    }
    return top;
  }
}

const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 1], [1, 2], [-2, 1], [-1, 2], [2, -1], [1, -2], [-2, -1], [-1, -2]];

// A* minimising travel time inflated by risk. Returns { cells } or { error }.
export function findPath(site, from, to, prof) {
  const { nx, ny } = site;
  const start = nearestPassable(site, cellOf(site, ...from), prof);
  const goal = nearestPassable(site, cellOf(site, ...to), prof);
  if (start < 0) return { error: "start" };
  if (goal < 0) return { error: "goal" };
  const cw = site.cell_m, N = nx * ny;
  const g = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const gi = goal % nx, gj = (goal / nx) | 0;
  const vmax = prof.vmax / 3.6;
  const h = (k) => Math.hypot((k % nx) - gi, ((k / nx) | 0) - gj) * cw / vmax;
  const heap = new Heap();
  g[start] = 0; heap.push(start, h(start));
  let found = start === goal;
  while (heap.size) {
    const c = heap.pop();
    if (c === goal) { found = true; break; }
    if (closed[c]) continue;
    closed[c] = 1;
    const ci = c % nx, cj = (c / nx) | 0;
    for (const [di, dj] of NB) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const k = j * nx + i;
      if (closed[k] || !passable(site, k, prof)) continue;
      if (Math.abs(di) + Math.abs(dj) === 3) {
        const mi = ci + (Math.abs(di) === 2 ? Math.sign(di) : 0), mj = cj + (Math.abs(dj) === 2 ? Math.sign(dj) : 0);
        if (!passable(site, mj * nx + mi, prof)) continue;
      }
      const d = Math.hypot(di, dj) * cw;
      const grade = (site.elev[k] - site.elev[c]) / d;
      const v = prof.speed(grade, (site.rough[k] + site.rough[c]) / 2, site.slope[k]) / 3.6;
      const ng = g[c] + (d / Math.max(v, 0.05)) * (1 + prof.risk * site.hazard[k] * 2);
      if (ng < g[k]) { g[k] = ng; came[k] = c; heap.push(k, ng + h(k)); }
    }
  }
  if (!found) return { error: "blocked" };
  const cells = [];
  for (let k = goal; k !== -1; k = came[k]) { cells.push(k); if (k === start) break; }
  cells.reverse();
  return { cells };
}

// Douglas–Peucker (metres tolerance), keeps endpoints.
export function simplify(pts, tolM) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const xy = pts.map((p) => [p[1] * MARS_R * DEG * Math.cos(p[0] * DEG), p[0] * MARS_R * DEG]);
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = -1, mi = -1;
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const L = Math.hypot(bx - ax, by - ay) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - xy[i][1]) - (ax - xy[i][0]) * (by - ay)) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tolM) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Terrain horizon in 16 directions around a point (degrees above the horizontal).
export function horizons(site, lat, lon, eyeH = 1.8, maxM = 600) {
  const z0 = (elevAt(site, lat, lon) ?? 0) + eyeH;
  const out = new Float32Array(16);
  for (let a = 0; a < 16; a++) {
    const br = (a * 22.5) * DEG, s = Math.sin(br), c = Math.cos(br);
    let best = -90;
    for (let d = site.cell_m; d <= maxM; d += d < 80 ? site.cell_m : 16) {
      const e = elevAt(site, lat + (c * d) / site.mPerDegLat, lon + (s * d) / site.mPerDegLon);
      if (e == null) break;
      const ang = Math.atan2(e - z0, d) / DEG;
      if (ang > best) best = ang;
    }
    out[a] = best;
  }
  return out;
}
// fraction of the sky dome left open by surrounding terrain (1 = fully open plain)
export function skyOpen(hz) {
  let s = 0;
  for (const h of hz) s += 1 - Math.sin(Math.max(0, h) * DEG);
  return s / hz.length;
}
export function horizonToward(hz, azDeg) {
  const x = (((azDeg % 360) + 360) % 360) / 22.5, i = Math.floor(x) % 16, f = x - Math.floor(x);
  return hz[i] * (1 - f) + hz[(i + 1) % 16] * f;
}
