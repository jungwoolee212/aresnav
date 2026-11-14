#!/usr/bin/env python3
"""
Build js/places.js from NASA Mars Trek: the places Trek marks on its map, so they can be shown, searched,
spoken and used as route start / destination.

  * bookmarks   - Trek's mission bookmarks (Curiosity, Perseverance, Spirit, Opportunity, Sojourner,
                  Viking 1 & 2, InSight, Phoenix, The Martian Path, ...): name, box, centre
  * waypoints   - the named points of each bookmark's waypoint layer (e.g. Bradbury Landing, Endeavour)
  * traverses   - rover / story paths, simplified to ~20 m
  * names       - every IAU-named feature in Trek's nomenclature index (craters, montes, valles, ...)

Run:  python3 tools/build_places.py      (no extra packages)
"""
import json, math, os, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {"User-Agent": "marswalk-navigator-places-builder"}
SEARCH = "https://trek.nasa.gov/mars/TrekServices/ws/index/eq/searchItems?"
ARC = "https://trek.nasa.gov/mars/trekarcgis/rest/services"
MISSION = {  # waypoint / path layers -> mission label
    "curiosity_waypoints": "Curiosity", "mars2020_waypoints": "Perseverance", "mastcam_z_waypoints": "Perseverance Mastcam-Z",
    "opportunity_waypoints": "Opportunity", "spirit_waypoints": "Spirit", "sojourner_waypoints": "Sojourner",
    "viking_waypoints": "Viking 1", "viking2_waypoints": "Viking 2", "phoenix_waypoints": "Phoenix", "InSight_waypoints": "InSight",
    "martian_waypoints": "The Martian", "major_features": "Major features",
}
PATHS = {"curiosity_path": "Curiosity traverse", "Perseverance_Traverse_Path": "Perseverance traverse", "opportunity_path": "Opportunity traverse",
         "spirit_path": "Spirit traverse", "martian_path": "The Martian (Watney's route)"}


def get_json(url):
    for a in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:
            time.sleep(1 + a)
    raise RuntimeError(url)


def query(layer):
    q = urllib.parse.urlencode(dict(where="1=1", outFields="*", returnGeometry="true", outSR=4326, f="json"))
    return get_json(f"{ARC}/{layer}/MapServer/0/query?{q}").get("features", [])


def first(v):
    """Trek stores some fields as lists, some as strings that look like lists."""
    if isinstance(v, list): v = v[0] if v else ""
    return str(v or "").strip("[]'\" ")


def simplify(pts, tol):
    if len(pts) < 3: return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True; stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop(); (ax, ay), (bx, by) = pts[a], pts[b]; L = math.hypot(bx - ax, by - ay) or 1e-12; md, mi = -1, -1
        for i in range(a + 1, b):
            d = abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L
            if d > md: md, mi = d, i
        if md > tol: keep[mi] = True; stack += [(a, mi), (mi, b)]
    return [p for p, k in zip(pts, keep) if k]


def main():
    docs, start = [], 0
    while True:
        r = get_json(SEARCH + urllib.parse.urlencode(dict(q="all", rows=1000, start=start)))
        docs += r["response"]["docs"]; start += 1000
        if start >= r["response"]["numFound"]: break
    bookmarks = []
    for d in docs:
        if d.get("itemType") != "bookmark": continue
        w, s, e, n = map(float, d["bbox"].split(","))
        bookmarks.append(dict(name=d["title"], bbox=[round(w, 4), round(s, 4), round(e, 4), round(n, 4)], lat=round((s + n) / 2, 4), lon=round((w + e) / 2, 4),
                              waypoints=first(d.get("waypoints")), path=first(d.get("path"))))
    names = []
    for d in docs:
        if d.get("itemType") != "nomenclature" or not d.get("shape", "").startswith("POINT"): continue
        lon, lat = map(float, d["shape"][d["shape"].index("(") + 1:-1].split())
        kind = (d.get("productCat2") or "").split(",")[0].strip()
        names.append([d["title"], round(lat, 4), round(lon, 4), kind])
    names.sort()
    waypoints = []
    for layer, mission in MISSION.items():
        for f in query(layer):
            a, g = f["attributes"], f.get("geometry") or {}
            if "x" not in g or not a.get("name"): continue
            waypoints.append([a["name"].strip(), mission, round(g["y"], 5), round(g["x"], 5)])
    traverses = []
    for layer, title in PATHS.items():
        lines = [p for f in query(layer) for p in (f.get("geometry") or {}).get("paths", [])]
        # chain segments end to start where they touch, then simplify (~20 m)
        merged = []
        for p in lines:
            if merged and math.hypot(merged[-1][-1][0] - p[0][0], merged[-1][-1][1] - p[0][1]) < 1e-4: merged[-1] += p[1:]
            else: merged.append(list(p))
        parts = [[[round(y, 5), round(x, 5)] for x, y in simplify(m, 0.00034)] for m in merged if len(m) > 1]
        traverses.append(dict(name=title, layer=layer, parts=parts))
        print(f"  {title}: {sum(len(m) for m in merged)} -> {sum(len(p) for p in parts)} points")
    out = dict(built=time.strftime("%Y-%m-%d"), bookmarks=bookmarks, waypoints=waypoints, traverses=traverses, names=names)
    js = ("// Generated by tools/build_places.py from NASA Mars Trek. Do not edit by hand.\n"
          "// bookmarks: Trek mission bookmarks; waypoints: [name, mission, lat, lon]; traverses: rover / story paths;\n"
          "// names: IAU-named features [name, lat, lon, type].\n"
          "export const PLACES_DATA = " + json.dumps(out, separators=(",", ":"), ensure_ascii=False) + ";\n")
    open(os.path.join(ROOT, "js", "places.js"), "w", encoding="utf-8").write(js)
    print(f"wrote js/places.js: {len(bookmarks)} bookmarks, {len(waypoints)} waypoints, {len(traverses)} traverses, {len(names)} names ({len(js) // 1024} KB)")


if __name__ == "__main__":
    main()
