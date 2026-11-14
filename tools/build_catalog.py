#!/usr/bin/env python3
"""
Build js/catalog.js: every regional elevation model NASA Mars Trek serves, how to read it in metres, and
the HiRISE image mosaics used for rock density. The app plans anywhere on Mars and picks, for each route,
the sharpest elevation model that covers it (falling back to the global MOLA + HRSC 200 m blend).

Elevation in metres comes from one of two places:
  * Trek's ArcGIS ImageServers (float32 metres, CORS enabled) where one exists for the product.
  * Otherwise the product's 8-bit display tiles. Those carry no vertical scale, so one is fitted here:
    the tiles are block-averaged to ~200 m and regressed against the global MOLA + HRSC blend (metres,
    ImageServer). Products whose tiles aren't a clean linear stretch (r < 0.98) are left out.
    Check: on Gale this gives a scale close to the one fitted against Curiosity's traverse (17.97 m/DN).

Rock density uses HiRISE mosaics only; each gets texture percentiles so its scale lines up with Gale's.

Run:  python3 tools/build_catalog.py      (needs numpy + Pillow; downloads a few hundred tiles)
"""
import io, json, math, os, re, sys, time, urllib.parse, urllib.request
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "tools", ".cache")
os.makedirs(CACHE, exist_ok=True)
UA = {"User-Agent": "marswalk-navigator-catalog-builder"}
SEARCH = "https://trek.nasa.gov/mars/TrekServices/ws/index/eq/searchItems?"
ARC = "https://trek.nasa.gov/mars/trekarcgis/rest/services"
TILES = "https://trek.nasa.gov/tiles/Mars/EQ/{layer}"
GLOBAL = "Mars_MOLA_blend200ppx_HRSC_DEM_clon0dd_200mpp_lzw"
M_PER_DEG = math.pi * 3389500.0 / 180.0
# texture percentiles (5, 99.5) on Gale z14 and where Gale's fitted lo/hi put them (see js/terrain-live.js)
GALE_P5, GALE_P995, GALE_LO, GALE_HI = 0.668, 18.311, 1.346, 27.035
N_P5, N_P995 = (GALE_P5 - GALE_LO) / (GALE_HI - GALE_LO), (GALE_P995 - GALE_LO) / (GALE_HI - GALE_LO)


def get(url, cache=None, binary=False, tries=4):
    path = os.path.join(CACHE, cache) if cache else None
    if path and os.path.exists(path):
        b = open(path, "rb").read()
        return (b or None) if binary else (b.decode("utf-8") if b else None)
    for a in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                b = r.read()
            if path: open(path, "wb").write(b)
            return b if binary else b.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                if path: open(path, "wb").write(b"")
                return None
            time.sleep(1 + a)
        except Exception:
            time.sleep(1 + a)
    return None


def search(key, rows=1000):
    j = get(SEARCH + urllib.parse.urlencode(dict(key=key, rows=rows, start=0)))
    return json.loads(j)["response"]["docs"] if j else []


def capabilities(layer):
    x = get(TILES.format(layer=layer) + "/1.0.0/WMTSCapabilities.xml", f"cap_{layer}.xml")
    if not x: return None
    lo = re.search(r"<ows:LowerCorner>([-\d.]+) ([-\d.]+)", x); up = re.search(r"<ows:UpperCorner>([-\d.]+) ([-\d.]+)", x)
    fmt = re.search(r"<Format>image/(\w+)</Format>", x)
    zs = [int(z) for z in re.findall(r"<TileMatrix>\s*<ows:Identifier>(\d+)</ows:Identifier>", x)]
    if not (lo and up and zs): return None
    return dict(bbox=[float(lo[1]), float(lo[2]), float(up[1]), float(up[2])], fmt=(fmt[1] if fmt else "png").replace("jpeg", "jpg"), zmax=max(zs))


def tile(layer, fmt, z, y, x):
    b = get(f"{TILES.format(layer=layer)}/1.0.0/default/default028mm/{z}/{y}/{x}.{fmt}", f"t_{layer[:60]}_{z}_{y}_{x}.{fmt}", binary=True)
    if not b: return None
    a = np.asarray(Image.open(io.BytesIO(b)).convert("LA")).astype(np.float32)
    return a[..., 0], a[..., 1] > 0


def gpx(lon, lat, z): return (lon + 180) / 360 * 2 ** (z + 1) * 256, (90 - lat) / 180 * 2 ** z * 256


def mosaic(layer, fmt, z, bb):
    x0, y0 = gpx(bb[0], bb[3], z); x1, y1 = gpx(bb[2], bb[1], z)
    tx0, ty0, tx1, ty1 = int(x0 // 256), int(y0 // 256), int(x1 // 256), int(y1 // 256)
    if (tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 400: return None
    g = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.float32); v = np.zeros_like(g, bool)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            t = tile(layer, fmt, z, ty, tx)
            if t: g[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256], v[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = t
    return g, v, tx0 * 256, ty0 * 256


def export(service, bb, w, h):
    """float32 metres from a Trek ImageServer (bsq: pixels then a 1-bit validity mask)."""
    q = urllib.parse.urlencode(dict(bbox=",".join(map(str, bb)), bboxSR=104905, imageSR=104905, size=f"{w},{h}", format="bsq",
                                    pixelType="F32", interpolation="RSP_BilinearInterpolation", f="image"))
    b = get(f"{ARC}/{service}/ImageServer/exportImage?{q}", f"exp_{service[:50]}_{'_'.join(f'{c:.4f}' for c in bb)}_{w}x{h}.bin", binary=True)
    if not b or len(b) < w * h * 4: return None
    a = np.frombuffer(b[:w * h * 4], "<f4").reshape(h, w).astype(np.float64)
    m = np.unpackbits(np.frombuffer(b[w * h * 4:w * h * 4 + (w * h + 7) // 8], np.uint8))[:w * h].reshape(h, w).astype(bool)
    return a, m


def calibrate(layer, fmt, zmax, bb):
    """fit metres = a*DN + b against the global MOLA+HRSC blend, at ~200 m."""
    span_m = max((bb[2] - bb[0]) * M_PER_DEG, (bb[3] - bb[1]) * M_PER_DEG)
    W = max(8, min(400, int(span_m / 200)))
    w = max(4, int(round(W * (bb[2] - bb[0]) / max(bb[2] - bb[0], bb[3] - bb[1])))); h = max(4, int(round(W * (bb[3] - bb[1]) / max(bb[2] - bb[0], bb[3] - bb[1]))))
    ref = export(GLOBAL, bb, w, h)
    if ref is None: return None
    # DEM zoom with ~4+ pixels per reference cell, but few tiles
    z = zmax
    while z > 3:
        x0, y0 = gpx(bb[0], bb[3], z); x1, y1 = gpx(bb[2], bb[1], z)
        if (x1 - x0) / w <= 16 and (int(x1 // 256) - int(x0 // 256) + 1) * (int(y1 // 256) - int(y0 // 256) + 1) <= 120: break
        z -= 1
    mo = mosaic(layer, fmt, z, bb)
    if mo is None: return None
    g, v, ox, oy = mo
    dn, ok = np.zeros((h, w)), np.zeros((h, w), bool)
    for j in range(h):
        for i in range(w):
            lon0 = bb[0] + (bb[2] - bb[0]) * i / w; lon1 = bb[0] + (bb[2] - bb[0]) * (i + 1) / w
            lat1 = bb[3] - (bb[3] - bb[1]) * j / h; lat0 = bb[3] - (bb[3] - bb[1]) * (j + 1) / h
            xa, ya = gpx(lon0, lat1, z); xb, yb = gpx(lon1, lat0, z)
            sl = (slice(max(0, int(ya - oy)), max(0, int(math.ceil(yb - oy)))), slice(max(0, int(xa - ox)), max(0, int(math.ceil(xb - ox)))))
            gv, vv = g[sl], v[sl]
            if vv.size and vv.mean() > 0.9: dn[j, i] = gv[vv].mean(); ok[j, i] = True
    ok &= ref[1]
    if ok.sum() < 30: return None
    X, Y = dn[ok], ref[0][ok]
    if X.std() < 2: return None              # too flat to fit a scale
    a, b = np.polyfit(X, Y, 1)
    r = np.corrcoef(X, Y)[0, 1]; rms = float(np.sqrt(np.mean((a * X + b - Y) ** 2)))
    return dict(a=round(float(a), 4), b=round(float(b), 1), r=round(float(r), 4), rms=round(rms, 1), n=int(ok.sum()), z=z)


def texture(g):
    def box(a, r):
        k = 2 * r + 1; p = np.pad(a.astype(np.float64), r, mode="edge")
        c = np.pad(np.cumsum(np.cumsum(p, 0), 1), ((1, 0), (1, 0)))
        return ((c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)).astype(np.float32)
    bl = box(g, 1); gy, gx = np.gradient(bl); edge = box(np.hypot(gx, gy), 2)
    m = box(g, 2); sd = np.sqrt(np.maximum(box(g * g, 2) - m * m, 0))
    return 0.6 * edge + 0.4 * sd


def mosaic_scale(layer, fmt, zmax, bb, z=14):
    """texture percentiles on this mosaic -> lo/hi that put them where Gale's sit."""
    z = min(z, zmax); rng = np.random.default_rng(3); vals = []; tries = 0
    while len(vals) < 40 and tries < 200:
        tries += 1
        lon, lat = rng.uniform(bb[0], bb[2]), rng.uniform(bb[1], bb[3]); x, y = gpx(lon, lat, z)
        t = tile(layer, fmt, z, int(y // 256), int(x // 256))
        if not t or t[1].mean() < 0.99: continue
        vals.append(texture(t[0])[:255, :255].reshape(85, 3, 85, 3).mean((1, 3)).ravel())
    if len(vals) < 8: return None
    p5, p995 = np.percentile(np.concatenate(vals), [5, 99.5])
    scale = (p995 - p5) / (N_P995 - N_P5); lo = p5 - N_P5 * scale
    return dict(z=z, lo=round(float(lo), 3), hi=round(float(lo + scale), 3), tiles=len(vals))


def main():
    services = {s["name"] for s in json.loads(get(f"{ARC}?f=json"))["services"] if s["type"] == "ImageServer"}
    docs = {}
    for key in ["DEM", "DTM", "Elevation", "HiRISE Mosaic", "Mosaic", "HiRISE"]:
        for d in search(key):
            if d.get("itemType") == "product" and "bbox" in d: docs[d["productLabel"]] = d
    dems, mosaics = [], []
    for lab, d in sorted(docs.items()):
        bb = [float(c) for c in d["bbox"].split(",")]
        if bb[2] - bb[0] > 60: continue        # global products
        cat, inst = d.get("productCat2"), d.get("instrument") or ""
        if cat == "DEM":
            cap = capabilities(lab)
            # the layer's registered services: an ArcGIS ImageServer gives metres; "https://n/a" means download-only
            ls = json.loads(get(f"https://trek.nasa.gov/mars/TrekServices/ws/index/getLayerServices?uuid={d.get('item_UUID')}", f"ls_{lab[:60]}.json") or "{}")
            eps = [x.get("endPoint", "") for x in ls.get("response", {}).get("docs", [])]
            reg = next((e.split("/services/")[1].split("/")[0] for e in eps if "/ImageServer" in e), None)
            norm = lab.replace("-", "_")
            svc = reg if reg in services else lab if lab in services else norm if norm in services else next((s for s in services if s.startswith(norm) and "dem" in s.lower()), None)
            entry = dict(id=lab, title=d.get("title", lab), instrument=inst)
            if svc:
                info = json.loads(get(f"{ARC}/{svc}/ImageServer?f=json", f"svc_{svc}.json") or "{}")
                e = info.get("extent", {})
                entry.update(kind="image", service=svc, bbox=[round(e["xmin"], 5), round(e["ymin"], 5), round(e["xmax"], 5), round(e["ymax"], 5)], pxM=round(info["pixelSizeX"] * M_PER_DEG, 1))
            elif cap:
                cal = calibrate(lab, cap["fmt"], cap["zmax"], cap["bbox"])
                if not cal or cal["r"] < 0.98:
                    print(f"  skip {lab}: {'no fit' if not cal else 'r=%.3f' % cal['r']}"); continue
                entry.update(kind="tiles", layer=lab, fmt=cap["fmt"], zmax=cap["zmax"], bbox=[round(c, 5) for c in cap["bbox"]],
                             pxM=round(180 / (2 ** cap["zmax"] * 256) * M_PER_DEG, 1), a=cal["a"], b=cal["b"], fit=dict(r=cal["r"], rmsM=cal["rms"], n=cal["n"]))
            else:
                print(f"  skip {lab}: no service or tiles"); continue
            dems.append(entry); print(f"DEM {entry['kind']:5s} {entry['pxM']:7.1f} m  {lab}  {entry.get('fit', '')}")
        elif cat == "Mosaic" or "Mosaic" in d.get("title", ""):
            if inst not in ("HiRISE", "CTX"): continue
            cap = capabilities(lab)
            if not cap: continue
            m = dict(layer=lab, title=d.get("title", lab), instrument=inst, fmt=cap["fmt"], zmax=cap["zmax"], bbox=[round(c, 5) for c in cap["bbox"]])
            if inst == "HiRISE" and cap["zmax"] >= 14:
                sc = mosaic_scale(lab, cap["fmt"], cap["zmax"], cap["bbox"])
                if sc: m["rock"] = sc
            mosaics.append(m); print(f"MOS {inst:6s} z{cap['zmax']:2d} {lab}  {m.get('rock', '')}")
    # sanity check of the calibration method against the traverse-fitted Gale scale
    gc = calibrate("Gale_DEM_SMG_1m", "png", 14, [137.1225, -4.9254, 137.7298, -4.2490])
    print("Gale check (method vs traverse fit 17.97 / -4569.2):", gc)
    gi = json.loads(get(f"{ARC}/{GLOBAL}/ImageServer?f=json", f"svc_{GLOBAL}.json"))
    out = dict(built=time.strftime("%Y-%m-%d"), galeCheck=gc,
               global_=dict(id=GLOBAL, title="MGS MOLA + Mars Express HRSC blended DEM (global)", kind="image", service=GLOBAL, bbox=[-180, -90, 180, 90], pxM=round(gi["pixelSizeX"] * M_PER_DEG, 1)),
               dems=sorted(dems, key=lambda e: e["pxM"]), mosaics=mosaics)
    js = ("// Generated by tools/build_catalog.py from the NASA Mars Trek catalog. Do not edit by hand.\n"
          "// dems: regional elevation models (kind 'image' = float metres from Trek ImageServer; 'tiles' = 8-bit tiles,\n"
          "//       metres = a*DN + b fitted against the global MOLA+HRSC blend). mosaics: HiRISE / CTX imagery;\n"
          "//       'rock' = texture scale for rock density (HiRISE only).\n"
          "export const CATALOG = " + json.dumps(out, indent=1).replace('"global_"', '"global"') + ";\n")
    open(os.path.join(ROOT, "js", "catalog.js"), "w", encoding="utf-8").write(js)
    print(f"wrote js/catalog.js: {len(dems)} DEMs, {len(mosaics)} mosaics")


if __name__ == "__main__":
    main()
