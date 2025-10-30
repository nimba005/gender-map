// 1) Map + English-label tiles
const map = L.map('map', {
  zoomControl: true,
  scrollWheelZoom: true
}).setView([7.5, 21], 3);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  maxZoom: 18
}).addTo(map);

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

// 3) Styling each country polygon based on risk level
function stylePolygon(feature) {
  const p = feature.properties || {};
  const riskLevel = p.risk_level || "Very Low / Unknown"; // Default value if no risk_level is found
  return {
    color: '#555',
    weight: 1.2,
    fillColor: getColor(riskLevel), // Use the dynamic risk color
    fillOpacity: 0.75
  };
}

// 4) Popup content for each country
function onEachFeature(feature, layer) {
  const p = feature.properties || {};
  const rows = [
    `<strong>${p.name}</strong>`,
    p.risk_level ? `Risk Level: <strong>${p.risk_level}</strong>` : null
  ].filter(Boolean);

  if (rows.length) {
    layer.bindPopup(rows.join('<br>'));
  }
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
const COUNTRIES_POLY = '/data/africa_countries.geojson';  // This should match your Flask route

let geojsonLayer = null;

function loadGeoJSON(url) {
  return fetch(url).then(res => {
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return res.json();
  });
}

function addDataToMap(geojson) {
  if (geojsonLayer) {
    map.removeLayer(geojsonLayer);
  }

  geojsonLayer = L.geoJSON(geojson, {
    style: stylePolygon,
    onEachFeature: onEachFeature
  }).addTo(map);

  // Fit the map to the data bounds
  try {
    const b = geojsonLayer.getBounds();
    if (b.isValid()) map.fitBounds(b.pad(0.1));
  } catch (e) {
    // If no bounds, just ignore
  }
}

loadGeoJSON(COUNTRIES_POLY)
  .then(geojson => {
    console.log('GeoJSON data loaded:', geojson);
    addDataToMap(geojson);
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
