import json
import math
import os
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOWNLOADS = Path.home() / "Downloads"
DATA_DIR = ROOT / "data"

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

SECTOR_FILES = {
    "Water": DOWNLOADS / "Hotspot_Water_Kenya.xlsx",
    "Energy": DOWNLOADS / "Hotspot_Energy_Kenya.xlsx",
    "Agriculture": DOWNLOADS / "Hotspot_Agriculture_Kenya.xlsx",
}

COUNTRY_PROFILES = {
    "Kenya": {
        "center": [-0.0236, 37.9062],
        "zoom": 6,
        "status": "County data loaded",
        "study_note": "County-level gender hotspot metrics were generated from the supplied water, energy, and agriculture workbooks.",
        "admin_label": "Counties",
        "geometry_file": "kenya_districts.geojson",
    },
    "Uganda": {
        "center": [1.3733, 32.2903],
        "zoom": 6,
        "status": "Country study layer",
        "study_note": "The dashboard is prepared for Uganda district data. Add Uganda sector workbooks or GeoJSON to activate district-level polygons.",
        "admin_label": "Districts",
        "geometry_file": None,
    },
    "Botswana": {
        "center": [-22.3285, 24.6849],
        "zoom": 6,
        "status": "Country study layer",
        "study_note": "The dashboard is prepared for Botswana district data. Add Botswana sector workbooks or GeoJSON to activate district-level polygons.",
        "admin_label": "Districts",
        "geometry_file": None,
    },
    "Ghana": {
        "center": [7.9465, -1.0232],
        "zoom": 6,
        "status": "Country study layer",
        "study_note": "The dashboard is prepared for Ghana regional data. Add Ghana sector workbooks or GeoJSON to activate regional polygons.",
        "admin_label": "Regions",
        "geometry_file": None,
    },
}


def col_name(ref):
    return "".join(ch for ch in ref if ch.isalpha())


def col_index(name):
    value = 0
    for ch in name:
        value = value * 26 + (ord(ch.upper()) - 64)
    return value - 1


def shared_strings(zf):
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    except KeyError:
        return []

    values = []
    for si in root.findall("m:si", NS):
        values.append("".join(t.text or "" for t in si.findall(".//m:t", NS)))
    return values


def cell_value(cell, strings):
    value = cell.find("m:v", NS)
    if value is None:
        return ""

    raw = value.text or ""
    if cell.attrib.get("t") == "s":
        return strings[int(raw)] if raw.isdigit() and int(raw) < len(strings) else raw
    return raw


def read_sheet(path, sheet_xml="sheet1.xml"):
    with zipfile.ZipFile(path) as zf:
        strings = shared_strings(zf)
        root = ET.fromstring(zf.read(f"xl/worksheets/{sheet_xml}"))

    rows = []
    for row in root.findall(".//m:sheetData/m:row", NS):
        values = []
        for cell in row.findall("m:c", NS):
            idx = col_index(col_name(cell.attrib.get("r", "A")))
            while len(values) < idx:
                values.append("")
            values.append(cell_value(cell, strings))
        rows.append(values)

    if not rows:
        return []

    headers = [str(value).strip() for value in rows[0]]
    records = []
    for row in rows[1:]:
        record = {}
        for idx, header in enumerate(headers):
            if not header:
                continue
            record[header] = row[idx] if idx < len(row) else ""
        records.append(record)
    return records


def as_float(value):
    if value in ("", None):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def risk_level(score):
    if score is None:
        return "No data"
    if score >= 75:
        return "Very High"
    if score >= 60:
        return "High"
    if score >= 40:
        return "Medium"
    if score >= 20:
        return "Low"
    return "Very Low"


def clamp_0_100(value):
    if value is None or not math.isfinite(value):
        return None
    return max(0, min(100, value))


def rounded(value, digits=1):
    if value is None:
        return None
    return round(value, digits)


def sector_raw_metric(sector, row):
    if sector == "Water":
        return as_float(row.get("Per_hh_women_water_collection"))
    if sector == "Energy":
        return as_float(row.get("Women_access_energy"))
    if sector == "Agriculture":
        return as_float(row.get("Female_Pop_Ag"))
    return None


def sector_indicator_notes(sector, row):
    if sector == "Water":
        return [
            f"Women collecting water: {rounded(as_float(row.get('Per_hh_women_water_collection')), 1)}%",
            f"Households with safe water: {rounded(as_float(row.get('Per_hh_access_safe_water')), 1)}%",
            f"Average collection time indicator: {rounded(as_float(row.get('Per_hh_water_collection_time')), 1)}",
        ]
    if sector == "Energy":
        return [
            f"Women with energy access: {int(as_float(row.get('Women_access_energy')) or 0):,}",
            f"Households depending on firewood: {rounded(as_float(row.get('Per_HH_Dep_Firewhood')), 1)}%",
            f"Women employed in energy: {int(as_float(row.get('Women_employ_energy')) or 0):,}",
        ]
    if sector == "Agriculture":
        return [
            f"Female population in agriculture: {int(as_float(row.get('Female_Pop_Ag')) or 0):,}",
            f"Women land ownership index: {rounded(as_float(row.get('Women_Land_Own')), 3)}",
            f"Women dependent on agriculture index: {rounded(as_float(row.get('Women_Depedent_Ag')), 3)}",
        ]
    return []


def build_kenya_records():
    sector_records = {}
    county_order = []

    for sector, path in SECTOR_FILES.items():
        combine_rows = read_sheet(path, "sheet1.xml")
        weighted_rows = read_sheet(path, "sheet2.xml")
        sector_records[sector] = {}

        for index, row in enumerate(combine_rows):
            county = str(row.get("District", "")).strip()
            if not county:
                continue
            if county not in county_order:
                county_order.append(county)

            weighted = weighted_rows[index] if index < len(weighted_rows) else {}
            exposure = as_float(weighted.get("Normalize value_Exposure") or row.get("Normalize value_Exposure"))
            sensitivity = as_float(weighted.get("Sensitivity"))
            adaptive_capacity = as_float(weighted.get("Adaptive_Capacity"))

            components = [v for v in (exposure, sensitivity, 1 - adaptive_capacity if adaptive_capacity is not None else None) if v is not None]
            hotspot_score = clamp_0_100((sum(components) / len(components)) * 100 if components else None)
            vulnerability = clamp_0_100(((exposure or 0) * 0.4 + (sensitivity or 0) * 0.35 + (1 - (adaptive_capacity or 0)) * 0.25) * 100)

            sector_records[sector][county] = {
                "risk_level": risk_level(hotspot_score),
                "gender_hotspot_score": rounded(hotspot_score),
                "vulnerability_score": rounded(vulnerability),
                "exposure": rounded((exposure or 0) * 100),
                "sensitivity": rounded((sensitivity or 0) * 100),
                "adaptive_capacity": rounded((adaptive_capacity or 0) * 100),
                "raw_value": rounded(sector_raw_metric(sector, row), 2),
                "indicators": sector_indicator_notes(sector, row),
            }

    counties = []
    for county in county_order:
        metrics = {sector: sector_records[sector].get(county, {}) for sector in SECTOR_FILES}
        valid_scores = [m.get("gender_hotspot_score") for m in metrics.values() if m.get("gender_hotspot_score") is not None]
        composite = rounded(sum(valid_scores) / len(valid_scores)) if valid_scores else None
        top_sector = None
        if valid_scores:
            top_sector = max(metrics, key=lambda key: metrics[key].get("gender_hotspot_score") or -1)
        counties.append({
            "name": county,
            "country": "Kenya",
            "metrics": metrics,
            "composite_score": composite,
            "risk_level": risk_level(composite),
            "top_sector": top_sector,
        })

    return counties


def summarize_country(country, counties):
    if not counties:
        return {
            "country": country,
            "record_count": 0,
            "average_score": None,
            "risk_level": "Data pending",
            "highest_hotspot": None,
            "top_sector": None,
        }

    scores = [c["composite_score"] for c in counties if c.get("composite_score") is not None]
    average = rounded(sum(scores) / len(scores)) if scores else None
    highest = max(counties, key=lambda item: item.get("composite_score") or -1)
    sector_counts = {}
    for county in counties:
        if county.get("top_sector"):
            sector_counts[county["top_sector"]] = sector_counts.get(county["top_sector"], 0) + 1
    top_sector = max(sector_counts, key=sector_counts.get) if sector_counts else None
    return {
        "country": country,
        "record_count": len(counties),
        "average_score": average,
        "risk_level": risk_level(average),
        "highest_hotspot": highest["name"],
        "top_sector": top_sector,
    }


def main():
    kenya_counties = build_kenya_records()
    countries = []
    for country, profile in COUNTRY_PROFILES.items():
        country_counties = kenya_counties if country == "Kenya" else []
        countries.append({**profile, **summarize_country(country, country_counties)})

    payload = {
        "meta": {
            "title": "AGNES Gender Hotspot Map",
            "countries": ["Kenya", "Uganda", "Botswana", "Ghana"],
            "sectors": list(SECTOR_FILES.keys()),
            "metrics": ["risk_level", "gender_hotspot_score", "vulnerability_score", "exposure", "sensitivity", "adaptive_capacity"],
            "source_note": "Kenya county metrics were generated from the supplied Hotspot Water, Energy, and Agriculture workbooks.",
        },
        "countries": countries,
        "records": {"Kenya": kenya_counties, "Uganda": [], "Botswana": [], "Ghana": []},
    }

    DATA_DIR.mkdir(exist_ok=True)
    output = DATA_DIR / "hotspot_data.json"
    output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {output}")


if __name__ == "__main__":
    main()
