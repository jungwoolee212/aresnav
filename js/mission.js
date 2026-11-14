// Planning defaults (editable in Settings) and the example route offered on first open.

export const DEFAULTS = {
  // crew on foot
  flatSpeed: 2.6,      // km/h suited walking on flat ground (planning assumption)
  maxSlope: 25,        // deg; never route the crew over steeper ground
  plssHours: 8.0,      // portable life-support duration
  reserveHours: 1.0,   // kept untouched for contingencies
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

export const ABOUT_SITE =
  "Lower Mount Sharp in Gale crater, along the route NASA proposed for Curiosity's climb. The area includes the boxwork unit, a network of low ridges that formed where groundwater left minerals in fractures that later resisted erosion.";
