# AGNES Gender Hotspot Map

An interactive map of climate change and gender vulnerability hotspots across water, energy,
and agriculture in Kenya (47 counties), Uganda (135 districts), Botswana (10 districts), and
Ghana (16 regions).

Live: https://gender-map.52.147.204.253.sslip.io

> **Data status.** Kenya figures come from the supplied sector workbooks. Uganda, Botswana, and
> Ghana currently use **illustrative placeholder figures**, not survey results. They are labelled
> as such in the app and are replaced as each country's workbooks are uploaded.

## What is in the app

- **Overview** (`/`): live risk snapshot of the four countries, country and sector summaries, priority list.
- **Interactive map** (`/map`): filter by country, sector, metric, and risk class; open any place for
  its scores, an automatic data brief, admin-written reports, PDFs, and an AI-drafted report.
  Views can be shared by link (`?country=Ghana&sector=Water&place=Upper East`) and the visible
  records downloaded as CSV.
- **Methodology** (`/methodology`): score formula, risk classes, indicators, and data status.
- **Admin** (`/admin`): upload sector workbooks (`.xlsx`), publish reports, attach PDFs.
- **Health check** (`/healthz`).

## Run locally

```bash
python -m venv .venv
.venv/Scripts/activate          # Windows;  source .venv/bin/activate on Linux/macOS
pip install -r deploy/requirements.txt
python app.py                   # http://localhost:5000
```

Settings are read from `.env` (all optional for local use):

| Variable | Purpose |
|---|---|
| `SECRET_KEY` | Session signing key. Set a long random value in production. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Admin login created on first start. Always set the password in production. |
| `DATABASE_URL` | `postgresql://...`. Without it the app uses SQLite in `instance/`. |
| `REDIS_URL` | `redis://...`. Caches the map data; optional. |
| `BEHIND_PROXY` | `1` when served over HTTPS behind a reverse proxy. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | AI reports. |
| `GOOGLE_MAPS_API_KEY` | Google basemap. Falls back to OpenStreetMap without it. |

## Run with Docker

The compose file starts the app, Postgres, Redis, and Caddy (automatic HTTPS).

```bash
cp .env.docker.example .env.docker     # fill in the secrets
docker compose --env-file .env.docker up -d --build
```

Set `SITE_ADDRESS` to a public hostname for HTTPS, or leave `:80` for plain HTTP.
Uploads and the database are kept in named volumes.

## Data pipeline

| Step | Command | Output |
|---|---|---|
| Boundaries and national outlines (geoBoundaries) | `python tools/prepare_boundaries.py` | `data/*_counties|districts|regions.geojson`, `data/study_countries.geojson` |
| Placeholder indicators | `python tools/generate_illustrative_indicators.py` | `data/source/*_indicators.csv` |
| Scores | `python tools/build_hotspot_data.py` | `data/hotspot_data.json` |
| Home page outlines | `python tools/build_hero_shapes.py` | `data/hero_shapes.json` |

To replace placeholder figures, either upload the sector workbooks from the admin dashboard, or
edit the CSV in `data/source/` and re-run `build_hotspot_data.py`. Scoring is described on the
Methodology page.

## Deployment on the shared VM

The live site runs beside the IPCC tool on the same VM, behind nginx with a Let's Encrypt
certificate, using a local Postgres database and Redis. The files used are in `deploy/`:
`gender-map.service` (gunicorn), `nginx-gender-map.conf`, `provision_db_env.sh`, and
`requirements.txt`. To update: copy the changed files to `/home/spm/gender-map`, then
`sudo systemctl restart gender-map` and `redis-cli -n 1 del gender-map:hotspot-payload:v1`.

Boundaries: geoBoundaries (RCMRD, UN OCHA, OpenStreetMap contributors).
