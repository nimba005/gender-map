"""Generate ILLUSTRATIVE sector indicator tables for Uganda, Botswana and Ghana.

These are placeholder figures, not survey results. Each unit starts from an
approximate regional profile (drier / poorer / more rural zones score worse,
capital regions score better) and, for Uganda's 135 districts, a small
repeatable variation is added around the sub-regional profile.

The tables are written to data/source/<country>_indicators.csv using the same
column names as the Kenya sector workbooks, so they can be replaced row by row
with real figures and rebuilt with tools/build_hotspot_data.py.

Usage:
    python tools/generate_illustrative_indicators.py
"""
import csv
import hashlib
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
SOURCE_DIR = DATA_DIR / "source"

FIELDS = [
    "District", "Zone", "Female_Population", "Exposure_Index",
    "Per_hh_women_water_collection", "Per_hh_access_safe_water", "Per_hh_water_collection_time",
    "Women_access_energy", "Per_women_access_energy", "Per_HH_Dep_Firewhood", "Women_employ_energy",
    "Female_Pop_Ag", "Women_Land_Own", "Women_Depedent_Ag",
]

# Profile columns:
#   exposure index (0-1), % households where women collect water, % households with safe water,
#   water collection time (minutes), % households depending on firewood,
#   % women with modern energy access, women dependent on agriculture index (0-1),
#   women land ownership index (0-1), female population
PROFILE_KEYS = ["exp", "wcol", "safe", "ctime", "fire", "eacc", "agdep", "land", "fpop"]

UGANDA_ZONES = {
    "Kampala": (0.30, 35, 95, 8, 8, 88, 0.05, 0.22, 880000),
    "Buganda South": (0.38, 55, 78, 22, 62, 60, 0.52, 0.27, 230000),
    "Buganda North": (0.42, 58, 74, 26, 68, 52, 0.58, 0.26, 190000),
    "Busoga": (0.50, 66, 76, 30, 78, 42, 0.66, 0.22, 190000),
    "Bukedi": (0.55, 70, 72, 32, 84, 36, 0.72, 0.20, 160000),
    "Elgon": (0.62, 68, 70, 28, 82, 38, 0.74, 0.21, 110000),
    "Teso": (0.68, 74, 74, 38, 88, 32, 0.76, 0.20, 110000),
    "Karamoja": (0.92, 86, 55, 62, 93, 14, 0.70, 0.10, 70000),
    "Lango": (0.60, 74, 72, 36, 88, 34, 0.76, 0.21, 130000),
    "Acholi": (0.64, 76, 68, 40, 90, 30, 0.78, 0.19, 105000),
    "West Nile": (0.66, 78, 66, 42, 91, 28, 0.76, 0.16, 135000),
    "Bunyoro": (0.50, 64, 70, 30, 80, 40, 0.68, 0.22, 150000),
    "Tooro": (0.48, 62, 68, 30, 82, 40, 0.70, 0.23, 160000),
    "Ankole": (0.52, 58, 60, 36, 80, 46, 0.68, 0.25, 125000),
    "Kigezi": (0.46, 60, 72, 32, 86, 40, 0.76, 0.26, 120000),
}

UGANDA_DISTRICT_ZONES = {
    "Kampala": ["Kampala"],
    "Buganda South": ["Butambala", "Gomba", "Mpigi", "Bukomansimbi", "Kalangala", "Kalungu", "Lwengo",
                      "Lyantonde", "Masaka", "Rakai", "Ssembabule", "Wakiso", "Kyotera"],
    "Buganda North": ["Buikwe", "Buvuma", "Kayunga", "Kiboga", "Kyankwanzi", "Luwero", "Mityana",
                      "Mubende", "Mukono", "Nakaseke", "Nakasongola", "Kassanda"],
    "Busoga": ["Bugiri", "Namutumba", "Buyende", "Iganga", "Jinja", "Kaliro", "Kamuli", "Luuka",
               "Mayuge", "Namayingo", "Bugweri"],
    "Bukedi": ["Budaka", "Busia", "Butaleja", "Kibuku", "Pallisa", "Tororo", "Butebo"],
    "Elgon": ["Bududa", "Bulambuli", "Bukwo", "Kapchorwa", "Kween", "Manafwa", "Mbale", "Sironko", "Namisindwa"],
    "Teso": ["Amuria", "Bukedea", "Kaberamaido", "Katakwi", "Kumi", "Ngora", "Serere", "Soroti",
             "Kapelebyong", "Kalaki"],
    "Karamoja": ["Abim", "Amudat", "Kaabong", "Kotido", "Moroto", "Nakapiripirit", "Napak", "Nabilatuk", "Karenga"],
    "Lango": ["Alebtong", "Amolatar", "Apac", "Dokolo", "Kole", "Lira", "Otuke", "Oyam", "Kwania"],
    "Acholi": ["Agago", "Amuru", "Gulu", "Kitgum", "Lamwo", "Nwoya", "Pader", "Omoro"],
    "West Nile": ["Adjumani", "Arua", "Koboko", "Maracha", "Moyo", "Nebbi", "Yumbe", "Zombo", "Pakwach",
                  "Obongi", "Madi Okollo"],
    "Bunyoro": ["Buliisa", "Hoima", "Kibaale", "Kiryandongo", "Masindi", "Kagadi", "Kakumiro", "Kikuube"],
    "Tooro": ["Bundibugyo", "Kabarole", "Kamwenge", "Kasese", "Kyegegwa", "Kyenjojo", "Ntoroko",
              "Bunyangabu", "Kitagwenda"],
    "Ankole": ["Buhweju", "Bushenyi", "Ibanda", "Isingiro", "Kiruhura", "Mbarara", "Mitooma", "Ntungamo",
               "Rubirizi", "Sheema", "Kazo", "Rwampara"],
    "Kigezi": ["Kabale", "Kanungu", "Kisoro", "Rukungiri", "Rubanda", "Rukiga"],
}
UGANDA_POPULATION_OVERRIDES = {"Wakiso": 1500000, "Mukono": 360000, "Arua": 420000, "Kasese": 400000}

GHANA_REGIONS = {
    "Greater Accra": ("Coastal", (0.35, 30, 96, 8, 6, 92, 0.06, 0.22, 2770000)),
    "Ashanti": ("Forest", (0.32, 42, 92, 12, 28, 85, 0.28, 0.24, 2760000)),
    "Western": ("Coastal", (0.40, 50, 86, 16, 40, 78, 0.40, 0.22, 1030000)),
    "Western North": ("Forest", (0.42, 58, 78, 22, 62, 66, 0.68, 0.20, 430000)),
    "Central": ("Coastal", (0.44, 52, 88, 15, 42, 78, 0.40, 0.24, 1470000)),
    "Eastern": ("Forest", (0.40, 54, 84, 18, 48, 74, 0.46, 0.24, 1490000)),
    "Volta": ("Coastal", (0.48, 58, 80, 20, 56, 72, 0.52, 0.22, 860000)),
    "Oti": ("Transition", (0.58, 70, 62, 32, 76, 54, 0.72, 0.17, 370000)),
    "Ahafo": ("Forest", (0.40, 56, 82, 18, 54, 72, 0.62, 0.21, 280000)),
    "Bono": ("Transition", (0.42, 54, 84, 17, 50, 76, 0.52, 0.22, 615000)),
    "Bono East": ("Transition", (0.52, 62, 74, 24, 64, 64, 0.64, 0.19, 600000)),
    "Northern": ("Northern Savannah", (0.78, 80, 66, 36, 76, 60, 0.70, 0.12, 1160000)),
    "Savannah": ("Northern Savannah", (0.84, 84, 54, 44, 86, 44, 0.78, 0.10, 320000)),
    "North East": ("Northern Savannah", (0.86, 86, 56, 42, 88, 42, 0.80, 0.09, 335000)),
    "Upper East": ("Northern Savannah", (0.90, 82, 70, 34, 84, 48, 0.78, 0.11, 670000)),
    "Upper West": ("Northern Savannah", (0.88, 84, 68, 36, 86, 46, 0.80, 0.10, 460000)),
}

BOTSWANA_DISTRICTS = {
    "South-East": ("Eastern Hardveld", (0.45, 22, 98, 6, 8, 88, 0.05, 0.30, 190000)),
    "Kweneng": ("Eastern Hardveld", (0.58, 34, 90, 14, 38, 66, 0.28, 0.30, 198000)),
    "Kgatleng": ("Eastern Hardveld", (0.55, 30, 93, 10, 30, 72, 0.24, 0.32, 62000)),
    "Southern": ("Eastern Hardveld", (0.64, 38, 88, 16, 46, 60, 0.36, 0.30, 128000)),
    "Central": ("Central", (0.66, 40, 86, 18, 48, 60, 0.38, 0.29, 330000)),
    "North-East": ("Eastern Hardveld", (0.60, 30, 92, 12, 30, 72, 0.26, 0.31, 84000)),
    "North-West": ("Okavango and Ngamiland", (0.78, 52, 74, 30, 62, 46, 0.48, 0.24, 102000)),
    "Chobe": ("Okavango and Ngamiland", (0.62, 36, 88, 14, 34, 68, 0.30, 0.26, 14000)),
    "Ghanzi": ("Kalahari", (0.86, 50, 76, 28, 58, 46, 0.44, 0.20, 28000)),
    "Kgalagadi": ("Kalahari", (0.90, 48, 78, 26, 56, 48, 0.42, 0.21, 29000)),
}


def clamp(value, low, high):
    return max(low, min(high, value))


def rng_for(country, name):
    seed = int(hashlib.sha256(f"{country}:{name}".encode("utf-8")).hexdigest()[:12], 16)
    return random.Random(seed)


def vary(profile, country, name):
    """Small repeatable variation around a zone profile (used for Uganda districts)."""
    rng = rng_for(country, name)
    p = dict(zip(PROFILE_KEYS, profile))
    return {
        "exp": clamp(p["exp"] + rng.gauss(0, 0.045), 0.05, 0.98),
        "wcol": clamp(p["wcol"] + rng.gauss(0, 5), 10, 96),
        "safe": clamp(p["safe"] + rng.gauss(0, 6), 20, 99),
        "ctime": clamp(p["ctime"] + rng.gauss(0, 5), 4, 90),
        "fire": clamp(p["fire"] + rng.gauss(0, 4), 3, 98),
        "eacc": clamp(p["eacc"] + rng.gauss(0, 6), 4, 96),
        "agdep": clamp(p["agdep"] + rng.gauss(0, 0.05), 0.03, 0.92),
        "land": clamp(p["land"] + rng.gauss(0, 0.03), 0.04, 0.45),
        "fpop": max(8000, p["fpop"] * rng.uniform(0.6, 1.45)),
    }


def row_for(name, zone, p):
    fpop = int(round(p["fpop"], -2))
    energy_jobs_per_10k = 2 + 10 * (p["eacc"] / 100)
    return {
        "District": name,
        "Zone": zone,
        "Female_Population": fpop,
        "Exposure_Index": round(p["exp"], 3),
        "Per_hh_women_water_collection": round(p["wcol"], 1),
        "Per_hh_access_safe_water": round(p["safe"], 1),
        "Per_hh_water_collection_time": round(p["ctime"], 1),
        "Women_access_energy": int(round(fpop * p["eacc"] / 100)),
        "Per_women_access_energy": round(p["eacc"], 1),
        "Per_HH_Dep_Firewhood": round(p["fire"], 1),
        "Women_employ_energy": int(round(fpop * energy_jobs_per_10k / 10000)),
        "Female_Pop_Ag": int(round(fpop * 0.55 * p["agdep"])),
        "Women_Land_Own": round(p["land"], 3),
        "Women_Depedent_Ag": round(p["agdep"], 3),
    }


def boundary_names(filename):
    geojson = json.loads((DATA_DIR / filename).read_text(encoding="utf-8"))
    return sorted(feature["properties"]["name"] for feature in geojson["features"])


def check_names(country, rows, filename):
    expected = set(boundary_names(filename))
    actual = {row["District"] for row in rows}
    if expected != actual:
        raise SystemExit(
            f"{country}: indicator rows do not match {filename}. "
            f"Missing: {sorted(expected - actual)}; unexpected: {sorted(actual - expected)}"
        )


def uganda_rows():
    rows = []
    for zone, districts in UGANDA_DISTRICT_ZONES.items():
        for district in districts:
            profile = vary(UGANDA_ZONES[zone], "Uganda", district)
            if district == "Kampala":
                profile["fpop"] = UGANDA_ZONES[zone][-1]
            if district in UGANDA_POPULATION_OVERRIDES:
                profile["fpop"] = UGANDA_POPULATION_OVERRIDES[district]
            rows.append(row_for(district, zone, profile))
    return sorted(rows, key=lambda row: row["District"])


def fixed_rows(table):
    rows = [row_for(name, zone, dict(zip(PROFILE_KEYS, profile))) for name, (zone, profile) in table.items()]
    return sorted(rows, key=lambda row: row["District"])


def write_csv(country, rows):
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    path = SOURCE_DIR / f"{country.lower()}_indicators.csv"
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"{country}: {len(rows)} rows -> {path}")


def main():
    datasets = {
        "Uganda": (uganda_rows(), "uganda_districts.geojson"),
        "Botswana": (fixed_rows(BOTSWANA_DISTRICTS), "botswana_districts.geojson"),
        "Ghana": (fixed_rows(GHANA_REGIONS), "ghana_regions.geojson"),
    }
    for country, (rows, boundary_file) in datasets.items():
        check_names(country, rows, boundary_file)
        write_csv(country, rows)


if __name__ == "__main__":
    main()
