// Mars sun position and local time at Gale crater.
// Algorithm: Allison & McEwen (2000), Planet. Space Sci. 48, 215 (as used by NASA GISS Mars24).
// Pure astronomy: no external data.

const D = Math.PI / 180;
export const GALE = { lat: -4.8, lonE: 137.39 };

function core(date) {
  const jdUT = date.getTime() / 864e5 + 2440587.5;
  const jdTT = jdUT + 69.184 / 86400;
  const dt = jdTT - 2451545.0;
  const M = (19.3871 + 0.52402073 * dt) * D;
  const aFMS = 270.3871 + 0.524038496 * dt;
  const pbs = [[0.0071, 2.2353, 49.409], [0.0057, 2.7543, 168.173], [0.0039, 1.1177, 191.837], [0.0037, 15.7866, 21.736],
    [0.0021, 2.1354, 15.704], [0.002, 2.4694, 95.528], [0.0018, 32.8493, 49.095]]
    .reduce((s, [A, tau, phi]) => s + A * Math.cos((0.985626 * dt / tau + phi) * D), 0);
  const nuM = (10.691 + 3e-7 * dt) * Math.sin(M) + 0.623 * Math.sin(2 * M) + 0.05 * Math.sin(3 * M) + 0.005 * Math.sin(4 * M) + 0.0005 * Math.sin(5 * M) + pbs;
  const Ls = (((aFMS + nuM) % 360) + 360) % 360;
  const eot = 2.861 * Math.sin(2 * Ls * D) - 0.071 * Math.sin(4 * Ls * D) + 0.002 * Math.sin(6 * Ls * D) - nuM; // degrees
  const dec = Math.asin(0.42565 * Math.sin(Ls * D)) / D + 0.25 * Math.sin(Ls * D);
  const msd = (jdTT - 2405522.0028779) / 1.0274912517;
  return { Ls, eot, dec, msd };
}

// Current sol number (Curiosity mission count) and LMST hours at Gale
export function marsClock(date = new Date()) {
  const { msd } = core(date);
  const local = msd + GALE.lonE / 360;
  return { sol: Math.floor(local - 49269), lmstH: (local % 1) * 24 };
}

// Sun elevation/azimuth (degrees, azimuth clockwise from north) at a given LMST (hours) on the sol of `date`.
export function sunAt(lmstH, date = new Date(), lat = GALE.lat) {
  const { eot, dec, Ls } = core(date);
  const ltst = lmstH + eot / 15;
  const H = (ltst - 12) * 15 * D;
  const phi = lat * D, d = dec * D;
  const el = Math.asin(Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(H));
  const az = Math.atan2(-Math.cos(d) * Math.sin(H), Math.sin(d) * Math.cos(phi) - Math.cos(d) * Math.sin(phi) * Math.cos(H));
  return { el: el / D, az: ((az / D) + 360) % 360, Ls };
}

// Sunrise / sunset LMST (hours) by scanning the sol
export function daylight(date = new Date()) {
  let rise = null, set = null, prev = sunAt(0, date).el;
  for (let m = 5; m <= 24 * 60; m += 5) {
    const e = sunAt(m / 60, date).el;
    if (prev < 0 && e >= 0 && rise == null) rise = m / 60;
    if (prev >= 0 && e < 0) set = m / 60;
    prev = e;
  }
  return { rise, set };
}

export function seasonName(Ls) {
  // Gale is in the southern hemisphere
  if (Ls < 90) return "southern autumn";
  if (Ls < 180) return "southern winter";
  if (Ls < 270) return "southern spring";
  return "southern summer";
}
