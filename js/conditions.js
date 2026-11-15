// Conditions that matter outside, beyond the terrain itself:
//  - radio line of sight from the crew to the base antenna (where the link can drop: guidance carries on offline)
//  - a rough radiation dose for the walk, from Curiosity's measured surface dose rate
//  - dust-storm season, from the Mars season (solar longitude Ls)
//  - space weather: solar storms (CMEs) predicted to reach Mars, from NASA's DONKI service
import { elevAt } from "./planner.js";

const R_MARS = 3389500;          // m
export const BASE_ANT_M = 5;     // base / lander antenna mast height (assumption)
export const SUIT_ANT_M = 2;     // antenna on the suit backpack (assumption)

// Is there a straight radio path from A (base antenna) to B (suit antenna) over the terrain grid?
// Terrain along the path is raised by the planet's curvature (d1·d2 / 2R) before comparing.
export function lineOfSight(site, a, b, hA = BASE_ANT_M, hB = SUIT_ANT_M) {
  const zA = (elevAt(site, a.lat, a.lon) ?? 0) + hA, zB = (elevAt(site, b.lat, b.lon) ?? 0) + hB;
  const dLat = (b.lat - a.lat) * site.mPerDegLat, dLon = (b.lon - a.lon) * site.mPerDegLon, D = Math.hypot(dLat, dLon);
  if (D < site.cell_m * 2) return true;
  const n = Math.min(400, Math.ceil(D / site.cell_m));
  for (let k = 1; k < n; k++) {
    const f = k / n, e = elevAt(site, a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f);
    if (e == null) continue;
    const d1 = f * D, bulge = (d1 * (D - d1)) / (2 * R_MARS);
    if (e + bulge > zA + (zB - zA) * f) return false;
  }
  return true;
}

// Line of sight at every route sample (from the route start, where the base is), plus the shadowed stretches
export function commsAlongRoute(site, samples, base) {
  const los = samples.map((s) => lineOfSight(site, base, s));
  const runs = [];
  for (let k = 0; k < los.length; k++) {
    if (los[k]) continue;
    let j = k; while (j + 1 < los.length && !los[j + 1]) j++;
    runs.push({ from: samples[k].d, to: samples[j].d, len: Math.max(samples[j].d - samples[k].d, 1) });
    k = j;
  }
  const frac = los.filter(Boolean).length / los.length;
  return { los, runs, frac, longest: runs.reduce((m, r) => (r.len > m.len ? r : m), { len: 0 }) };
}

// Radiation: Curiosity's RAD measured about 0.64 mSv per day (dose equivalent) on the surface in Gale crater
// (Hassler et al. 2014, Science 343). Terrain that hides part of the sky blocks that share of the particles,
// so the walk's dose is scaled by the average open sky. A rough, first-order estimate.
export const RAD_USV_PER_DAY = 640;
export const walkDoseUSv = (seconds, skyAvg) => (RAD_USV_PER_DAY * seconds) / 86400 * skyAvg;

// Dust: regional storms cluster in southern spring and summer, and every recorded global storm began
// between Ls 180° and 330°.
export const dustSeason = (Ls) => Ls >= 180 && Ls <= 330;

// Space weather from NASA DONKI (WSA-ENLIL CME model runs that list Mars as an impact location).
// Kept in localStorage so the last answer is still there offline; fetched at most every 3 hours.
const SW_KEY = "aresnav.spaceweather", SW_MAX_AGE = 3 * 3600e3;
const ymd = (d) => d.toISOString().slice(0, 10);
export function cachedSpaceWeather() { try { return JSON.parse(localStorage.getItem(SW_KEY)); } catch { return null; } }
let inflight = null;
const FAIL_KEY = "aresnav.spaceweather.fail", RETRY_AFTER = 15 * 60e3;   // NASA's DEMO_KEY allows ~10 requests an hour per address
export function marsSpaceWeather({ force = false } = {}) {
  const cached = cachedSpaceWeather();
  if (!force && cached && Date.now() - cached.fetched < SW_MAX_AGE) return Promise.resolve(cached);
  if (!navigator.onLine) return Promise.resolve(cached ? { ...cached, stale: true } : { error: "offline" });
  let lastFail = 0; try { lastFail = +localStorage.getItem(FAIL_KEY) || 0; } catch {}
  if (!force && Date.now() - lastFail < RETRY_AFTER) return Promise.resolve(cached ? { ...cached, stale: true } : { error: "busy" });
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const end = new Date(Date.now() + 86400e3), start = new Date(Date.now() - 30 * 86400e3);
      const r = await fetch(`https://api.nasa.gov/DONKI/WSAEnlilSimulations?startDate=${ymd(start)}&endDate=${ymd(end)}&api_key=DEMO_KEY`);
      if (!r.ok) throw new Error(r.status === 429 ? "busy" : `DONKI ${r.status}`);
      const sims = await r.json(), seen = new Set(), impacts = [];
      for (const s of sims || []) for (const i of s.impactList || []) {
        if (!/mars/i.test(i.location || "") || !i.arrivalTime || seen.has(i.arrivalTime)) continue;
        seen.add(i.arrivalTime); impacts.push({ arrival: Date.parse(i.arrivalTime), glancing: !!i.isGlancingBlow, minor: !!i.isMinorImpact });
      }
      impacts.sort((a, b) => a.arrival - b.arrival);
      const out = { fetched: Date.now(), impacts };
      try { localStorage.setItem(SW_KEY, JSON.stringify(out)); localStorage.removeItem(FAIL_KEY); } catch {}
      return out;
    } catch (e) {
      try { localStorage.setItem(FAIL_KEY, String(Date.now())); } catch {}
      return cached ? { ...cached, stale: true } : { error: /busy/.test(e.message) ? "busy" : /fetch|network/i.test(e.message) ? "offline" : e.message };
    } finally { inflight = null; }
  })();
  return inflight;
}
// The storm that matters now: arriving in the next 3 days, or arrived within the last 36 hours
export function stormNow(sw, now = Date.now()) {
  if (!sw?.impacts) return null;
  return sw.impacts.find((i) => i.arrival > now - 36 * 3600e3 && i.arrival < now + 72 * 3600e3) || null;
}
