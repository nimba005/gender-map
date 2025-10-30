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
  
  // Start with basic info for the popup
  let content = `
    <strong>${p.name}</strong><br>
    Risk Level: <strong>${p.risk_level || 'Unknown'}</strong><br>
    Additional Info: <strong>${p.other_data || 'No data available'}</strong><br>
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

  // Bind the content to the popup
  layer.bindPopup(content);

  // Add event listener to toggle the expanded content
  layer.on('popupopen', function () {
    const expandBtn = layer.getPopup().getElement().querySelector('.expand-btn');
    const expandedContent = layer.getPopup().getElement().querySelector('.expanded-content');

    // Toggle the visibility of the expanded content when the button is clicked
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
