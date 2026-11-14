# Marswalk Navigator

**NASA Space Apps Challenge 2026.** A navigation app for crew on foot or in a pressurized rover on Mount Sharp, Gale crater. Pick a start and a destination; it plans the safest route and checks it for dangers, elevation, sunlight and radiation shielding. Then it guides you turn by turn on a map or in a helmet HUD.

## How to use

1. **Tap the map** to set your start, then tap again for your destination. Or press *Try an example route*.
2. Read the result: travel time, distance, arrival time (Mars local time) and a safety status. Expand it to see every check.
3. **Report** lists each danger (steep climbs, rocky ground, no-go edges, terrain shadow) with its location on the map, plus elevation, sky-view shielding and sunlight.
4. **Checkpoints are optional.** Once a route exists, tap the map and choose *Add checkpoint here*, or use *+ Add checkpoint*. Name it, set how long you'll stop, drag it to move it.
5. Switch between **Crew on foot** and **Rover**. Each has its own slope, rock and speed limits (Settings).
6. **Start** begins turn-by-turn guidance on a simulated position. **HUD** opens the helmet display with a 3D view of the terrain ahead. Keys: Space pauses, H toggles the HUD, Esc goes back.

## What it assesses

| Check | How |
|---|---|
| Route | A* over an 8 m grid. It minimises travel time plus a penalty near steep or rocky ground and never crosses no-go cells. |
| Slope & elevation | HiRISE Gale DEM (Mars Trek), slope over a ~70 m baseline |
| Rocks & ridges | Texture energy of the HiRISE mosaic |
| Oxygen / walk-back | Time out + time to walk back vs. suit duration minus reserve, at every point |
| Daylight & shadow | Sun position (Mars24 algorithm) vs. the terrain horizon at the time you pass each point |
| Radiation shielding | Share of the sky not blocked by terrain (sky-view factor from the DEM), plus the most sheltered spot near the route. Relative only: no dose data is used. |

## Data (NASA Mars Trek only)

- MRO HiRISE mosaic of Curiosity's roving site and the HiRISE Gale crater DEM: processed into `data/` by `tools/build_site_data.py`.
- Map layers: HiRISE, CTX, Viking, MOLA, THEMIS day/night IR, TES thermal inertia, clay/glass and plagioclase.
- Site context: NASA's *Curiosity's proposed path up Mount Sharp*.

**Elevation scale.** Trek serves the DEM as 8-bit tiles. Heights use `metres = 17.97 × DN − 4569.2`, fitted once against Curiosity's published elevations (RMS 4.6 m). This is disclosed in the app's Data panel. Slopes, shadows and shielding don't depend on it.

## Run locally

```bash
python3 -m http.server 8000
```

Open http://localhost:8000.

## Rebuild the terrain data

```bash
python3 tools/build_site_data.py
```

Needs `numpy` and `Pillow`. Downloads about 460 Trek tiles (about 6 minutes).

## Deploy (GitHub Pages)

Push to a public GitHub repo. Then go to **Settings → Pages → Deploy from a branch → `main` / root**. There is no build step.

## Limits

Planning aid for a concept study. Features smaller than a few metres aren't in the slope grid. Position during navigation is simulated. Walking speed, suit duration and rover limits are adjustable assumptions.
