"""Build data/hotspot_data.json for all four study countries.

Kenya     : read from the three sector workbooks in ~/Downloads when they are present,
            otherwise the Kenya records already in hotspot_data.json are kept.
Uganda, Botswana, Ghana : read from data/source/<country>_indicators.csv
            (see tools/generate_illustrative_indicators.py for the placeholder tables).

Usage:
    python tools/build_hotspot_data.py
"""
import csv
import json
import math
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOWNLOADS = Path.home() / "Downloads"
DATA_DIR = ROOT / "data"
SOURCE_DIR = DATA_DIR / "source"
OUTPUT = DATA_DIR / "hotspot_data.json"

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
        "place_label": "County",
        "geometry_file": "kenya_counties.geojson",
        "illustrative": False,
    },
    "Uganda": {
        "center": [1.3733, 32.2903],
        "zoom": 7,
        "status": "Illustrative district data",
        "study_note": "District figures are illustrative placeholders modelled from sub-regional profiles. Replace them with the Uganda sector workbooks from the admin dashboard.",
        "admin_label": "Districts",
        "place_label": "District",
        "geometry_file": "uganda_districts.geojson",
        "illustrative": True,
    },
    "Botswana": {
        "center": [-22.3285, 24.6849],
        "zoom": 6,
        "status": "Illustrative district data",
        "study_note": "District figures are illustrative placeholders based on approximate district profiles. Replace them with the Botswana sector workbooks from the admin dashboard.",
        "admin_label": "Districts",
        "place_label": "District",
        "geometry_file": "botswana_districts.geojson",
        "illustrative": True,
    },
    "Ghana": {
        "center": [7.9465, -1.0232],
        "zoom": 7,
        "status": "Illustrative regional data",
        "study_note": "Regional figures are illustrative placeholders based on approximate regional profiles. Replace them with the Ghana sector workbooks from the admin dashboard.",
        "admin_label": "Regions",
        "place_label": "Region",
        "geometry_file": "ghana_regions.geojson",
        "illustrative": True,
    },
}

# Spelling fixes for county names in the Kenya workbooks, so they match the boundary file.
KENYA_NAME_FIXES = {
    "Kisli": "Kisii",
    "Lalkipia": "Laikipia",
    "Muranga": "Murang'a",
    "WEST Pokot": "West Pokot",
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


def finalize_record(name, country, metrics, **extra):
    valid_scores = [m.get("gender_hotspot_score") for m in metrics.values() if m.get("gender_hotspot_score") is not None]
    composite = rounded(sum(valid_scores) / len(valid_scores)) if valid_scores else None
    top_sector = max(metrics, key=lambda key: metrics[key].get("gender_hotspot_score") or -1) if valid_scores else None
    return {
        "name": name,
        "country": country,
        **extra,
        "metrics": metrics,
        "composite_score": composite,
        "risk_level": risk_level(composite),
        "top_sector": top_sector,
    }


def sector_metrics(sector, row, exposure, sensitivity, adaptive_capacity):
    """Same scoring as the Kenya workbooks: components are 0-1, scores are 0-100."""
    components = [v for v in (exposure, sensitivity, 1 - adaptive_capacity if adaptive_capacity is not None else None) if v is not None]
    hotspot_score = clamp_0_100((sum(components) / len(components)) * 100 if components else None)
    vulnerability = clamp_0_100(((exposure or 0) * 0.4 + (sensitivity or 0) * 0.35 + (1 - (adaptive_capacity or 0)) * 0.25) * 100)
    return {
        "risk_level": risk_level(hotspot_score),
        "gender_hotspot_score": rounded(hotspot_score),
        "vulnerability_score": rounded(vulnerability),
        "exposure": rounded((exposure or 0) * 100),
        "sensitivity": rounded((sensitivity or 0) * 100),
        "adaptive_capacity": rounded((adaptive_capacity or 0) * 100),
        "raw_value": rounded(sector_raw_metric(sector, row), 2),
        "indicators": sector_indicator_notes(sector, row),
    }


def kenya_records_from_workbooks():
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
            county = KENYA_NAME_FIXES.get(county, county)
            if county not in county_order:
                county_order.append(county)

            weighted = weighted_rows[index] if index < len(weighted_rows) else {}
            exposure = as_float(weighted.get("Normalize value_Exposure") or row.get("Normalize value_Exposure"))
            sensitivity = as_float(weighted.get("Sensitivity"))
            adaptive_capacity = as_float(weighted.get("Adaptive_Capacity"))
            sector_records[sector][county] = sector_metrics(sector, row, exposure, sensitivity, adaptive_capacity)

    return [
        finalize_record(
            county,
            "Kenya",
            {sector: sector_records[sector].get(county, {}) for sector in SECTOR_FILES},
            data_status="workbook",
        )
        for county in county_order
    ]


def kenya_records_from_existing_output():
    """Reuse the Kenya records already in hotspot_data.json when the workbooks are not on this machine."""
    payload = json.loads(OUTPUT.read_text(encoding="utf-8"))
    records = []
    for record in payload["records"]["Kenya"]:
        name = KENYA_NAME_FIXES.get(record["name"], record["name"])
        records.append(finalize_record(name, "Kenya", record["metrics"], data_status="workbook"))
    return records


def build_kenya_records():
    if all(path.exists() for path in SECTOR_FILES.values()):
        print("Kenya: reading sector workbooks from Downloads")
        return kenya_records_from_workbooks()
    print("Kenya: workbooks not found in Downloads, keeping the Kenya records already in hotspot_data.json")
    return kenya_records_from_existing_output()


def unit(value, scale=100.0):
    number = as_float(value)
    return None if number is None else max(0.0, min(1.0, number / scale))


def build_indicator_records(country):
    """Build records from data/source/<country>_indicators.csv.

    Exposure     : Exposure_Index (0-1 climate exposure of the unit's zone)
    Water        : sensitivity = women's water collection burden and collection time; capacity = safe water access
    Energy       : sensitivity = firewood dependence; capacity = women's access to modern energy
    Agriculture  : sensitivity = women's dependence on agriculture; capacity = women's land ownership relative to parity (index 0.5)
    """
    path = SOURCE_DIR / f"{country.lower()}_indicators.csv"
    if not path.exists():
        print(f"{country}: {path.name} not found, no records built")
        return []

    illustrative = COUNTRY_PROFILES[country]["illustrative"]
    records = []
    with open(path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            name = str(row.get("District") or row.get("Region") or row.get("County") or "").strip()
            if not name:
                continue
            exposure = unit(row.get("Exposure_Index"), 1.0)
            water_sensitivity = (
                0.6 * (unit(row.get("Per_hh_women_water_collection")) or 0)
                + 0.4 * (unit(row.get("Per_hh_water_collection_time"), 60.0) or 0)
            )
            metrics = {
                "Water": sector_metrics("Water", row, exposure, water_sensitivity, unit(row.get("Per_hh_access_safe_water"))),
                "Energy": sector_metrics("Energy", row, exposure, unit(row.get("Per_HH_Dep_Firewhood")), unit(row.get("Per_women_access_energy"))),
                "Agriculture": sector_metrics("Agriculture", row, exposure, unit(row.get("Women_Depedent_Ag"), 1.0), unit(row.get("Women_Land_Own"), 0.5)),
            }
            records.append(finalize_record(
                name,
                country,
                metrics,
                zone=str(row.get("Zone") or "").strip() or None,
                female_population=int(as_float(row.get("Female_Population")) or 0) or None,
                data_status="illustrative" if illustrative else "source table",
            ))
    return records


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


def check_against_boundaries(country, records):
    geometry_file = COUNTRY_PROFILES[country].get("geometry_file")
    if not geometry_file or not (DATA_DIR / geometry_file).exists():
        return
    geojson = json.loads((DATA_DIR / geometry_file).read_text(encoding="utf-8"))
    shapes = {f["properties"].get("county") or f["properties"].get("name") for f in geojson["features"]}
    names = {record["name"] for record in records}
    if shapes - names:
        print(f"  WARNING {country}: boundaries without data: {sorted(shapes - names)}")
    if names - shapes:
        print(f"  WARNING {country}: records without a boundary: {sorted(names - shapes)}")


def main():
    records = {"Kenya": build_kenya_records()}
    for country in COUNTRY_PROFILES:
        if country != "Kenya":
            records[country] = build_indicator_records(country)

    countries = []
    for country, profile in COUNTRY_PROFILES.items():
        check_against_boundaries(country, records[country])
        summary = summarize_country(country, records[country])
        countries.append({**profile, **summary})
        print(f"{country}: {summary['record_count']} records, average {summary['average_score']}, highest {summary['highest_hotspot']}")

    payload = {
        "meta": {
            "title": "AGNES Gender Hotspot Map",
            "countries": list(COUNTRY_PROFILES),
            "sectors": list(SECTOR_FILES.keys()),
            "metrics": ["risk_level", "gender_hotspot_score", "vulnerability_score", "exposure", "sensitivity", "adaptive_capacity"],
            "source_note": (
                "Kenya county metrics were generated from the supplied Hotspot Water, Energy, and Agriculture workbooks. "
                "Uganda, Botswana, and Ghana use illustrative placeholder figures until their sector workbooks are uploaded."
            ),
            "illustrative_countries": [country for country, profile in COUNTRY_PROFILES.items() if profile["illustrative"]],
            "boundary_sources": "Kenya: geoBoundaries gbOpen (RCMRD). Uganda: geoBoundaries gbHumanitarian (UN OCHA). Botswana and Ghana: geoBoundaries gbOpen (OpenStreetMap contributors).",
        },
        "countries": countries,
        "records": records,
    }

    DATA_DIR.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    main()
