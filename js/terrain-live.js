// On-demand terrain analysis anywhere on Mars. Once start and destination are chosen, the app picks the
// sharpest elevation model NASA Mars Trek has for that ground (js/catalog.js) and builds the planning grid
// for a corridor around the route, in the browser:
//
//  elevation  : Trek ImageServer (float32 metres) or a regional DEM's 8-bit tiles with a fitted metre scale;
//               anywhere else the global MOLA + HRSC blend (~200 m/px)
//  slope      : from the grid after smoothing to a baseline that suits the source
//  rock density: HiRISE mosaic texture, where a HiRISE mosaic covers the ground (not assessed elsewhere)
//  no-go      : slope > 25°, rock density > 0.92, or no elevation data
//
// Trek serves tiles and ImageServers with CORS enabled, so no server of our own is needed.

import { MARS_R } from "./planner.js";
import { CATALOG } from "./catalog.js";

const DEG = Math.PI / 180;
const M_PER_DEG = MARS_R * DEG;
const ARC = "https://trek.nasa.gov/mars/trekarcgis/rest/services";
const TILE = (layer, fmt, z, y, x) => `https://trek.nasa.gov/tiles/Mars/EQ/${layer}/1.0.0/default/default028mm/${z}/${y}/${x}.${fmt}`;
const MAX_CELLS = 3.0e6;          // grid size cap; longer routes get coarser cells
const HIGH_RES_M = 30;            // cells at or below this count as "EVA-grade" terrain

export const inExtent = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && lat >= -88 && lat <= 88 && lon >= -180 && lon <= 180;
export const normLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

const inBox = (b, p, padDeg = 0) => p.lon >= b[0] + padDeg && p.lon <= b[2] - padDeg && p.lat >= b[1] + padDeg && p.lat <= b[3] - padDeg;
// candidate elevation sources for these points, sharpest first; the global blend always comes last
export function sourcesFor(points) {
  return [...CATALOG.dems.filter((d) => points.every((p) => inBox(d.bbox, p, 0.0005))), CATALOG.global];
}
export const sourceLabel = (src) => `${src.title} (${src.pxM < 10 ? src.pxM.toFixed(1) : Math.round(src.pxM)} m/px)`;

// corridor around the points, padded so detours fit, clipped to the source's coverage
export function corridorFor(points, src, padM = 700) {
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  for (const p of points) { w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat); }
  const latC = (s + n) / 2, mLon = M_PER_DEG * Math.cos(latC * DEG);
  const span = Math.max((e - w) * mLon, (n - s) * M_PER_DEG);
  const pad = Math.max(padM, src && src.pxM > HIGH_RES_M ? 10 * src.pxM : 0, 0.3 * span);
  const sb = src?.bbox || [-180, -90, 180, 90];
  return { west: Math.max(w - pad / mLon, sb[0]), east: Math.min(e + pad / mLon, sb[2]), south: Math.max(s - pad / M_PER_DEG, sb[1]), north: Math.min(n + pad / M_PER_DEG, sb[3]) };
}
export function covers(site, points, marginM = 150) {
  if (!site) return false;
  const b = site.bbox, mLat = marginM / M_PER_DEG, mLon = marginM / site.mPerDegLon;
  return points.every((p) => p.lon >= b.west + mLon && p.lon <= b.east - mLon && p.lat >= b.south + mLat && p.lat <= b.north - mLat);
}

// ---------- fetching ----------
async function exportImage(service, b, w, h, signal) {
  const q = new URLSearchParams({ bbox: `${b.west},${b.south},${b.east},${b.north}`, bboxSR: 104905, imageSR: 104905, size: `${w},${h}`, format: "bsq",
    pixelType: "F32", interpolation: "RSP_BilinearInterpolation", f: "image" });
  const r = await fetch(`${ARC}/${service}/ImageServer/exportImage?${q}`, { mode: "cors", signal });
  if (!r.ok) throw new Error(`elevation service ${r.status}`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength < w * h * 4) throw new Error("short elevation response");
  const val = new Float32Array(buf.slice(0, w * h * 4)), bits = new Uint8Array(buf, w * h * 4), ok = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) ok[k] = bits.length ? (bits[k >> 3] >> (7 - (k & 7))) & 1 : 1;
  return { val, ok };
}
async function fetchTile(layer, fmt, z, y, x, signal) {
  const r = await fetch(TILE(layer, fmt, z, y, x), { mode: "cors", signal });
  if (!r.ok) return null;
  const bmp = await createImageBitmap(await r.blob());
  const cv = new OffscreenCanvas(256, 256), cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0); bmp.close?.();
  const d = cx.getImageData(0, 0, 256, 256).data, g = new Float32Array(65536), v = new Uint8Array(65536);
  for (let i = 0; i < 65536; i++) { g[i] = d[i * 4]; v[i] = d[i * 4 + 3] > 0 ? 1 : 0; }
  return { g, v };
}
const gx = (lon, z) => ((lon + 180) / 360) * 2 ** (z + 1) * 256;
const gy = (lat, z) => ((90 - lat) / 180) * 2 ** z * 256;
const pxDeg = (z) => 180 / (2 ** z * 256);
function tileRange(b, z) {
  return { tx0: Math.floor(gx(b.west, z) / 256), tx1: Math.floor(gx(b.east, z) / 256), ty0: Math.floor(gy(b.north, z) / 256), ty1: Math.floor(gy(b.south, z) / 256) };
}
async function eachTile(layer, fmt, z, b, fn, tick, signal) {
  const { tx0, tx1, ty0, ty1 } = tileRange(b, z), jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([ty, tx]);
  let k = 0;
  const worker = async () => {
    while (k < jobs.length) {
      const [ty, tx] = jobs[k++];
      let t = null;
      for (let a = 0; a < 3; a++) { try { t = await fetchTile(layer, fmt, z, ty, tx, signal); break; } catch (e) { if (signal?.aborted) throw e; } }
      if (t) fn(t, ty, tx);
      tick?.();
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}
const tileCount = (b, z) => { const t = tileRange(b, z); return (t.tx1 - t.tx0 + 1) * (t.ty1 - t.ty0 + 1); };

// ---------- image ops (edge-padded) ----------
function boxBlur(a, W, H, r) {
  if (r <= 0) return a;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H), k = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    const o = y * W; let s = 0;
    for (let i = -r; i <= r; i++) s += a[o + Math.min(W - 1, Math.max(0, i))];
    for (let x = 0; x < W; x++) { tmp[o + x] = s / k; s += a[o + Math.min(W - 1, x + r + 1)] - a[o + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[Math.min(H - 1, Math.max(0, i)) * W + x];
    for (let y = 0; y < H; y++) { out[y * W + x] = s / k; s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x]; }
  }
  return out;
}
function gradMag(a, W, H) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const dx = x === 0 ? a[i + 1] - a[i] : x === W - 1 ? a[i] - a[i - 1] : (a[i + 1] - a[i - 1]) / 2;
    const dy = y === 0 ? a[i + W] - a[i] : y === H - 1 ? a[i] - a[i - W] : (a[i + W] - a[i - W]) / 2;
    out[i] = Math.hypot(dx, dy);
  }
  return out;
}
function texture(g) {   // 256x256 tile -> 0.6*edge + 0.4*local sd (same as tools/build_catalog.py)
  const b = boxBlur(g, 256, 256, 1), edge = boxBlur(gradMag(b, 256, 256), 256, 256, 2);
  const m = boxBlur(g, 256, 256, 2), sq = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) sq[i] = g[i] * g[i];
  const m2 = boxBlur(sq, 256, 256, 2), out = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) out[i] = 0.6 * edge[i] + 0.4 * Math.sqrt(Math.max(0, m2[i] - m[i] * m[i]));
  return out;
}
function bilinear(arr, W, H, X, Y) {
  const xi = Math.min(W - 2, Math.max(0, Math.floor(X))), yi = Math.min(H - 2, Math.max(0, Math.floor(Y)));
  const fx = X - xi, fy = Y - yi, k = yi * W + xi;
  return arr[k] * (1 - fx) * (1 - fy) + arr[k + 1] * fx * (1 - fy) + arr[k + W] * (1 - fx) * fy + arr[k + W + 1] * fx * fy;
}
// fill no-data cells with the mean of valid neighbours so smoothing doesn't drag edges (cells stay no-go)
function fillGaps(v, ok, W, H) {
  let mean = 0, c = 0; for (let k = 0; k < W * H; k++) if (ok[k]) { mean += v[k]; c++; }
  mean = c ? mean / c : 0;
  for (let k = 0; k < W * H; k++) if (!ok[k] || !Number.isFinite(v[k])) v[k] = mean;
}

// ---------- build ----------
// Returns a site with the same fields as planner.loadSite(), plus source info and overlay images.
export async function buildSite(b, src, { progress, signal, baselineM, maxCells = MAX_CELLS, minCell = 8 } = {}) {
  const latC = (b.north + b.south) / 2, mLon = M_PER_DEG * Math.cos(latC * DEG);
  const wM = (b.east - b.west) * mLon, hM = (b.north - b.south) * M_PER_DEG;
  let cell = Math.max(minCell, Math.round(src.pxM));
  cell = Math.max(cell, Math.ceil(Math.sqrt((wM * hM) / maxCells)));
  const nx = Math.max(8, Math.round(wM / cell)), ny = Math.max(8, Math.round(hM / cell)), n = nx * ny;
  const dLon = (b.east - b.west) / nx, dLat = (b.north - b.south) / ny;
  const cellX = wM / nx, cellY = hM / ny;
  const lonOf = (i) => b.west + (i + 0.5) * dLon, latOf = (j) => b.north - (j + 0.5) * dLat;
  const mos = cell <= HIGH_RES_M ? CATALOG.mosaics.filter((m) => m.rock && m.bbox[0] < b.east && m.bbox[2] > b.west && m.bbox[1] < b.north && m.bbox[3] > b.south)
    .sort((p, q) => q.zmax - p.zmax)[0] : null;
  const demZ = src.kind === "tiles" ? Math.max(3, Math.min(src.zmax, Math.round(Math.log2(180 / ((cell / 2 / M_PER_DEG) * 256))))) : 0;
  let total = (src.kind === "tiles" ? tileCount(b, demZ) : 1) + (mos ? tileCount(b, mos.rock.z) : 0), done = 0;
  if (mos && tileCount(b, mos.rock.z) > 900) total -= tileCount(b, mos.rock.z);   // too large an area for imagery
  const useMos = mos && tileCount(b, mos.rock.z) <= 900;
  const tick = () => progress?.(++done, total);

  // 1) elevation on the grid
  const elev = new Float32Array(n), ok = new Uint8Array(n);
  if (src.kind === "image") {
    // ImageServer limit is 15000 x 4100 per request: split into horizontal bands
    for (let j0 = 0; j0 < ny; j0 += 4000) {
      const h = Math.min(4000, ny - j0), bb = { west: b.west, east: b.east, north: b.north - j0 * dLat, south: b.north - (j0 + h) * dLat };
      const r = await exportImage(src.service, bb, nx, h, signal);
      elev.set(r.val, j0 * nx); ok.set(r.ok, j0 * nx);
    }
    for (let k = 0; k < n; k++) if (!Number.isFinite(elev[k]) || elev[k] < -9000 || elev[k] > 25000) ok[k] = 0;
    tick();
  } else {
    const tr = tileRange(b, demZ), DW = (tr.tx1 - tr.tx0 + 1) * 256, DH = (tr.ty1 - tr.ty0 + 1) * 256;
    const dem = new Float32Array(DW * DH), dval = new Float32Array(DW * DH);
    await eachTile(src.layer, src.fmt, demZ, b, (t, ty, tx) => {
      const ox = (tx - tr.tx0) * 256, oy = (ty - tr.ty0) * 256;
      for (let y = 0; y < 256; y++) { const o = (oy + y) * DW + ox; dem.set(t.g.subarray(y * 256, y * 256 + 256), o); for (let x = 0; x < 256; x++) dval[o + x] = t.v[y * 256 + x]; }
    }, tick, signal);
    const ox0 = tr.tx0 * 256, oy0 = tr.ty0 * 256;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const X = gx(lonOf(i), demZ) - ox0 - 0.5, Y = gy(latOf(j), demZ) - oy0 - 0.5, k = j * nx + i;
      elev[k] = src.a * bilinear(dem, DW, DH, X, Y) + src.b;
      ok[k] = bilinear(dval, DW, DH, X, Y) > 0.99 ? 1 : 0;
    }
  }
  let valid = 0; for (let k = 0; k < n; k++) valid += ok[k];
  if (!valid) throw new Error("no elevation data here");
  fillGaps(elev, ok, nx, ny);

  // 2) slope over a baseline that suits the source: 8-bit tiles step in |a| metres, so they need a long one
  const base = baselineM ?? (src.kind === "tiles" ? Math.max(70, 4 * Math.abs(src.a)) : Math.max(3 * cell, 32));
  const r = Math.max(0, Math.round((base / cell - 1) / 2));
  const es = boxBlur(boxBlur(elev, nx, ny, r), nx, ny, Math.max(0, r - 1));
  const slope = new Float32Array(n);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    const ex = i === 0 ? (es[k + 1] - es[k]) / cellX : i === nx - 1 ? (es[k] - es[k - 1]) / cellX : (es[k + 1] - es[k - 1]) / (2 * cellX);
    const ey = j === 0 ? (es[k + nx] - es[k]) / cellY : j === ny - 1 ? (es[k] - es[k - nx]) / cellY : (es[k + nx] - es[k - nx]) / (2 * cellY);
    slope[k] = Math.atan(Math.hypot(ex, ey)) / DEG;
  }

  // 3) rock density from HiRISE texture, averaged into the cells each pixel falls in
  const rough = new Float32Array(n), roughOk = new Uint8Array(n);
  if (useMos) {
    const sum = new Float32Array(n), cnt = new Uint16Array(n), z = mos.rock.z, ipx = pxDeg(z);
    await eachTile(mos.layer, mos.fmt, z, b, (t, ty, tx) => {
      let any = 0; for (let p = 0; p < 65536; p += 97) any |= t.v[p]; if (!any) return;
      const tex = texture(t.g);
      for (let y = 0; y < 256; y++) {
        const lat = 90 - (ty * 256 + y + 0.5) * ipx, j = Math.floor((b.north - lat) / dLat);
        if (j < 0 || j >= ny) continue;
        for (let x = 0; x < 256; x++) {
          const p = y * 256 + x; if (!t.v[p]) continue;
          const lon = (tx * 256 + x + 0.5) * ipx - 180, i = Math.floor((lon - b.west) / dLon);   // EQ grid: 2^(z+1) tiles across 360°
          if (i < 0 || i >= nx) continue;
          sum[j * nx + i] += tex[p]; cnt[j * nx + i]++;
        }
      }
    }, tick, signal);
    const { lo, hi } = mos.rock;
    for (let k = 0; k < n; k++) if (cnt[k] >= 2) { rough[k] = Math.min(1, Math.max(0, (sum[k] / cnt[k] - lo) / (hi - lo))); roughOk[k] = 1; }
  }

  // 4) hazard and no-go (same formula as build_site_data.py and planner.loadSite)
  const hazard = new Float32Array(n), nogo = new Uint8Array(n);
  let rockCells = 0;
  for (let k = 0; k < n; k++) {
    rockCells += roughOk[k];
    nogo[k] = !ok[k] || slope[k] > 25 || rough[k] > 0.92 ? 1 : 0;
    hazard[k] = nogo[k] ? 1 : Math.min(1, 0.65 * Math.pow(Math.min(slope[k] / 25, 1), 1.5) + 0.35 * rough[k] * rough[k]);
  }
  const site = {
    name: src.title, live: true,
    bbox: { west: b.west, east: b.east, south: b.south, north: b.north }, nx, ny, cell_m: Math.round((cellX + cellY) / 2),
    elev, slope, rough, nogo, hazard, dLon, dLat, mPerDegLat: M_PER_DEG, mPerDegLon: mLon,
    noDataFrac: 1 - valid / n, valid: ok,
    source: { id: src.id, title: src.title, instrument: src.instrument || "", kind: src.kind, pxM: src.pxM, fit: src.fit || null, baselineM: Math.round(base) },
    rock: useMos ? { mosaic: mos.title, coverage: rockCells / n } : null,
    lowRes: cell > HIGH_RES_M,
  };
  site.overlays = overlays(site);
  return site;
}
export const hasData = (site, k) => !site.valid || site.valid[k] === 1;

// ---------- overlay images (same colour ramps as the prebuilt PNGs) ----------
function ramp(v, stops) {
  let a = stops[0], c = stops[stops.length - 1];
  for (let s = 1; s < stops.length; s++) if (v <= stops[s][0]) { a = stops[s - 1]; c = stops[s]; break; }
  const f = c[0] > a[0] ? Math.min(1, Math.max(0, (v - a[0]) / (c[0] - a[0]))) : 0;
  return a[1].map((x, i) => x + (c[1][i] - x) * f);
}
function paint(site, val, stops) {
  const { nx, ny } = site, cv = document.createElement("canvas");
  cv.width = nx; cv.height = ny;
  const cx = cv.getContext("2d"), im = cx.createImageData(nx, ny);
  for (let k = 0; k < nx * ny; k++) { const c = ramp(val(k), stops); im.data.set(c.map(Math.round), k * 4); }
  cx.putImageData(im, 0, 0);
  return cv.toDataURL("image/png");
}
function overlays(site) {
  return {
    slope: paint(site, (k) => Math.min(1, site.slope[k] / 30), [[0, [40, 200, 120, 0]], [0.2, [60, 210, 120, 90]], [0.45, [250, 220, 60, 150]], [0.7, [250, 120, 40, 190]], [1, [230, 30, 60, 220]]]),
    rough: paint(site, (k) => site.rough[k], [[0, [0, 180, 255, 0]], [0.5, [0, 180, 255, 40]], [0.8, [190, 80, 255, 150]], [1, [255, 40, 200, 220]]]),
    hazard: paint(site, (k) => site.hazard[k], [[0, [30, 220, 140, 0]], [0.3, [30, 220, 140, 0]], [0.5, [255, 210, 60, 110]], [0.75, [255, 120, 40, 170]], [1, [235, 30, 60, 210]]]),
  };
}
