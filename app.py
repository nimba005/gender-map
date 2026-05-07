import json
import os
import sqlite3
import zipfile
import xml.etree.ElementTree as ET
import base64
import urllib.error
import urllib.request
from datetime import datetime
from functools import wraps
from pathlib import Path

from dotenv import load_dotenv
from flask import (
    Flask,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    session,
    url_for,
)
import psycopg
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename


BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "dev-gender-hotspot-secret")

DATA_DIR = BASE_DIR / "data"
INSTANCE_DIR = BASE_DIR / "instance"
UPLOAD_DIR = INSTANCE_DIR / "uploads"
PDF_DIR = UPLOAD_DIR / "documents"
EXCEL_DIR = UPLOAD_DIR / "excels"
AI_IMAGE_DIR = UPLOAD_DIR / "ai_images"
DB_PATH = INSTANCE_DIR / "gender_hotspots.db"
DATABASE_URL = (os.getenv("DATABASE_URL") or "").strip()
USE_POSTGRES = DATABASE_URL.startswith(("postgres://", "postgresql://"))
POSTGRES_FALLBACK_TO_SQLITE = os.getenv("POSTGRES_FALLBACK_TO_SQLITE", "1") != "0"
POSTGRES_FALLBACK_ACTIVE = False

for folder in (INSTANCE_DIR, PDF_DIR, EXCEL_DIR, AI_IMAGE_DIR):
    folder.mkdir(parents=True, exist_ok=True)

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
COUNTRY_META = {
    "Kenya": {"center": [-0.0236, 37.9062], "zoom": 6, "admin_label": "Counties", "geometry_file": "kenya_districts.geojson"},
    "Uganda": {"center": [1.3733, 32.2903], "zoom": 6, "admin_label": "Districts", "geometry_file": None},
    "Botswana": {"center": [-22.3285, 24.6849], "zoom": 6, "admin_label": "Districts", "geometry_file": None},
    "Ghana": {"center": [7.9465, -1.0232], "zoom": 6, "admin_label": "Regions", "geometry_file": None},
}
SECTORS = ["Water", "Energy", "Agriculture"]
DEFAULT_OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_FALLBACK_MODEL = os.getenv("OPENAI_FALLBACK_MODEL", "gpt-4o-mini")


def db():
    global POSTGRES_FALLBACK_ACTIVE
    if USE_POSTGRES and not POSTGRES_FALLBACK_ACTIVE:
        try:
            return PostgresCompatConnection(DATABASE_URL)
        except Exception as exc:
            if not POSTGRES_FALLBACK_TO_SQLITE:
                raise
            POSTGRES_FALLBACK_ACTIVE = True
            print(f"WARNING: Postgres unavailable, falling back to SQLite: {exc}")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


class CompatRow(dict):
    def __init__(self, mapping):
        super().__init__(mapping)
        self._keys = list(mapping.keys())

    def __getitem__(self, key):
        if isinstance(key, int):
            return super().__getitem__(self._keys[key])
        return super().__getitem__(key)


class PostgresCompatCursor:
    def __init__(self, cursor):
        self._cursor = cursor

    def execute(self, sql, params=None):
        query = sql.replace("?", "%s") if params is not None else sql
        self._cursor.execute(query, params or ())
        return self

    def executemany(self, sql, seq_of_params):
        self._cursor.executemany(sql.replace("?", "%s"), seq_of_params)
        return self

    def fetchone(self):
        row = self._cursor.fetchone()
        return CompatRow(row) if row is not None else None

    def fetchall(self):
        return [CompatRow(row) for row in self._cursor.fetchall()]

    def __iter__(self):
        for row in self._cursor:
            yield CompatRow(row)

    def close(self):
        self._cursor.close()


class PostgresCompatConnection:
    def __init__(self, dsn):
        self._conn = psycopg.connect(dsn, row_factory=psycopg.rows.dict_row)

    def cursor(self):
        return PostgresCompatCursor(self._conn.cursor())

    def execute(self, sql, params=None):
        return self.cursor().execute(sql, params)

    def executescript(self, script):
        statements = [part.strip() for part in script.split(";") if part.strip()]
        with self.cursor() as cursor:
            for statement in statements:
                cursor.execute(statement)

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is not None:
            self.rollback()
        else:
            self.commit()
        self.close()


PostgresCompatCursor.__enter__ = lambda self: self
PostgresCompatCursor.__exit__ = lambda self, exc_type, exc, tb: self.close()


def _insert_app_meta(conn, key, value):
    conn.execute(
        """
        INSERT INTO app_meta (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value=excluded.value,
            updated_at=excluded.updated_at
        """,
        (key, value, datetime.utcnow().isoformat()),
    )


def _reset_postgres_sequences(conn):
    sequence_specs = [
        ("admins", "id"),
        ("uploaded_metrics", "id"),
        ("county_reports", "id"),
        ("county_documents", "id"),
        ("ai_narratives", "id"),
    ]
    for table_name, column_name in sequence_specs:
        conn.execute(
            "SELECT setval(pg_get_serial_sequence(?, ?), COALESCE((SELECT MAX(id) FROM " + table_name + "), 1), true)",
            (table_name, column_name),
        )


def _maybe_migrate_sqlite_to_postgres(conn):
    if not USE_POSTGRES or POSTGRES_FALLBACK_ACTIVE:
        return

    marker = conn.execute("SELECT value FROM app_meta WHERE key = ?", ("sqlite_to_postgres_migrated_v1",)).fetchone()
    if marker:
        return

    tables = ["admins", "uploaded_metrics", "county_reports", "county_documents", "ai_narratives"]
    existing_rows = 0
    for table_name in tables:
        row = conn.execute(f"SELECT COUNT(*) AS total FROM {table_name}").fetchone()
        existing_rows += int(row["total"] or 0)
    if existing_rows > 0:
        _insert_app_meta(conn, "sqlite_to_postgres_migrated_v1", "existing-postgres-data")
        return

    if not DB_PATH.exists():
        _insert_app_meta(conn, "sqlite_to_postgres_migrated_v1", "no-sqlite-source")
        return

    source = sqlite3.connect(DB_PATH)
    source.row_factory = sqlite3.Row
    try:
        for table_name in tables:
            rows = source.execute(f"SELECT * FROM {table_name}").fetchall()
            if not rows:
                continue
            columns = list(rows[0].keys())
            column_sql = ", ".join(columns)
            placeholders = ", ".join(["?"] * len(columns))
            for row in rows:
                conn.execute(
                    f"INSERT INTO {table_name} ({column_sql}) VALUES ({placeholders}) ON CONFLICT (id) DO NOTHING",
                    tuple(row[column] for column in columns),
                )
        _reset_postgres_sequences(conn)
        _insert_app_meta(conn, "sqlite_to_postgres_migrated_v1", "migrated")
    finally:
        source.close()


def init_db():
    with db() as conn:
        if USE_POSTGRES and not POSTGRES_FALLBACK_ACTIVE:
            statements = [
                """
                CREATE TABLE IF NOT EXISTS admins (
                    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS uploaded_metrics (
                    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                    country TEXT NOT NULL,
                    place_name TEXT NOT NULL,
                    sector TEXT NOT NULL,
                    risk_level TEXT,
                    gender_hotspot_score DOUBLE PRECISION,
                    vulnerability_score DOUBLE PRECISION,
                    exposure DOUBLE PRECISION,
                    sensitivity DOUBLE PRECISION,
                    adaptive_capacity DOUBLE PRECISION,
                    raw_value DOUBLE PRECISION,
                    indicators_json TEXT DEFAULT '[]',
                    source_filename TEXT,
                    updated_at TEXT NOT NULL,
                    UNIQUE(country, place_name, sector)
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS county_reports (
                    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                    country TEXT NOT NULL,
                    place_name TEXT NOT NULL,
                    sector TEXT,
                    title TEXT NOT NULL,
                    overview TEXT,
                    findings TEXT,
                    recommendations TEXT,
                    methodology TEXT,
                    updated_at TEXT NOT NULL,
                    UNIQUE(country, place_name, sector)
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS county_documents (
                    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                    country TEXT NOT NULL,
                    place_name TEXT NOT NULL,
                    sector TEXT,
                    title TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    original_filename TEXT NOT NULL,
                    uploaded_at TEXT NOT NULL
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS ai_narratives (
                    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                    country TEXT NOT NULL,
                    place_name TEXT NOT NULL,
                    sector TEXT NOT NULL,
                    narrative_json TEXT NOT NULL,
                    image_filename TEXT,
                    image_alt TEXT,
                    generated_at TEXT NOT NULL,
                    UNIQUE(country, place_name, sector)
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS app_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TEXT NOT NULL
                )
                """,
            ]
            for statement in statements:
                conn.execute(statement)
            _maybe_migrate_sqlite_to_postgres(conn)
        else:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS admins (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS uploaded_metrics (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    country TEXT NOT NULL,
                    place_name TEXT NOT NULL,
                    sector TEXT NOT NULL,
                    risk_level TEXT,
                    gender_hotspot_score REAL,
                    vulnerability_score REAL,
                    exposure REAL,
                    sensitivity REAL,
                    adaptive_capacity REAL,
                    raw_value REAL,
                    indicators_json TEXT DEFAULT '[]',
                    source_filename TEXT,
                    updated_at TEXT NOT NULL,
                    UNIQUE(country, place_name, sector)
                );
                CREATE TABLE IF NOT EXISTS county_reports (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    country TEXT NOT NULL,
                    place_name TEXT NOT NULL,
                    sector TEXT,
                    title TEXT NOT NULL,
                    overview TEXT,
                    findings TEXT,
                    recommendations TEXT,
                    methodology TEXT,
                    updated_at TEXT NOT NULL,
                    UNIQUE(country, place_name, sector)
                );
                CREATE TABLE IF NOT EXISTS county_documents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    country TEXT NOT NULL,
                    place_name TEXT NOT NULL,
                    sector TEXT,
                    title TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    original_filename TEXT NOT NULL,
                    uploaded_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS ai_narratives (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    country TEXT NOT NULL,
                    place_name TEXT NOT NULL,
                    sector TEXT NOT NULL,
                    narrative_json TEXT NOT NULL,
                    image_filename TEXT,
                    image_alt TEXT,
                    generated_at TEXT NOT NULL,
                    UNIQUE(country, place_name, sector)
                );
                """
            )
        count = conn.execute("SELECT COUNT(*) FROM admins").fetchone()[0]
        if count == 0:
            username = os.getenv("ADMIN_USERNAME", "admin")
            password = os.getenv("ADMIN_PASSWORD", "Admin@12345")
            conn.execute(
                "INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)",
                (username, generate_password_hash(password), datetime.utcnow().isoformat()),
            )


def admin_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not session.get("admin_id"):
            flash("Please sign in as admin.", "error")
            return redirect(url_for("admin_login"))
        return view(*args, **kwargs)

    return wrapper


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
    return ["".join(t.text or "" for t in si.findall(".//m:t", NS)) for si in root.findall("m:si", NS)]


def read_xlsx_sheet(path, sheet_xml="sheet1.xml"):
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
            raw = cell.find("m:v", NS)
            value = "" if raw is None else raw.text or ""
            if cell.attrib.get("t") == "s" and value.isdigit() and int(value) < len(strings):
                value = strings[int(value)]
            values.append(value)
        rows.append(values)

    if not rows:
        return []
    headers = [str(value).strip() for value in rows[0]]
    return [{header: row[idx] if idx < len(row) else "" for idx, header in enumerate(headers) if header} for row in rows[1:]]


def as_float(value):
    if value in ("", None):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def rounded(value, digits=1):
    return None if value is None else round(value, digits)


def score_risk(score):
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


def raw_metric(sector, row):
    if sector == "Water":
        return as_float(row.get("Per_hh_women_water_collection"))
    if sector == "Energy":
        return as_float(row.get("Women_access_energy"))
    if sector == "Agriculture":
        return as_float(row.get("Female_Pop_Ag"))
    return as_float(row.get("raw_value") or row.get("Raw Value"))


def indicators_for(sector, row):
    if sector == "Water":
        return [
            f"Women collecting water: {rounded(as_float(row.get('Per_hh_women_water_collection')), 1)}%",
            f"Households with safe water: {rounded(as_float(row.get('Per_hh_access_safe_water')), 1)}%",
            f"Water collection time indicator: {rounded(as_float(row.get('Per_hh_water_collection_time')), 1)}",
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


def process_excel_upload(country, sector, path, source_filename):
    combine_rows = read_xlsx_sheet(path, "sheet1.xml")
    weighted_rows = []
    try:
        weighted_rows = read_xlsx_sheet(path, "sheet2.xml")
    except KeyError:
        weighted_rows = []

    saved = 0
    with db() as conn:
        for index, row in enumerate(combine_rows):
            place = str(row.get("District") or row.get("County") or row.get("Region") or row.get("Place") or "").strip()
            if not place:
                continue
            weighted = weighted_rows[index] if index < len(weighted_rows) else {}
            exposure = as_float(weighted.get("Normalize value_Exposure") or row.get("Normalize value_Exposure") or row.get("exposure"))
            sensitivity = as_float(weighted.get("Sensitivity") or row.get("Sensitivity") or row.get("sensitivity"))
            adaptive = as_float(weighted.get("Adaptive_Capacity") or row.get("Adaptive_Capacity") or row.get("adaptive_capacity"))
            components = [v for v in (exposure, sensitivity, 1 - adaptive if adaptive is not None else None) if v is not None]
            hotspot = ((sum(components) / len(components)) * 100) if components else as_float(row.get("gender_hotspot_score"))
            vulnerability = ((exposure or 0) * 0.4 + (sensitivity or 0) * 0.35 + (1 - (adaptive or 0)) * 0.25) * 100
            indicators = indicators_for(sector, row)
            conn.execute(
                """
                INSERT INTO uploaded_metrics (
                    country, place_name, sector, risk_level, gender_hotspot_score, vulnerability_score,
                    exposure, sensitivity, adaptive_capacity, raw_value, indicators_json, source_filename, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(country, place_name, sector) DO UPDATE SET
                    risk_level=excluded.risk_level,
                    gender_hotspot_score=excluded.gender_hotspot_score,
                    vulnerability_score=excluded.vulnerability_score,
                    exposure=excluded.exposure,
                    sensitivity=excluded.sensitivity,
                    adaptive_capacity=excluded.adaptive_capacity,
                    raw_value=excluded.raw_value,
                    indicators_json=excluded.indicators_json,
                    source_filename=excluded.source_filename,
                    updated_at=excluded.updated_at
                """,
                (
                    country,
                    place,
                    sector,
                    score_risk(hotspot),
                    rounded(hotspot),
                    rounded(vulnerability),
                    rounded((exposure or 0) * 100),
                    rounded((sensitivity or 0) * 100),
                    rounded((adaptive or 0) * 100),
                    rounded(raw_metric(sector, row), 2),
                    json.dumps(indicators),
                    source_filename,
                    datetime.utcnow().isoformat(),
                ),
            )
            saved += 1
    return saved


def openai_request(payload):
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set in .env")

    req = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI request failed: {detail}") from exc


def is_openai_model_access_error(error):
    message = str(error).lower()
    return (
        "must be verified" in message
        or "model_not_found" in message
        or "does not have access to model" in message
        or "unsupported model" in message
    )


def is_openai_tool_error(error):
    message = str(error).lower()
    return "web_search" in message or "image_generation" in message or "tool" in message


def extract_response_text(response):
    if response.get("output_text"):
        return response["output_text"]
    chunks = []
    for item in response.get("output", []):
        for content in item.get("content", []) if isinstance(item, dict) else []:
            if content.get("type") in {"output_text", "text"} and content.get("text"):
                chunks.append(content["text"])
    return "\n".join(chunks).strip()


def extract_image_b64(response):
    for item in response.get("output", []):
        if item.get("type") == "image_generation_call" and item.get("result"):
            return item["result"]
    return None


def parse_json_text(text):
    value = (text or "").strip()
    if value.startswith("```"):
        value = value.strip("`")
        value = value.replace("json\n", "", 1).replace("JSON\n", "", 1)
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        start = value.find("{")
        end = value.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(value[start:end + 1])
            except json.JSONDecodeError:
                pass
    return {
        "overview": value or "AI narrative could not be parsed into structured sections.",
        "context": "",
        "gender_implications": [],
        "sector_reading": [],
        "recommended_actions": [],
        "image_alt": "AI-generated county climate and gender illustration",
    }


def prompt_for_ai_narrative(record, sector):
    metrics = record.get("metrics", {}).get(sector, {})
    all_metrics = json.dumps(record.get("metrics", {}), indent=2)
    return f"""
Create a professional gender hotspot narrative for {record.get('name')}, {record.get('country')}, focused on {sector}.

Use these dashboard metrics:
Selected sector metrics: {json.dumps(metrics, indent=2)}
All sector metrics: {all_metrics}
Composite score: {record.get('composite_score')}
Composite risk: {record.get('risk_level')}
Top pressure sector: {record.get('top_sector')}

You may use web search for general county context, climate stressors, livelihoods, infrastructure, gender and development context, but do not include citations, footnotes, URLs, or named external website references in the final answer.

Return only valid JSON with this shape:
{{
  "overview": "2-3 paragraphs in plain professional language",
  "context": "1-2 paragraphs with local development and climate context",
  "gender_implications": ["bullet", "bullet", "bullet", "bullet"],
  "sector_reading": ["bullet", "bullet", "bullet"],
  "recommended_actions": ["bullet", "bullet", "bullet", "bullet"],
  "data_cautions": ["bullet", "bullet"],
  "image_alt": "short alt text for a generated editorial-style image"
}}

Keep the tone suitable for policy makers, researchers, and programme teams. Do not claim certainty beyond the data.
"""


def save_ai_image(image_b64, country, place, sector):
    if not image_b64:
        return None
    filename = secure_filename(f"{country}_{place}_{sector}_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}.png")
    path = AI_IMAGE_DIR / filename
    path.write_bytes(base64.b64decode(image_b64))
    return filename


def generate_ai_narrative(record, sector):
    prompt = prompt_for_ai_narrative(record, sector)

    def build_payload(model, include_tools=True):
        payload = {
            "model": model,
            "input": prompt,
        }
        if include_tools:
            payload["tools"] = [
                {"type": "web_search"},
                {"type": "image_generation"},
            ]
            payload["tool_choice"] = "auto"
        return payload

    attempts = [
        (DEFAULT_OPENAI_MODEL, True),
        (OPENAI_FALLBACK_MODEL, True),
        (OPENAI_FALLBACK_MODEL, False),
    ]
    seen = set()
    last_error = None
    response = None
    for model, include_tools in attempts:
        key = (model, include_tools)
        if key in seen:
            continue
        seen.add(key)
        try:
            response = openai_request(build_payload(model, include_tools=include_tools))
            if extract_response_text(response):
                break
        except RuntimeError as exc:
            last_error = exc
            if is_openai_model_access_error(exc) or is_openai_tool_error(exc):
                continue
            raise

    if response is None:
        raise last_error or RuntimeError("OpenAI request failed.")

    narrative = parse_json_text(extract_response_text(response))
    image_filename = save_ai_image(
        extract_image_b64(response),
        record.get("country", "country"),
        record.get("name", "place"),
        sector,
    )
    return narrative, image_filename


def base_hotspot_payload():
    with open(DATA_DIR / "hotspot_data.json", encoding="utf-8") as handle:
        return json.load(handle)


def recompute_record(record):
    scores = [
        metrics.get("gender_hotspot_score")
        for metrics in (record.get("metrics") or {}).values()
        if metrics.get("gender_hotspot_score") is not None
    ]
    record["composite_score"] = rounded(sum(scores) / len(scores)) if scores else None
    record["risk_level"] = score_risk(record["composite_score"])
    record["top_sector"] = max(record["metrics"], key=lambda key: record["metrics"][key].get("gender_hotspot_score") or -1) if scores else None
    return record


def merged_hotspot_payload():
    payload = base_hotspot_payload()
    records = payload.setdefault("records", {})
    for country in COUNTRY_META:
        records.setdefault(country, [])

    with db() as conn:
        for row in conn.execute("SELECT * FROM uploaded_metrics ORDER BY place_name"):
            country = row["country"]
            place = row["place_name"]
            country_records = records.setdefault(country, [])
            record = next((item for item in country_records if item["name"].lower() == place.lower()), None)
            if not record:
                record = {"name": place, "country": country, "metrics": {sector: {} for sector in SECTORS}}
                country_records.append(record)
            record.setdefault("metrics", {})
            record["metrics"][row["sector"]] = {
                "risk_level": row["risk_level"],
                "gender_hotspot_score": row["gender_hotspot_score"],
                "vulnerability_score": row["vulnerability_score"],
                "exposure": row["exposure"],
                "sensitivity": row["sensitivity"],
                "adaptive_capacity": row["adaptive_capacity"],
                "raw_value": row["raw_value"],
                "indicators": json.loads(row["indicators_json"] or "[]"),
                "source_filename": row["source_filename"],
            }
            recompute_record(record)

        report_map = {}
        for row in conn.execute("SELECT * FROM county_reports ORDER BY updated_at DESC"):
            report_map.setdefault((row["country"], row["place_name"]), []).append(dict(row))
        doc_map = {}
        for row in conn.execute("SELECT * FROM county_documents ORDER BY uploaded_at DESC"):
            item = dict(row)
            item["url"] = url_for("uploaded_document", filename=item["filename"])
            doc_map.setdefault((row["country"], row["place_name"]), []).append(item)
        ai_map = {}
        for row in conn.execute("SELECT * FROM ai_narratives ORDER BY generated_at DESC"):
            item = dict(row)
            item["narrative"] = json.loads(item.pop("narrative_json") or "{}")
            if item.get("image_filename"):
                item["image_url"] = url_for("uploaded_ai_image", filename=item["image_filename"])
            ai_map[(row["country"], row["place_name"], row["sector"])] = item

    for country_records in records.values():
        for record in country_records:
            key = (record["country"], record["name"])
            record["reports"] = report_map.get(key, [])
            record["documents"] = doc_map.get(key, [])
            record["ai_narratives"] = {
                sector: ai_map.get((record["country"], record["name"], sector))
                for sector in SECTORS
                if ai_map.get((record["country"], record["name"], sector))
            }

    countries = []
    for country, meta in COUNTRY_META.items():
        country_records = records.get(country, [])
        scores = [item.get("composite_score") for item in country_records if item.get("composite_score") is not None]
        average = rounded(sum(scores) / len(scores)) if scores else None
        highest = max(country_records, key=lambda item: item.get("composite_score") or -1) if scores else None
        countries.append({
            **meta,
            "country": country,
            "record_count": len(country_records),
            "average_score": average,
            "risk_level": score_risk(average) if scores else "Data pending",
            "highest_hotspot": highest["name"] if highest else None,
            "top_sector": highest.get("top_sector") if highest else None,
            "status": "Data loaded" if country_records else "Country study layer",
            "study_note": "Admin-managed data is available for this country." if country_records else "Upload Excel data from the admin dashboard to activate detailed records.",
        })
    payload["countries"] = countries
    return payload


@app.route("/")
def home():
    return render_template("home.html", page="home")


@app.route("/map")
def map_page():
    return render_template("map.html", page="map", google_maps_api_key=os.getenv("GOOGLE_MAPS_API_KEY", ""))


@app.route("/api/hotspot-data")
def hotspot_data_api():
    return jsonify(merged_hotspot_payload())


@app.route("/api/ai-narrative", methods=["POST"])
def ai_narrative_api():
    data = request.get_json(silent=True) or {}
    country = data.get("country")
    place = data.get("place_name")
    sector = data.get("sector")
    force = bool(data.get("force"))
    if country not in COUNTRY_META or sector not in SECTORS or not place:
        return jsonify({"error": "country, place_name, and sector are required"}), 400

    with db() as conn:
        cached = conn.execute(
            "SELECT * FROM ai_narratives WHERE country = ? AND place_name = ? AND sector = ?",
            (country, place, sector),
        ).fetchone()
        if cached and not force:
            item = dict(cached)
            item["narrative"] = json.loads(item.pop("narrative_json") or "{}")
            if item.get("image_filename"):
                item["image_url"] = url_for("uploaded_ai_image", filename=item["image_filename"])
            return jsonify(item)

    record = None
    for candidate in merged_hotspot_payload()["records"].get(country, []):
        if candidate["name"].lower() == str(place).lower():
            record = candidate
            break
    if not record:
        return jsonify({"error": "No hotspot record found for this place"}), 404

    try:
        narrative, image_filename = generate_ai_narrative(record, sector)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502

    image_alt = narrative.get("image_alt") or f"AI-generated climate and gender illustration for {place}"
    with db() as conn:
        conn.execute(
            """
            INSERT INTO ai_narratives (country, place_name, sector, narrative_json, image_filename, image_alt, generated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(country, place_name, sector) DO UPDATE SET
                narrative_json=excluded.narrative_json,
                image_filename=excluded.image_filename,
                image_alt=excluded.image_alt,
                generated_at=excluded.generated_at
            """,
            (
                country,
                place,
                sector,
                json.dumps(narrative),
                image_filename,
                image_alt,
                datetime.utcnow().isoformat(),
            ),
        )

    return jsonify({
        "country": country,
        "place_name": place,
        "sector": sector,
        "narrative": narrative,
        "image_filename": image_filename,
        "image_url": url_for("uploaded_ai_image", filename=image_filename) if image_filename else None,
        "image_alt": image_alt,
    })


@app.route("/data/<path:filename>")
def data_files(filename):
    return send_from_directory(DATA_DIR, filename)


@app.route("/uploads/documents/<path:filename>")
def uploaded_document(filename):
    return send_from_directory(PDF_DIR, filename)


@app.route("/uploads/ai-images/<path:filename>")
def uploaded_ai_image(filename):
    return send_from_directory(AI_IMAGE_DIR, filename)


@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        with db() as conn:
            admin = conn.execute("SELECT * FROM admins WHERE username = ?", (username,)).fetchone()
        if admin and check_password_hash(admin["password_hash"], password):
            session["admin_id"] = admin["id"]
            session["admin_username"] = admin["username"]
            return redirect(url_for("admin_dashboard"))
        flash("Invalid admin credentials.", "error")
    return render_template("admin_login.html", page="admin")


@app.route("/admin/logout", methods=["POST"])
def admin_logout():
    session.clear()
    return redirect(url_for("admin_login"))


@app.route("/admin")
@admin_required
def admin_dashboard():
    with db() as conn:
        reports = conn.execute("SELECT * FROM county_reports ORDER BY updated_at DESC LIMIT 12").fetchall()
        docs = conn.execute("SELECT * FROM county_documents ORDER BY uploaded_at DESC LIMIT 12").fetchall()
        metrics = conn.execute("SELECT country, sector, COUNT(*) AS total FROM uploaded_metrics GROUP BY country, sector").fetchall()
    return render_template("admin_dashboard.html", page="admin", countries=COUNTRY_META.keys(), sectors=SECTORS, reports=reports, docs=docs, metrics=metrics)


@app.route("/admin/upload-excel", methods=["POST"])
@admin_required
def admin_upload_excel():
    country = request.form.get("country")
    sector = request.form.get("sector")
    file = request.files.get("excel_file")
    if country not in COUNTRY_META or sector not in SECTORS or not file or not file.filename.lower().endswith(".xlsx"):
        flash("Choose a country, sector, and .xlsx file.", "error")
        return redirect(url_for("admin_dashboard"))
    filename = f"{country}_{sector}_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}_{secure_filename(file.filename)}"
    path = EXCEL_DIR / filename
    file.save(path)
    try:
        saved = process_excel_upload(country, sector, path, file.filename)
        flash(f"Excel uploaded and {saved} {country} {sector} records updated.", "success")
    except Exception as exc:
        flash(f"Could not process Excel file: {exc}", "error")
    return redirect(url_for("admin_dashboard"))


@app.route("/admin/reports", methods=["POST"])
@admin_required
def admin_save_report():
    country = request.form.get("country")
    place = (request.form.get("place_name") or "").strip()
    sector = request.form.get("sector") or ""
    title = (request.form.get("title") or "").strip()
    if country not in COUNTRY_META or not place or not title:
        flash("Country, county/region, and report title are required.", "error")
        return redirect(url_for("admin_dashboard"))
    with db() as conn:
        conn.execute(
            """
            INSERT INTO county_reports (country, place_name, sector, title, overview, findings, recommendations, methodology, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(country, place_name, sector) DO UPDATE SET
                title=excluded.title,
                overview=excluded.overview,
                findings=excluded.findings,
                recommendations=excluded.recommendations,
                methodology=excluded.methodology,
                updated_at=excluded.updated_at
            """,
            (
                country,
                place,
                sector,
                title,
                request.form.get("overview"),
                request.form.get("findings"),
                request.form.get("recommendations"),
                request.form.get("methodology"),
                datetime.utcnow().isoformat(),
            ),
        )
    flash("County report saved and published to the frontend.", "success")
    return redirect(url_for("admin_dashboard"))


@app.route("/admin/documents", methods=["POST"])
@admin_required
def admin_upload_document():
    country = request.form.get("country")
    place = (request.form.get("place_name") or "").strip()
    sector = request.form.get("sector") or ""
    title = (request.form.get("title") or "").strip()
    file = request.files.get("pdf_file")
    if country not in COUNTRY_META or not place or not title or not file or not file.filename.lower().endswith(".pdf"):
        flash("Country, county/region, document title, and PDF are required.", "error")
        return redirect(url_for("admin_dashboard"))
    filename = f"{country}_{place}_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}_{secure_filename(file.filename)}"
    file.save(PDF_DIR / filename)
    with db() as conn:
        conn.execute(
            "INSERT INTO county_documents (country, place_name, sector, title, filename, original_filename, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (country, place, sector, title, filename, file.filename, datetime.utcnow().isoformat()),
        )
    flash("PDF document uploaded and linked to the frontend county report.", "success")
    return redirect(url_for("admin_dashboard"))


init_db()

if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True, use_reloader=False)
