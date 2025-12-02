from flask import Flask, render_template, send_from_directory
import os

# Load environment variables from .env (development)
from dotenv import load_dotenv
load_dotenv()

app = Flask(__name__)

# Home page
@app.route("/")
def home():
    return render_template("home.html", page="home")

# Map page
@app.route("/map")
def map_page():
    return render_template(
        "map.html",
        page="map",
        google_maps_api_key=os.getenv("GOOGLE_MAPS_API_KEY", "")
    )

# Serve geojson files from 'data' folder
@app.route("/data/<path:filename>")
def data_files(filename):
    print(f"Serving file: {filename}")
    return send_from_directory(os.path.join(app.root_path, "data"), filename)

if __name__ == "__main__":
    # Debug on for development
    app.run(debug=True)
