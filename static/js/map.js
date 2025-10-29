// ===============================
// Gender Hotspot Map (Leaflet)
// Countries are colored (choropleth) by risk
// ===============================

// 1) Map + English-label tiles
const map = L.map('map', {
  zoomControl: true,
  scrollWheelZoom: true
}).setView([7.5, 21], 3);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  maxZoom: 18
}).addTo(map);

// -------------------------------
// 0) OPTIONAL: risk lookup if polygons don't have risk_level yet
//    Keys must match your polygon country name field.
const RISK_LOOKUP = {
  "Kenya": "High",
  "Ghana": "Very High",
  "Ethiopia": "Medium"
  // Add more as you populate
};
// If your polygons ALREADY have properties.risk_level, this lookup is ignored.

// -------------------------------
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

// -------------------------------
// 3) Styles
function stylePolygon(feature) {
  const p = feature.properties || {};
  const name = p.name || p.ADMIN || p.admin || p.country || '';
  const risk = p.risk_level || RISK_LOOKUP[name] || 'Unknown';

  // If you still keep intensity (1..5) you can convert it to opacity:
  const hasIntensity = Number.isFinite(p.intensity);
  const fillOpacity = hasIntensity
    ? 0.35 + Math.min(0.4, (p.intensity - 1) * 0.12)
    : 0.75;

  return {
    color: '#555',
    weight: 1,
    fillColor: getColor(risk),
    fillOpacity
  };
}

// If you still have point features in your data, we’ll render them as small markers.
// (Safe to keep; polygons are the main layer and will be clickable.)
function stylePoint(feature) {
  const p = feature.properties || {};
  const name = p.country || p.name || '';
  const risk = p.risk_level || RISK_LOOKUP[name] || 'Unknown';

  return {
    radius: 6,
    color: '#333',
    weight: 1,
    fillColor: getColor(risk),
    fillOpacity: 0.85
  };
}

// -------------------------------
// 4) Popup content (robust to different schemas)
function buildPopupProps(p) {
  const name = p.country || p.name || p.ADMIN || 'Location';
  const risk = p.risk_level || RISK_LOOKUP[name] || 'Unknown';

  const rows = [
    `<strong>${name}</strong>`,
    p.sector ? `Sector: ${p.sector}` : null,
    p.indicator ? `Indicator: ${p.indicator}` : null,
    (p.value !== undefined && p.value !== null) ? `Value: ${p.value}` : null,
    `Risk Level: <strong>${risk}</strong>`,
    (p.intensity !== undefined && p.intensity !== null) ? `Intensity: ${p.intensity}` : null,
    p.description ? `<em>${p.description}</em>` : null
  ].filter(Boolean);

  return rows.join('<br>');
}

function onEachFeature(feature, layer) {
  const p = feature.properties || {};
  const html = buildPopupProps(p);
  if (html) layer.bindPopup(html);
}

// Optional: simple hover highlight for polygons
function addHoverHighlight(layer) {
  layer.on({
    mouseover: (e) => {
      const l = e.target;
      l.setStyle({ weight: 2, color: '#333' });
      if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) l.bringToFront();
    },
    mouseout: (e) => {
      countriesLayer.resetStyle(e.target);
    }
  });
}

// -------------------------------
// 5) Legend
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

// -------------------------------
// 6) Load data
// A) Countries polygons (main choropleth)
// B) (Optional) your point/demo data — drawn on top if present
const COUNTRIES_POLY = '/data/africa_countries.geojson';
const OPTIONAL_POINTS = '/data/gender_hotspots.geojson'; // or your demo file

let countriesLayer = null;
let pointsLayer = null;

function loadGeoJSON(url) {
  return fetch(url).then(res => {
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return res.json();
  });
}

// A) Add polygons and color the entire country
loadGeoJSON(COUNTRIES_POLY)
  .then(geojson => {
    countriesLayer = L.geoJSON(geojson, {
      style: stylePolygon,
      onEachFeature: (feat, layer) => {
        onEachFeature(feat, layer);
        // Hover highlight only for polygons
        if (feat.geometry && feat.geometry.type !== 'Point') addHoverHighlight(layer);
      }
    }).addTo(map);

    // Fit to Africa bounds
    const b = countriesLayer.getBounds();
    if (b.isValid()) map.fitBounds(b.pad(0.05));
  })
  .catch(err => console.error('Failed to load countries polygons:', err));

// B) Optional points (kept for now; remove this block if you don’t want points)
loadGeoJSON(OPTIONAL_POINTS)
  .then(geojson => {
    pointsLayer = L.geoJSON(geojson, {
      style: f => undefined, // not used for points
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, stylePoint(feature)),
      onEachFeature
    }).addTo(map);
  })
  .catch(() => {/* ignore if not present */});

// -------------------------------
// 7) Minimal legend styles (inject if not in CSS)
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
