// Planning defaults (editable in Settings) and the example route offered on first open.

export const DEFAULTS = {
  // crew on foot
  flatSpeed: 2.6,      // km/h suited walking on flat ground (planning assumption)
  maxSlope: 25,        // deg; never route the crew over steeper ground
  plssHours: 8.0,      // portable life-support duration
  reserveHours: 1.0,   // kept untouched for contingencies
  loadKg: 10,          // tools and samples carried on top of the suit (sets how hard the walk is)
  risk: 1.0,           // 0 = fastest, 3 = keep furthest from steep/rocky ground
  startLMST: "09:00",  // EVA start, local mean solar time at Gale
  checkpointMin: 15,   // default time spent at a checkpoint
  // pressurized rover
  roverSpeed: 8,       // km/h on smooth flat ground
  roverMaxSlope: 15,   // deg
  roverMaxRough: 0.6,  // rock-density cut-off (0..1)
};

// Example: from an open plain north of the boxwork, up to the boxwork ridges of lower Mount Sharp.
export const EXAMPLE = {
  start: { lat: -4.7925, lon: 137.3905, name: "Landing plain" },
  end: { lat: -4.8450, lon: 137.3850, name: "Upper boxwork ridges" },
};

// Places the voice assistant knows by name (informal names used in this app). Crew can add their own
// by voice ("save this spot as Camp") and those are kept in the browser.
export const PLACES = [
  { name: EXAMPLE.start.name, lat: EXAMPLE.start.lat, lon: EXAMPLE.start.lon, aliases: ["landing plain", "the plain", "plain", "landing site"] },
  { name: EXAMPLE.end.name, lat: EXAMPLE.end.lat, lon: EXAMPLE.end.lon, aliases: ["upper boxwork ridges", "upper boxwork", "boxwork ridges", "boxwork", "the ridges"] },
];

// Sites to jump to: centres of NASA Mars Trek bookmarks and of the HiRISE elevation models there.
// "area" points are box centres, not exact landing coordinates.
export const SITES = [
  { name: "Gale crater (Curiosity)", lat: -4.587, lon: 137.426, zoom: 10, aliases: ["gale", "gale crater", "curiosity", "mount sharp", "aeolis mons"] },
  { name: "Jezero crater (Perseverance)", lat: 18.465, lon: 77.396, zoom: 12, aliases: ["jezero", "jezero crater", "perseverance", "mars 2020"] },
  { name: "Columbia Hills (Spirit)", lat: -14.589, lon: 175.502, zoom: 12, aliases: ["columbia hills", "spirit", "gusev", "gusev crater"] },
  { name: "Endeavour crater (Opportunity)", lat: -2.307, lon: -5.379, zoom: 11, aliases: ["endeavour", "endeavour crater", "opportunity", "meridiani", "meridiani planum"] },
  { name: "Victoria crater (Opportunity)", lat: -2.054, lon: -5.5, zoom: 14, aliases: ["victoria", "victoria crater"] },
  { name: "InSight landing area", lat: 4.537, lon: 135.849, zoom: 9, aliases: ["insight", "elysium planitia"] },
  { name: "Phoenix landing area", lat: 68.208, lon: -125.773, zoom: 11, aliases: ["phoenix", "green valley", "vastitas borealis"] },
  // well-known landmarks and other landers (approximate centres; terrain here is the global 200 m blend unless outlined)
  { name: "Mars Pathfinder (Sojourner)", lat: 19.13, lon: -33.22, zoom: 11, aliases: ["pathfinder", "mars pathfinder", "sojourner", "ares vallis"] },
  { name: "Viking 1 landing site", lat: 22.27, lon: -47.95, zoom: 10, aliases: ["viking 1", "viking one", "chryse planitia"] },
  { name: "Viking 2 landing site", lat: 47.64, lon: 134.29, zoom: 10, aliases: ["viking 2", "viking two"] },
  { name: "Zhurong (Tianwen-1)", lat: 25.07, lon: 109.93, zoom: 10, aliases: ["zhurong", "tianwen", "tianwen 1"] },
  { name: "Olympus Mons", lat: 18.65, lon: -133.8, zoom: 6, aliases: ["olympus mons", "olympus"] },
  { name: "Valles Marineris", lat: -13.9, lon: -59.2, zoom: 5, aliases: ["valles marineris", "mariner valley"] },
  { name: "Hellas Planitia", lat: -42.4, lon: 70.5, zoom: 5, aliases: ["hellas", "hellas planitia", "hellas basin"] },
  { name: "Elysium Mons", lat: 25.02, lon: 147.21, zoom: 7, aliases: ["elysium mons"] },
  { name: "Arsia Mons", lat: -8.26, lon: -120.09, zoom: 7, aliases: ["arsia mons"] },
  { name: "Pavonis Mons", lat: 1.48, lon: -112.96, zoom: 7, aliases: ["pavonis mons"] },
  { name: "Ascraeus Mons", lat: 11.92, lon: -104.08, zoom: 7, aliases: ["ascraeus mons"] },
  { name: "Utopia Planitia", lat: 46.7, lon: 117.5, zoom: 5, aliases: ["utopia", "utopia planitia"] },
];

export const ABOUT_SITE =
  "Lower Mount Sharp in Gale crater, along the route NASA proposed for Curiosity's climb. The area includes the boxwork unit, a network of low ridges that formed where groundwater left minerals in fractures that later resisted erosion.";
