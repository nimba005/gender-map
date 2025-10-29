// ===============================
// Gender Hotspot Map (Leaflet)
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

// 3) Styles
function stylePolygon(feature) {
  const p = feature.properties || {};
  // If you still have "intensity" (1..5), convert to opacity; else use risk colors.
  const hasIntensity = Number.isFinite(p.intensity);
  const fillOpacity = hasIntensity
    ? 0.35 + Math.min(0.4, (p.intensity - 1) * 0.12)
    : 0.75;

  return {
    color: '#555',
    weight: 1,
    fillColor: getColor(p.risk_level),
    fillOpacity
  };
}

function stylePoint(feature) {
  const p = feature.properties || {};
  return {
    radius: 10,
    color: '#555',
    weight: 1,
    fillColor: getColor(p.risk_level),
    fillOpacity: 0.85
  };
}

// 4) Popup content (robust to different schemas)
function onEachFeature(feature, layer) {
  const p = feature.properties || {};
  // Build popup lines only for properties that exist
  const rows = [
    p.country ? `<strong>${p.country}</strong>` : `<strong>Location</strong>`,
    p.sector ? `Sector: ${p.sector}` : null,
    p.indicator ? `Indicator: ${p.indicator}` : null,
    (p.value !== undefined && p.value !== null) ? `Value: ${p.value}` : null,
    p.risk_level ? `Risk Level: <strong>${p.risk_level}</strong>` : null,
    (p.intensity !== undefined && p.intensity !== null) ? `Intensity: ${p.intensity}` : null,
    p.description ? `<em>${p.description}</em>` : null
  ].filter(Boolean);

  if (rows.length) {
    layer.bindPopup(rows.join('<br>'));
  }
}

// Optional: simple hover highlight for polygons
function addHoverHighlight(layer) {
  layer.on({
    mouseover: (e) => {
      const l = e.target;
      l.setStyle({ weight: 2, color: '#333' });
      if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
        l.bringToFront();
      }
    },
    mouseout: (e) => {
      geojsonLayer.resetStyle(e.target);
    }
  });
}

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

// 6) Load data (tries main dataset first, then falls back to demo)
const PRIMARY_DATA = '/data/gender_hotspots.geojson';
const FALLBACK_DATA = '/data/demo_hotspots.geojson';

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
    style: (feat) => (feat.geometry.type === 'Point' ? undefined : stylePolygon(feat)),
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, stylePoint(feature)),
    onEachFeature: (feat, layer) => {
      onEachFeature(feat, layer);
      // Add hover only to polygons
      if (feat.geometry && feat.geometry.type !== 'Point') addHoverHighlight(layer);
    }
  }).addTo(map);

  // Fit map to data bounds if possible
  try {
    const b = geojsonLayer.getBounds();
    if (b.isValid()) map.fitBounds(b.pad(0.1));
  } catch (e) {
    // If no bounds (e.g., single point), ignore
  }
}

// Try primary, then fallback to demo
loadGeoJSON(PRIMARY_DATA)
  .then(addDataToMap)
  .catch(() => loadGeoJSON(FALLBACK_DATA).then(addDataToMap).catch(err => {
    console.error('Failed to load any hotspot data:', err);
  }));

// 7) Minimal legend styles (kept here so you don’t forget the CSS)
// Move these rules to your main CSS if you prefer.
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