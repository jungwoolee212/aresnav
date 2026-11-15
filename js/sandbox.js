// Rover-autonomy sandbox export: the analysed terrain as grids a path-planning or reinforcement-learning agent can
// load (elevation, slope, rock density, no-go), the rover limits, the route AresNav planned (a baseline), and, where it
// crosses this ground, the path Curiosity's drivers actually took (an expert demonstration). Planning-level only:
// cells are metres across, so this is for route choice, not camera-based hazard avoidance or wheel physics.
import { PLACES_DATA } from "./places.js";

const b64 = (typed) => { const u8 = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength); let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

export function sandboxExport(site, { track, profile, opts, mode }) {
  const n = site.nx * site.ny, slope = new Uint8Array(n), rough = new Uint8Array(n), nogo = new Uint8Array(n);
  for (let k = 0; k < n; k++) { slope[k] = Math.min(255, Math.round(site.slope[k])); rough[k] = Math.round(Math.min(1, Math.max(0, site.rough[k])) * 255); nogo[k] = site.nogo[k] ? 1 : 0; }
  const { west, east, south, north } = site.bbox, inBox = ([la, lo]) => la >= south && la <= north && lo >= west && lo <= east;
  const curiosity = [];
  for (const t of PLACES_DATA.traverses) if (/curiosity/i.test(t.name)) for (const part of t.parts) { const seg = part.filter(inBox); if (seg.length > 1) curiosity.push(seg); }
  return {
    format: "aresnav-terrain-sandbox/1",
    about: "Real Mars terrain from NASA Mars Trek, analysed by AresNav, for rover path-planning / reinforcement-learning research. Grids are row-major, row 0 = north edge, column 0 = west edge; cell (r, c) centre = (north - (r + 0.5) * dLat, west + (c + 0.5) * dLon). Planning-level resolution: not for camera-based hazard detection or wheel-soil physics.",
    license: "Code: MIT. Terrain derived from NASA Mars Trek data: HiRISE (NASA/JPL/University of Arizona, public domain), CTX (NASA/JPL/MSSS), MOLA (NASA/JPL/GSFC). Where the grid comes from the MOLA + HRSC blend or an HRSC model, it contains Mars Express HRSC data: ESA/DLR/FU Berlin, CC BY-SA 3.0 IGO (attribution and share-alike apply to derived data). Credit the sources.",
    source: site.source ? { title: site.source.title, metres_per_pixel: site.source.pxM } : { title: "MRO HiRISE Gale crater DEM (prebuilt)" },
    grid: { bbox: site.bbox, nx: site.nx, ny: site.ny, cell_m: site.cell_m, dLat: site.dLat, dLon: site.dLon },
    layers: {
      elevation_m: { dtype: "float32", data: b64(site.elev) },
      slope_deg: { dtype: "uint8", data: b64(slope) },
      rock_density_0_255: { dtype: "uint8", data: b64(rough), note: "HiRISE image texture where a HiRISE mosaic covers the ground, else 0" },
      no_go: { dtype: "uint8", data: b64(nogo), note: "1 = cliffs or ground the planner never enters" },
    },
    agent: { mode, max_slope_deg: mode === "drive" ? opts.roverMaxSlope : opts.maxSlope, max_rock_density: mode === "drive" ? opts.roverMaxRough : null,
      flat_speed_kmh: mode === "drive" ? opts.roverSpeed : opts.flatSpeed },
    baseline_route: track ? { planner: "A* (AresNav)", time_s: Math.round(track.total.time), dist_m: Math.round(track.total.dist), lat_lon: track.pts.map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)]) } : null,
    expert_demonstration: curiosity.length ? { name: "Curiosity traverse (NASA Trek)", note: "Path Curiosity's drivers took; line precise to ~30 m", parts: curiosity } : null,
  };
}
