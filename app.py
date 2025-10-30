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

@app.route("/country/<country_name>")
def country_page(country_name):
    # Load or generate the data for the country (you can fetch from a database or static file)
    country_data = get_country_data(country_name)  # Replace with your data retrieval method
    return render_template("country.html", country_data=country_data)

# Example function to retrieve data (you can replace this with actual data fetching logic)
def get_country_data(country_name):
    # Here you can fetch the data from a JSON, database, or static file
    # For simplicity, here's a mock of the data
    country_info = {
        "Kenya": {
            "name": "Kenya",
            "risk_level": "High",
            "population": "52,573,973",
            "gdp": "95,503 USD million",
            "gender_focus": {
                "women_population": "Approximately 51%",
                "vulnerable_groups": ["Rural women", "Women in agriculture", "Women in marginalized communities", "Female-headed households"],
                "gender_inclusion": "Kenya has made progress in gender equality, but women remain highly vulnerable to the effects of climate change, especially in rural and agricultural settings."
            },
            "other_data": "Kenya is facing challenges from climate change, impacting water access, agriculture, and women's roles as caregivers and food producers."
        }
        # You can add more countries here
    }
    return country_info.get(country_name, {})


# Serve geojson files from 'data' folder
@app.route("/data/<path:filename>")
def data_files(filename):
    print(f"Serving file: {filename}")
    return send_from_directory(os.path.join(app.root_path, "data"), filename)

if __name__ == "__main__":
    # Debug on for development
    app.run(debug=True)
