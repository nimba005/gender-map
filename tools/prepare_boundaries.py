"""Download and normalise sub-national boundaries for Kenya, Uganda, Botswana and Ghana.

Source: geoBoundaries (https://www.geoboundaries.org), simplified GeoJSON releases.
  - Kenya    : gbOpen ADM1, 47 counties (RCMRD / Africa GeoPortal)
  - Uganda   : gbHumanitarian ADM2, 135 districts (UN OCHA)
  - Botswana : gbOpen ADM1, 10 districts (OpenStreetMap contributors)
  - Ghana    : gbOpen ADM1, 16 regions (OpenStreetMap contributors)

Usage:
    python tools/prepare_boundaries.py                # download from geoBoundaries
    python tools/prepare_boundaries.py --from-dir X   # use already-downloaded files in X

Output files in data/ use the same property layout the map expects:
    {"country": ..., "name": ..., "source_name": ..., "shape_id": ...}
"""
import argparse
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
RELEASE = "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData"

SOURCES = {
    "Kenya": {
        "release": "gbOpen", "iso": "KEN", "level": "ADM1",
        "output": "kenya_counties.geojson", "strip": [],
        "rename": {"Taita Taveta": "Taita-Taveta", "Tharaka": "Tharaka-Nithi"},
        "attribution": "geoBoundaries gbOpen (RCMRD, Africa GeoPortal)",
    },
    "Uganda": {
        "release": "gbHumanitarian", "iso": "UGA", "level": "ADM2",
        "output": "uganda_districts.geojson", "strip": [],
        "attribution": "geoBoundaries gbHumanitarian (UN OCHA)",
    },
    "Botswana": {
        "release": "gbOpen", "iso": "BWA", "level": "ADM1",
        "output": "botswana_districts.geojson", "strip": [" District"],
        "attribution": "geoBoundaries gbOpen (OpenStreetMap contributors)",
    },
    "Ghana": {
        "release": "gbOpen", "iso": "GHA", "level": "ADM1",
        "output": "ghana_regions.geojson", "strip": [" Region"],
        "attribution": "geoBoundaries gbOpen (OpenStreetMap contributors)",
    },
}


def source_filename(spec):
    return f"{spec['release']}-{spec['iso']}-{spec['level']}.geojson"


def source_url(spec):
    return (
        f"{RELEASE}/{spec['release']}/{spec['iso']}/{spec['level']}/"
        f"geoBoundaries-{spec['iso']}-{spec['level']}_simplified.geojson"
    )


def round_ring(ring, digits=4):
    out = []
    for x, y in (pt[:2] for pt in ring):
        point = [round(x, digits), round(y, digits)]
        if not out or out[-1] != point:
            out.append(point)
    return out


def round_geometry(geometry):
    if geometry["type"] == "Polygon":
        polygons = [geometry["coordinates"]]
    elif geometry["type"] == "MultiPolygon":
        polygons = geometry["coordinates"]
    else:
        raise ValueError(f"Unexpected geometry type {geometry['type']}")
    cleaned = []
    for polygon in polygons:
        rings = [round_ring(ring) for ring in polygon]
        rings = [ring for ring in rings if len(ring) >= 4]
        if rings:
            cleaned.append(rings)
    return {"type": "MultiPolygon", "coordinates": cleaned}


def clean_name(name, strip, rename=None):
    value = " ".join(str(name).split())
    for suffix in strip:
        if value.endswith(suffix):
            value = value[: -len(suffix)]
    value = value.strip()
    return (rename or {}).get(value, value)


def load_source(spec, from_dir):
    if from_dir:
        return json.loads((Path(from_dir) / source_filename(spec)).read_text(encoding="utf-8"))
    with urllib.request.urlopen(source_url(spec), timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--from-dir", help="Folder holding files named like gbOpen-GHA-ADM1.geojson")
    args = parser.parse_args()

    for country, spec in SOURCES.items():
        raw = load_source(spec, args.from_dir)
        features = []
        for feature in raw["features"]:
            props = feature.get("properties") or {}
            features.append({
                "type": "Feature",
                "properties": {
                    "country": country,
                    "name": clean_name(props.get("shapeName"), spec["strip"], spec.get("rename")),
                    "source_name": props.get("shapeName"),
                    "shape_id": props.get("shapeID"),
                },
                "geometry": round_geometry(feature["geometry"]),
            })
        features.sort(key=lambda item: item["properties"]["name"])
        names = [item["properties"]["name"] for item in features]
        if len(set(names)) != len(names):
            raise SystemExit(f"{country}: duplicate unit names in boundary file")
        payload = {
            "type": "FeatureCollection",
            "name": spec["output"].replace(".geojson", ""),
            "meta": {
                "country": country,
                "admin_level": spec["level"],
                "source": spec["attribution"],
                "source_url": source_url(spec),
            },
            "features": features,
        }
        output = DATA_DIR / spec["output"]
        output.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        print(f"{country}: {len(features)} units -> {output} ({output.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
