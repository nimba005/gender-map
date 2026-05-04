import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, render_template, send_from_directory


load_dotenv()

app = Flask(__name__)
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"


@app.route("/")
def home():
    return render_template("home.html", page="home")


@app.route("/map")
def map_page():
    return render_template(
        "map.html",
        page="map",
        google_maps_api_key=os.getenv("GOOGLE_MAPS_API_KEY", ""),
    )


@app.route("/data/<path:filename>")
def data_files(filename):
    return send_from_directory(DATA_DIR, filename)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True, use_reloader=False)
