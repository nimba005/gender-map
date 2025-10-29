from flask import Flask, render_template, send_from_directory
import os

app = Flask(__name__)

# Home page
@app.route("/")
def home():
    return render_template("home.html", page="home")

# Map page
@app.route("/map")
def map_page():
    return render_template("map.html", page="map")

# (Optional) serve your demo GeoJSON
@app.route("/data/<path:filename>")
def data_files(filename):
    return send_from_directory(os.path.join(app.root_path, "data"), filename)

if __name__ == "__main__":
    # Debug on for development
    app.run(debug=True)
