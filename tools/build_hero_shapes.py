"""Build data/hero_shapes.json: small, simplified outlines of every mapped place.

The home page draws these as four country thumbnails coloured by risk class, so it
does not need to download the full boundary files.

Usage:
    python tools/build_hero_shapes.py
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
WIDTH = 240  # drawing width in SVG units; height follows each country's shape

BOUNDARY_FILES = {
    "Kenya": "kenya_counties.geojson",
    "Uganda": "uganda_districts.geojson",
    "Botswana": "botswana_districts.geojson",
    "Ghana": "ghana_regions.geojson",
}


def polygons(geometry):
    return geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]


def build_country(filename):
    geojson = json.loads((DATA_DIR / filename).read_text(encoding="utf-8"))
    points = [pt for f in geojson["features"] for poly in polygons(f["geometry"]) for ring in poly for pt in ring]
    min_lon, max_lon = min(p[0] for p in points), max(p[0] for p in points)
    min_lat, max_lat = min(p[1] for p in points), max(p[1] for p in points)
    squeeze = math.cos(math.radians((min_lat + max_lat) / 2))
    scale = WIDTH / ((max_lon - min_lon) * squeeze)
    height = math.ceil((max_lat - min_lat) * scale)

    shapes = []
    for feature in geojson["features"]:
        parts = []
        for poly in polygons(feature["geometry"]):
            ring = poly[0]  # outer ring only; holes are not visible at thumbnail size
            path = []
            for lon, lat in (pt[:2] for pt in ring):
                x = round((lon - min_lon) * squeeze * scale)
                y = round((max_lat - lat) * scale)
                # keep a point only when it moves at least 2 units from the last kept one
                if not path or abs(path[-1][0] - x) + abs(path[-1][1] - y) >= 2:
                    path.append((x, y))
            if len(path) < 4:
                continue
            xs, ys = [p[0] for p in path], [p[1] for p in path]
            if (max(xs) - min(xs)) < 1 and (max(ys) - min(ys)) < 1:
                continue  # islands too small to see
            parts.append("M" + "L".join(f"{x:g} {y:g}" for x, y in path) + "Z")
        if parts:
            name = feature["properties"].get("name") or feature["properties"].get("county")
            shapes.append({"name": name, "d": "".join(parts)})
    return {"width": WIDTH, "height": height, "shapes": shapes}


def main():
    payload = {country: build_country(filename) for country, filename in BOUNDARY_FILES.items()}
    output = DATA_DIR / "hero_shapes.json"
    output.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    for country, item in payload.items():
        print(f"{country}: {len(item['shapes'])} shapes, {item['width']}x{item['height']}")
    print(f"Wrote {output} ({output.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
