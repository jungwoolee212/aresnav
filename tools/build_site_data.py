#!/usr/bin/env python3
"""
Build the terrain model for Marswalk Navigator from NASA Mars Trek tiles only.

Inputs (all from https://trek.nasa.gov/mars/ WMTS):
  * MRO HiRISE Curiosity roving-site mosaic   (curiosity_hirise_mosaic, used at ~1.3 m/px)
  * MRO HiRISE Gale crater DEM                (Gale_DEM_SMG_1m, 8-bit tiles)

The DEM tiles are 8-bit and Trek publishes no vertical scale for them. One linear
scale (metres per DN + offset) is applied; it was fitted once against published
rover elevations along Curiosity's traverse (RMS 4.6 m) and is fixed below.
No other dataset is downloaded.

Outputs (../data):
  site.json         grid metadata
  elev.bin          uint16 little-endian, (elevation + 5000 m) * 10   [ny * nx]
  terrain.bin       uint8 x3 interleaved: slope*4 (deg), rock density 0..255, no-go 0/1
  hazard.png, slope.png, rough.png   map overlays

Run:  python3 tools/build_site_data.py      (needs numpy + Pillow)
"""
import io, json, math, os, time, urllib.request
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data")
CACHE = os.path.join(ROOT, "tools", ".cache")
os.makedirs(OUT, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)

# Lower Mount Sharp around Curiosity's proposed path (boxwork unit, sulfate-bearing layers)
BBOX = dict(west=137.345, east=137.425, south=-4.865, north=-4.745)
MARS_R = 3389500.0
M_PER_DEG = math.pi * MARS_R / 180.0
CELL_M = 8.0

# DEM vertical scale: elevation_m = DEM_A * DN + DEM_B   (see module docstring)
DEM_A, DEM_B, DEM_RMS = 17.97, -4569.2, 4.6

TREK = "https://trek.nasa.gov/tiles/Mars/EQ/{layer}/1.0.0/default/default028mm/{z}/{y}/{x}.png"
UA = {"User-Agent": "marswalk-navigator-data-builder"}


def fetch(url, cache_name):
    path = os.path.join(CACHE, cache_name)
    if os.path.exists(path):
        b = open(path, "rb").read()
        return b or None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                data = r.read()
            open(path, "wb").write(data)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 404:
                open(path, "wb").write(b"")
                return None
            time.sleep(1 + attempt)
        except Exception:
            time.sleep(1 + attempt)
    raise RuntimeError("failed: " + url)


def global_px(lon, lat, z):
    return (lon + 180) / 360 * (2 ** (z + 1)) * 256, (90 - lat) / 180 * (2 ** z) * 256


def mosaic(layer, z):
    """Stitch Trek tiles covering BBOX at zoom z -> (gray float32, valid mask, x0px, y0px)."""
    x0, y0 = global_px(BBOX["west"], BBOX["north"], z)
    x1, y1 = global_px(BBOX["east"], BBOX["south"], z)
    tx0, ty0, tx1, ty1 = int(x0 // 256), int(y0 // 256), int(x1 // 256), int(y1 // 256)
    W, H = (tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256
    gray = np.zeros((H, W), np.float32)
    valid = np.zeros((H, W), bool)
    n = 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            b = fetch(TREK.format(layer=layer, z=z, y=ty, x=tx), f"{layer}_{z}_{ty}_{tx}.png")
            n += 1
            if b:
                im = np.asarray(Image.open(io.BytesIO(b)).convert("LA"))
                ys, xs = (ty - ty0) * 256, (tx - tx0) * 256
                gray[ys:ys + 256, xs:xs + 256] = im[..., 0]
                valid[ys:ys + 256, xs:xs + 256] = im[..., 1] > 0
    print(f"  {layer} z{z}: {n} tiles, {valid.mean() * 100:.0f}% valid")
    return gray, valid, tx0 * 256, ty0 * 256


def box_blur(a, r):
    if r <= 0:
        return a
    k = 2 * r + 1
    p = np.pad(a.astype(np.float64), r, mode="edge")
    c = np.cumsum(np.cumsum(p, 0), 1)
    c = np.pad(c, ((1, 0), (1, 0)))
    return ((c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)).astype(np.float32)


def grid_coords():
    lat_c = (BBOX["north"] + BBOX["south"]) / 2
    dlon = CELL_M / (M_PER_DEG * math.cos(math.radians(lat_c)))
    dlat = CELL_M / M_PER_DEG
    nx = int(round((BBOX["east"] - BBOX["west"]) / dlon))
    ny = int(round((BBOX["north"] - BBOX["south"]) / dlat))
    lons = BBOX["west"] + (np.arange(nx) + 0.5) * (BBOX["east"] - BBOX["west"]) / nx
    lats = BBOX["north"] - (np.arange(ny) + 0.5) * (BBOX["north"] - BBOX["south"]) / ny
    return nx, ny, lons, lats


def resample(arr, x0, y0, z, lons, lats):
    gx = (lons + 180) / 360 * (2 ** (z + 1)) * 256 - x0 - 0.5
    gy = (90 - lats) / 180 * (2 ** z) * 256 - y0 - 0.5
    X, Y = np.meshgrid(gx, gy)
    xi = np.clip(np.floor(X).astype(int), 0, arr.shape[1] - 2)
    yi = np.clip(np.floor(Y).astype(int), 0, arr.shape[0] - 2)
    fx, fy = (X - xi).astype(np.float32), (Y - yi).astype(np.float32)
    a = arr.astype(np.float32)
    return (a[yi, xi] * (1 - fx) * (1 - fy) + a[yi, xi + 1] * fx * (1 - fy)
            + a[yi + 1, xi] * (1 - fx) * fy + a[yi + 1, xi + 1] * fx * fy)


def colorize(v, stops):
    out = np.zeros(v.shape + (4,), np.float32)
    ts = [s[0] for s in stops]
    for c in range(4):
        out[..., c] = np.interp(v, ts, [s[1][c] for s in stops])
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def main():
    nx, ny, lons, lats = grid_coords()
    print(f"Grid {nx} x {ny} cells @ {CELL_M} m  ({nx * CELL_M / 1000:.1f} x {ny * CELL_M / 1000:.1f} km)")

    print("1/3 HiRISE DEM (z14) -> elevation + regional slope")
    DZ = 14
    dem, dvalid, dx0, dy0 = mosaic("Gale_DEM_SMG_1m", DZ)
    # 8-bit steps are ~18 m, so smooth to a ~70 m baseline before differentiating
    dem_s = box_blur(box_blur(dem, 14), 14)
    elev = DEM_A * resample(dem_s, dx0, dy0, DZ, lons, lats) + DEM_B
    gy, gx = np.gradient(elev, CELL_M)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    dem_ok = resample(dvalid.astype(np.float32), dx0, dy0, DZ, lons, lats) > 0.99
    print(f"  elev {elev.min():.0f}..{elev.max():.0f} m, slope p50 {np.percentile(slope, 50):.1f}° p99 {np.percentile(slope, 99):.1f}°")
    del dem, dem_s

    print("2/3 HiRISE imagery (z15) -> rock & ridge density")
    HZ = 15
    img, ivalid, hx0, hy0 = mosaic("curiosity_hirise_mosaic", HZ)
    gy2, gx2 = np.gradient(box_blur(img, 1))
    edge = box_blur(np.hypot(gx2, gy2), 3)
    del gy2, gx2
    m = box_blur(img, 3)
    sd = np.sqrt(np.maximum(box_blur(img * img, 3) - m * m, 0))
    tex = 0.6 * edge + 0.4 * sd
    del edge, sd, m
    rough_raw = resample(tex, hx0, hy0, HZ, lons, lats)
    img_ok = resample(ivalid.astype(np.float32), hx0, hy0, HZ, lons, lats) > 0.5
    del img, tex, ivalid
    ok = img_ok & dem_ok
    lo, hi = np.percentile(rough_raw[ok], [5, 99.5])
    rough = np.clip((rough_raw - lo) / (hi - lo), 0, 1)

    hz = np.clip(slope / 25.0, 0, 1) ** 1.5 * 0.65 + rough ** 2 * 0.35
    nogo = (slope > 25) | (rough > 0.92) | ~ok
    hz[nogo] = 1
    print(f"  no-go {nogo.mean() * 100:.1f}% of cells (incl. {(~ok).mean() * 100:.1f}% outside data coverage)")

    print("3/3 Writing outputs")
    np.round(np.clip((elev + 5000) * 10, 0, 65535)).astype("<u2").tofile(os.path.join(OUT, "elev.bin"))
    terr = np.stack([np.clip(slope * 4, 0, 255), rough * 255, nogo * 1.0], -1)
    np.round(terr).astype(np.uint8).tofile(os.path.join(OUT, "terrain.bin"))
    json.dump(dict(
        name="Lower Mount Sharp, Gale crater",
        bbox=BBOX, nx=nx, ny=ny, cell_m=CELL_M, elev_offset=-5000, elev_scale=0.1,
        dem_scale=dict(a=DEM_A, b=DEM_B, rms_m=DEM_RMS,
                       note="Trek's HiRISE DEM tiles are 8-bit; metres = a*DN + b, fitted once against published Curiosity traverse elevations."),
        sources=["MRO HiRISE Curiosity roving-site mosaic (NASA Mars Trek)", "MRO HiRISE Gale crater DEM (NASA Mars Trek)"],
        built=time.strftime("%Y-%m-%d"),
    ), open(os.path.join(OUT, "site.json"), "w"), indent=1)

    def save(im, name):
        im.resize((nx * 2, ny * 2), Image.BILINEAR).save(os.path.join(OUT, name), optimize=True)
    save(colorize(np.clip(slope / 30, 0, 1), [(0, (40, 200, 120, 0)), (0.2, (60, 210, 120, 90)),
         (0.45, (250, 220, 60, 150)), (0.7, (250, 120, 40, 190)), (1, (230, 30, 60, 220))]), "slope.png")
    save(colorize(rough, [(0, (0, 180, 255, 0)), (0.5, (0, 180, 255, 40)), (0.8, (190, 80, 255, 150)),
         (1, (255, 40, 200, 220))]), "rough.png")
    save(colorize(hz, [(0, (30, 220, 140, 0)), (0.3, (30, 220, 140, 0)), (0.5, (255, 210, 60, 110)),
         (0.75, (255, 120, 40, 170)), (1, (235, 30, 60, 210))]), "hazard.png")
    for f in ("traverse.json", "weather.json"):
        p = os.path.join(OUT, f)
        if os.path.exists(p):
            os.remove(p)
    print("done ->", OUT)


if __name__ == "__main__":
    main()
