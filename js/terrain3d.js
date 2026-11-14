// Synthetic-vision view (like an aircraft SVS display): renders the HiRISE-derived terrain
// ahead of the astronaut in perspective, tints hazards and draws the route ribbon + station pins.

import { sampleAt, elevAt } from "./planner.js";

const ROWS = 48, COLS = 36, NEAR = 1.5, FAR = 450;

export function renderTerrainView(cv, site, view) {
  // view: { lat, lon, heading, eyeH, route:[{lat,lon,dist}], dist, pins:[{lat,lon,label,hi}] }
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  const horizon = H * 0.42;
  const focal = W * 0.62;
  const h = (view.heading * Math.PI) / 180;
  const fx = Math.sin(h), fy = Math.cos(h);     // forward (east, north)
  const rx = Math.cos(h), ry = -Math.sin(h);    // right
  const ground0 = elevAt(site, view.lat, view.lon) ?? 0;
  const eye = ground0 + view.eyeH;

  const toLatLon = (x, y) => [view.lat + y / site.mPerDegLat, view.lon + x / site.mPerDegLon];
  const project = (z, x, elev) => [W / 2 + (x / z) * focal, horizon - ((elev - eye) / z) * focal];

  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, "#3b2a22"); sky.addColorStop(0.7, "#9b6b4a"); sky.addColorStop(1, "#d7a27a");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgb(150,92,60)"; ctx.fillRect(0, horizon, W, H - horizon); // ground nearer than the first grid row

  // sample a camera-aligned grid, far rows denser in depth
  const zs = [], grid = [];
  for (let k = 0; k <= ROWS; k++) zs.push(NEAR * Math.pow(FAR / NEAR, k / ROWS));
  for (let k = 0; k <= ROWS; k++) {
    const z = zs[k], half = z * 0.95, row = [];
    for (let j = 0; j <= COLS; j++) {
      const x = -half + (2 * half * j) / COLS;
      const e = x * rx + z * fx, n = x * ry + z * fy;
      const [la, lo] = toLatLon(e, n);
      const s = sampleAt(site, la, lo);
      row.push({ z, x, s, elev: elevAt(site, la, lo) ?? ground0 });
    }
    grid.push(row);
  }
  // far → near (painter's algorithm)
  for (let k = ROWS - 1; k >= 0; k--) {
    const fog = 0.8 * Math.min(1, zs[k] / FAR) ** 1.4;
    for (let j = 0; j < COLS; j++) {
      const a = grid[k][j], b = grid[k][j + 1], c = grid[k + 1][j + 1], d = grid[k + 1][j];
      const pa = project(a.z, a.x, a.elev), pb = project(b.z, b.x, b.elev), pc = project(c.z, c.x, c.elev), pd = project(d.z, d.x, d.elev);
      // shading from local gradient (sun from the west-north-west)
      const dzx = (b.elev - a.elev) / Math.max(1e-3, b.x - a.x), dzz = (d.elev - a.elev) / Math.max(1e-3, d.z - a.z);
      let light = 0.62 - dzx * 0.9 * (rx > 0 ? -1 : 1) * 0.6 + dzz * 0.9;
      light = Math.max(0.25, Math.min(1.05, light));
      let r = 196 * light, g = 120 * light, bl = 78 * light;
      const s = a.s;
      if (s) {
        if (s.nogo) { r = r * 0.45 + 235 * 0.55; g = g * 0.45 + 40 * 0.55; bl = bl * 0.45 + 60 * 0.55; }
        else if (s.hazard > 0.5) { r = r * 0.6 + 250 * 0.4; g = g * 0.6 + 140 * 0.4; bl = bl * 0.6 + 40 * 0.4; }
      }
      r = r * (1 - fog) + 205 * fog; g = g * (1 - fog) + 150 * fog; bl = bl * (1 - fog) + 112 * fog;
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${bl | 0})`;
      ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.lineTo(pc[0], pc[1]); ctx.lineTo(pd[0], pd[1]); ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1; ctx.stroke(); // hide seams
    }
  }
  // grid lines for depth cue
  ctx.strokeStyle = "rgba(255,230,200,.10)"; ctx.lineWidth = 1;
  for (let k = 0; k <= ROWS; k += 4) {
    ctx.beginPath();
    grid[k].forEach((v, j) => { const p = project(v.z, v.x, v.elev); j ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
    ctx.stroke();
  }
  for (let j = 0; j <= COLS; j += 3) {
    ctx.beginPath();
    for (let k = 0; k <= ROWS; k++) { const v = grid[k][j], p = project(v.z, v.x, v.elev); k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }
    ctx.stroke();
  }

  // route ribbon ahead
  const toCam = (lat, lon) => {
    const e = (lon - view.lon) * site.mPerDegLon, n = (lat - view.lat) * site.mPerDegLat;
    return { z: e * fx + n * fy, x: e * rx + n * ry };
  };
  const ahead = view.route.filter((p, i) => p.dist >= view.dist - 1 && p.dist <= view.dist + FAR && i % 2 === 0);
  const HW = 0.9; // half-width of the ribbon on the ground, metres
  let prev = null, raw = null;
  const ZC = NEAR + 0.5;
  for (const p of ahead) {
    const c = toCam(p.lat, p.lon);
    c.e = (elevAt(site, p.lat, p.lon) ?? ground0) + 0.08;
    const last = raw; raw = c;
    if (c.z < ZC) { prev = null; continue; }
    if (!prev && last && last.z < ZC) { const f = (ZC - last.z) / (c.z - last.z); prev = { z: ZC, x: last.x + (c.x - last.x) * f, e: last.e + (c.e - last.e) * f }; }
    if (prev) {
      const dx = c.x - prev.x, dz = c.z - prev.z, L = Math.hypot(dx, dz) || 1, nx = (-dz / L) * HW, nz = (dx / L) * HW;
      const q = [project(prev.z + nz, prev.x + nx, prev.e), project(c.z + nz, c.x + nx, c.e), project(c.z - nz, c.x - nx, c.e), project(prev.z - nz, prev.x - nx, prev.e)];
      const a = Math.min(0.85, 0.22 + c.z / 80) * Math.max(0.3, 1 - c.z / FAR);
      ctx.fillStyle = `rgba(125,255,200,${a})`;
      ctx.beginPath(); ctx.moveTo(q[0][0], q[0][1]); for (let k = 1; k < 4; k++) ctx.lineTo(q[k][0], q[k][1]); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(125,255,200,.95)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(q[0][0], q[0][1]); ctx.lineTo(q[1][0], q[1][1]); ctx.moveTo(q[2][0], q[2][1]); ctx.lineTo(q[3][0], q[3][1]); ctx.stroke();
    }
    prev = c;
  }

  // station pins
  for (const pin of view.pins) {
    const c = toCam(pin.lat, pin.lon);
    if (c.z < 4 || c.z > 900 || Math.abs(c.x) > c.z * 1.1) continue;
    const base = elevAt(site, pin.lat, pin.lon) ?? ground0;
    const p0 = project(c.z, c.x, base), p1 = project(c.z, c.x, base + 6);
    const top = Math.min(p1[1], p0[1] - 40);
    ctx.strokeStyle = pin.hi ? "#fff" : "rgba(255,255,255,.7)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p0[0], top); ctx.stroke();
    ctx.font = `600 ${pin.hi ? 15 : 12}px JetBrains Mono, monospace`;
    const txt = `${pin.label} · ${Math.round(Math.hypot(c.x, c.z))} m`;
    const tw = ctx.measureText(txt).width + 12;
    ctx.fillStyle = pin.hi ? "rgba(232,116,59,.95)" : "rgba(13,15,19,.75)";
    ctx.fillRect(p0[0] - tw / 2, top - 24, tw, 22);
    ctx.fillStyle = pin.hi ? "#1b0d05" : "#fff";
    ctx.fillText(txt, p0[0] - tw / 2 + 6, top - 8);
  }
}
