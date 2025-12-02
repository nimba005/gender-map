// 1) Map + English-label tiles
const map = L.map('map', {
  zoomControl: true,
  scrollWheelZoom: true
}).setView([7.5, 21], 3);

// Google basemap (requires Google Maps JS API + GoogleMutant plugin loaded in map.html)
const googleRoadmap = L.gridLayer.googleMutant({
  type: "roadmap",     // roadmap | satellite | terrain | hybrid
  maxZoom: 18,
  styles: []           // optional: avoids some rendering quirks in certain setups
}).addTo(map);

// Optional: let users switch basemaps
const googleHybrid = L.gridLayer.googleMutant({ type: "hybrid", maxZoom: 18, styles: [] });
L.control.layers(
  { "Google Roadmap": googleRoadmap, "Google Hybrid": googleHybrid },
  null,
  { collapsed: true }
).addTo(map);


// 2) Color scale by risk level
function getColor(risk) {
  switch (String(risk || '').trim()) {
    case 'Very High': return '#d73027';
    case 'High':      return '#fc8d59';
    case 'Medium':    return '#fee08b';
    case 'Low':       return '#d9ef8b';
    default:          return '#1a9850'; // Very Low / Unknown
  }
}

// --- Filter state (controlled by dropdowns) ---
const state = {
  country: "__all__",
  sector: "__all__",
  metric: "risk_level"
};

// Try to read metric values from different possible GeoJSON structures.
// Supports:
// 1) p[metric]                       e.g. p.risk_level, p.vulnerability_score
// 2) p.metrics[sector][metric]       e.g. p.metrics.Agriculture.vulnerability_score
// 3) p[metric + "_" + sector]        e.g. p.vulnerability_score_Agriculture
function getMetricValue(p, sector, metric) {
  if (!p) return null;

  // nested metrics structure
  if (sector && sector !== "__all__" && p.metrics && p.metrics[sector] && p.metrics[sector][metric] != null) {
    return p.metrics[sector][metric];
  }

  // flat metric
  if (p[metric] != null) return p[metric];

  // suffix pattern
  if (sector && sector !== "__all__") {
    const key = `${metric}_${sector}`;
    if (p[key] != null) return p[key];
  }

  return null;
}

function getColorNumeric(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "#1a9850";
  // Simple ramp (edit thresholds if your scores differ)
  if (n >= 80) return "#d73027";
  if (n >= 60) return "#fc8d59";
  if (n >= 40) return "#fee08b";
  if (n >= 20) return "#d9ef8b";
  return "#1a9850";
}

function getFillColor(p) {
  if (state.metric === "risk_level") {
    return getColor(getMetricValue(p, state.sector, "risk_level"));
  }
  return getColorNumeric(getMetricValue(p, state.sector, state.metric));
}


// 3) Styling each country polygon based on risk level
function stylePolygon(feature) {
  const p = feature.properties || {};
  const riskLevel = p.risk_level || "Very Low / Unknown"; // Default value if no risk_level is found
  return {
    color: '#555',
    weight: 1.2,
    fillColor: getFillColor(p), // Use the dynamic risk color
    fillOpacity: 0.75
  };
}

function onEachFeature(feature, layer) {
  const p = feature.properties || {};

  const sectorLabel = (state.sector === "__all__") ? "All Sectors" : state.sector;
  const metricLabel = state.metric.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const metricVal = getMetricValue(p, state.sector, state.metric);

  let content = `
    <strong>${p.name || 'Unknown'}</strong><br>
    Sector: <strong>${sectorLabel}</strong><br>
    ${metricLabel}: <strong>${metricVal ?? 'N/A'}</strong><br>
    Risk Level: <strong>${p.risk_level || 'Unknown'}</strong><br>
    <button class="expand-btn">Read More</button>
    <div class="expanded-content" style="display:none;">
      <h3>Detailed Information</h3>
      <p><strong>Population:</strong> ${p.population || 'N/A'}</p>
      <p><strong>GDP:</strong> ${p.gdp || 'N/A'}</p>
      <p><strong>Key Industries:</strong> ${p.key_industries ? p.key_industries.join(', ') : 'N/A'}</p>
      <p><strong>Climate Risks:</strong> ${p.climate_risks ? p.climate_risks.join(', ') : 'N/A'}</p>
      <p><strong>Gendered Climate Impact:</strong> ${p.gendered_climate_impact ? p.gendered_climate_impact.join(', ') : 'N/A'}</p>
      <p><strong>Vulnerable Sectors:</strong> ${p.vulnerable_sectors ? p.vulnerable_sectors.join(', ') : 'N/A'}</p>
      <p><strong>Government Initiatives:</strong> ${p.government_initiatives ? p.government_initiatives.join(', ') : 'N/A'}</p>
      <p><strong>International Partners:</strong> ${p.international_partners ? p.international_partners.join(', ') : 'N/A'}</p>
      <p><strong>Key Challenges:</strong> ${p.key_challenges ? p.key_challenges.join(', ') : 'N/A'}</p>
    </div>
  `;

  layer.bindPopup(content);

  layer.on('popupopen', function () {
    const popupEl = layer.getPopup().getElement();
    const expandBtn = popupEl?.querySelector('.expand-btn');
    const expandedContent = popupEl?.querySelector('.expanded-content');
    if (!expandBtn || !expandedContent) return;

    expandBtn.addEventListener('click', function () {
      const isVisible = expandedContent.style.display === 'block';
      expandedContent.style.display = isVisible ? 'none' : 'block';
      expandBtn.innerHTML = isVisible ? 'Read More' : 'Read Less';
    });
  });
}



// 5) Legend for risk levels
const legend = L.control({ position: 'bottomright' });
legend.onAdd = function () {
  const div = L.DomUtil.create('div', 'legend');
  const grades = ['Very High', 'High', 'Medium', 'Low', 'Very Low / Unknown'];
  const colors = grades.map(g => getColor(g));

  div.innerHTML += '<h4>Risk Level</h4>';
  for (let i = 0; i < grades.length; i++) {
    div.innerHTML += `<i style="background:${colors[i]}"></i> ${grades[i]}<br>`;
  }
  return div;
};
legend.addTo(map);

// 6) Load the geojson data dynamically
const COUNTRIES_POLY = '/data/africa_countries.geojson';

let rawGeoJSON = null;
let geojsonLayer = null;

function loadGeoJSON(url) {
  return fetch(url).then(res => {
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return res.json();
  });
}

function buildSelectOptions(selectEl, items, includeAllLabel) {
  if (!selectEl) return;

  selectEl.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "__all__";
  allOpt.textContent = includeAllLabel || "All";
  selectEl.appendChild(allOpt);

  items.forEach(v => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    selectEl.appendChild(opt);
  });
}

function getUniqueCountries(geojson) {
  const set = new Set();
  (geojson.features || []).forEach(f => {
    const name = f?.properties?.name;
    if (name) set.add(String(name));
  });
  return Array.from(set).sort();
}

function getUniqueSectors(geojson) {
  const set = new Set();
  (geojson.features || []).forEach(f => {
    const p = f?.properties || {};
    // if you store sectors as: p.sector OR p.sectors (array) OR p.metrics keys
    if (p.sector) set.add(String(p.sector));
    if (Array.isArray(p.sectors)) p.sectors.forEach(s => s && set.add(String(s)));
    if (p.metrics && typeof p.metrics === "object") Object.keys(p.metrics).forEach(k => set.add(String(k)));
  });
  return Array.from(set).sort();
}

function addDataToMap(geojson) {
  if (geojsonLayer) map.removeLayer(geojsonLayer);

  geojsonLayer = L.geoJSON(geojson, {
    style: stylePolygon,
    onEachFeature: onEachFeature
  }).addTo(map);
}

function fitToLayerOrAfrica(countryName) {
  if (!geojsonLayer) return;

  // All Africa
  if (!countryName || countryName === "__all__") {
    const b = geojsonLayer.getBounds();
    if (b.isValid()) map.fitBounds(b.pad(0.08));
    return;
  }

  // Find the selected country's layer and zoom to it
  let targetBounds = null;
  geojsonLayer.eachLayer(layer => {
    const n = layer?.feature?.properties?.name;
    if (String(n) === String(countryName)) {
      try { targetBounds = layer.getBounds(); } catch (e) {}
    }
  });

  if (targetBounds && targetBounds.isValid()) {
    map.fitBounds(targetBounds.pad(0.10));
  }
}

function applyFilters() {
  if (!rawGeoJSON) return;

  const country = state.country;

  // Filter features by country (sector + metric usually affect styling, not geometry)
  const features = (rawGeoJSON.features || []).filter(f => {
    if (country === "__all__") return true;
    return String(f?.properties?.name) === String(country);
  });

  const filtered = { ...rawGeoJSON, features };

  addDataToMap(filtered);
  fitToLayerOrAfrica(country);
}

// Hook up UI
function initFilters(geojson) {
  const countrySelect = document.getElementById("countrySelect");
  const sectorSelect  = document.getElementById("sectorSelect");
  const metricSelect  = document.getElementById("metricSelect");
  const refreshBtn    = document.getElementById("refreshBtn");

  buildSelectOptions(countrySelect, getUniqueCountries(geojson), "All");
  buildSelectOptions(sectorSelect, getUniqueSectors(geojson), "All");

  // Defaults
  if (countrySelect) countrySelect.value = "__all__";
  if (sectorSelect) sectorSelect.value = "__all__";
  if (metricSelect) metricSelect.value = "risk_level";

  // Save changes to state (only apply when Refresh is clicked)
  countrySelect?.addEventListener("change", e => state.country = e.target.value);
  sectorSelect?.addEventListener("change",  e => state.sector  = e.target.value);
  metricSelect?.addEventListener("change",  e => state.metric  = e.target.value);

  refreshBtn?.addEventListener("click", () => {
    applyFilters();
  });
}

// Initial load
loadGeoJSON(COUNTRIES_POLY)
  .then(geojson => {
    rawGeoJSON = geojson;
    initFilters(rawGeoJSON);
    applyFilters(); // initial render
  })
  .catch(err => {
    console.error('Failed to load any hotspot data:', err);
  });



// 7) Minimal legend CSS styles
(function injectLegendCSS() {
  const css = `
  .legend {
    background: #fff;
    color: #111;
    line-height: 1.4em;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 13px;
    box-shadow: 0 0 6px rgba(0,0,0,0.2);
  }
  .legend h4 {
    margin: 0 0 4px;
    font-weight: 600;
  }
  .legend i {
    display:inline-block;
    width: 12px;
    height: 12px;
    margin-right: 6px;
    vertical-align: -2px;
    opacity: 0.85;
  }`;
  const el = document.createElement('style');
  el.appendChild(document.createTextNode(css));
  document.head.appendChild(el);
})();
