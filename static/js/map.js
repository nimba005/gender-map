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
// 6) Load the geojson data dynamically
const COUNTRIES_POLY = '/data/africa_countries.geojson';

let rawGeoJSON = null;
let geojsonLayer = null;

// District state
let rawDistrictsGeoJSON = null;
let districtLayer = null;
let selectedDistrictId = null;
const districtLayerIndex = new Map(); // id -> leaflet layer

// ---------- Helpers ----------
function loadGeoJSON(url) {
  return fetch(url).then(res => {
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return res.json();
  });
}

function slugifyCountry(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Adjust this if your files are named differently.
function getDistrictsUrl(countryName) {
  // Example expected: /data/kenya_districts.geojson
  const slug = slugifyCountry(countryName);
  return `/data/${slug}_districts.geojson`;
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
    if (p.sector) set.add(String(p.sector));
    if (Array.isArray(p.sectors)) p.sectors.forEach(s => s && set.add(String(s)));
    if (p.metrics && typeof p.metrics === "object") Object.keys(p.metrics).forEach(k => set.add(String(k)));
  });
  return Array.from(set).sort();
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtInt(v) {
  const n = safeNum(v);
  return (n == null) ? "N/A" : n.toLocaleString();
}

function riskOrder(risk) {
  const r = String(risk || "").trim().toLowerCase();
  if (r === "very low" || r.includes("very low")) return 1;
  if (r === "low" || r.includes("low")) return 2;
  if (r === "medium" || r.includes("medium")) return 3;
  if (r === "high" || r.includes("high")) return 4;
  if (r === "very high" || r.includes("very high")) return 5;
  return 0;
}

// ---------- Country Map Layer ----------
function addCountryDataToMap(geojson) {
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

  // Zoom to selected country
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

// ---------- District Layer + Panel ----------
function getDistrictName(p) {
  return p?.district || p?.district_name || p?.name || p?.ADM2_EN || p?.ADM2_NAME || "Unknown";
}

function getDistrictId(p, fallbackName) {
  return String(
    p?.id || p?.district_id || p?.ADM2_PCODE || p?.ADM2_CODE || fallbackName || Math.random()
  );
}

function getDistrictScore(p) {
  // Prefer explicit scaled score fields; else use currently selected metric if numeric.
  const direct = safeNum(p?.scaled_score ?? p?.score ?? p?.scaledScore);
  if (direct != null) return direct;

  const metricVal = getMetricValue(p, state.sector, state.metric);
  const n = safeNum(metricVal);
  return n;
}

function getDistrictRawValue(p) {
  return p?.raw_value ?? p?.rawValue ?? p?.value ?? null;
}

function getDistrictRisk(p, score) {
  // Prefer explicit risk_level; else derive from score.
  const explicit = p?.risk_level || p?.riskLevel;
  if (explicit) return explicit;

  const n = safeNum(score);
  if (n == null) return "Unknown";
  // tweak thresholds to your scale
  if (n >= 80) return "Very High";
  if (n >= 60) return "High";
  if (n >= 40) return "Medium";
  if (n >= 20) return "Low";
  return "Very Low";
}

function styleDistrictPolygon(feature) {
  const p = feature.properties || {};
  const name = getDistrictName(p);
  const id = getDistrictId(p, name);
  const score = getDistrictScore(p);
  const risk = getDistrictRisk(p, score);
  const isSelected = (selectedDistrictId && String(id) === String(selectedDistrictId));

  return {
    color: isSelected ? '#2563eb' : '#6b7280',
    weight: isSelected ? 3 : 1.1,
    fillColor: (state.metric === "risk_level") ? getColor(risk) : (score == null ? "#1a9850" : getColorNumeric(score)),
    fillOpacity: isSelected ? 0.85 : 0.65
  };
}

function onEachDistrictFeature(feature, layer) {
  const p = feature.properties || {};
  const name = getDistrictName(p);
  const id = getDistrictId(p, name);
  const score = getDistrictScore(p);
  const raw = getDistrictRawValue(p);
  const risk = getDistrictRisk(p, score);

  layer._districtId = id;
  districtLayerIndex.set(String(id), layer);

  layer.bindPopup(`
    <strong>${name}</strong><br>
    Scaled Score: <strong>${score == null ? "N/A" : score.toFixed(1)}</strong><br>
    Raw Value: <strong>${raw == null ? "N/A" : fmtInt(raw)}</strong><br>
    Risk Level: <strong>${risk}</strong><br>
  `);

  layer.on("click", () => {
    selectDistrict(id, true);
    scrollToDistrictCard(id);
  });
}

function clearDistricts() {
  rawDistrictsGeoJSON = null;
  selectedDistrictId = null;
  districtLayerIndex.clear();

  if (districtLayer) {
    map.removeLayer(districtLayer);
    districtLayer = null;
  }

  // Hide panel
  const panel = document.getElementById("districtPanel");
  const grid = document.getElementById("districtGrid");
  const count = document.getElementById("districtCount");
  const sub = document.getElementById("districtSub");
  if (panel) panel.style.display = "none";
  if (grid) grid.innerHTML = "";
  if (count) count.textContent = "0";
  if (sub) sub.textContent = "Select a country to load districts.";
}

async function loadDistrictsForCountry(countryName) {
  if (!countryName || countryName === "__all__") {
    clearDistricts();
    return;
  }

  const url = getDistrictsUrl(countryName);

  try {
    const geojson = await loadGeoJSON(url);
    rawDistrictsGeoJSON = geojson;

    // remove old district layer
    if (districtLayer) map.removeLayer(districtLayer);
    districtLayerIndex.clear();
    selectedDistrictId = null;

    districtLayer = L.geoJSON(rawDistrictsGeoJSON, {
      style: styleDistrictPolygon,
      onEachFeature: onEachDistrictFeature
    }).addTo(map);

    renderDistrictPanel();
  } catch (e) {
    console.warn("No district file found or failed to load:", url, e);
    clearDistricts();
  }
}

function selectDistrict(id, zoom) {
  selectedDistrictId = String(id);

  if (districtLayer) {
    districtLayer.setStyle(styleDistrictPolygon);
  }

  const layer = districtLayerIndex.get(String(selectedDistrictId));
  if (layer && zoom) {
    try {
      map.fitBounds(layer.getBounds().pad(0.12));
      layer.openPopup();
    } catch (e) {}
  }

  // highlight card
  document.querySelectorAll(".districtCard").forEach(el => el.classList.remove("districtCard--active"));
  const card = document.querySelector(`[data-district-id="${CSS.escape(String(selectedDistrictId))}"]`);
  if (card) card.classList.add("districtCard--active");
}

function scrollToDistrictCard(id) {
  const el = document.querySelector(`[data-district-id="${CSS.escape(String(id))}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

function getFilteredDistrictFeatures() {
  const q = (document.getElementById("districtSearch")?.value || "").trim().toLowerCase();
  const sortMode = document.getElementById("districtSort")?.value || "name_asc";

  const features = (rawDistrictsGeoJSON?.features || []).map(f => {
    const p = f.properties || {};
    const name = getDistrictName(p);
    const id = getDistrictId(p, name);
    const score = getDistrictScore(p);
    const raw = getDistrictRawValue(p);
    const risk = getDistrictRisk(p, score);
    return { f, p, id, name, score, raw, risk };
  });

  const filtered = features.filter(x => x.name.toLowerCase().includes(q));

  filtered.sort((a, b) => {
    if (sortMode === "name_asc") return a.name.localeCompare(b.name);

    if (sortMode === "score_desc") return (safeNum(b.score) ?? -Infinity) - (safeNum(a.score) ?? -Infinity);
    if (sortMode === "score_asc")  return (safeNum(a.score) ?? Infinity) - (safeNum(b.score) ?? Infinity);

    if (sortMode === "risk_desc") return riskOrder(b.risk) - riskOrder(a.risk);
    if (sortMode === "risk_asc")  return riskOrder(a.risk) - riskOrder(b.risk);

    return 0;
  });

  return filtered;
}

function renderDistrictPanel() {
  const panel = document.getElementById("districtPanel");
  const grid = document.getElementById("districtGrid");
  const count = document.getElementById("districtCount");
  const sub = document.getElementById("districtSub");

  if (!panel || !grid || !count || !sub) return;

  panel.style.display = "block";

  const rows = getFilteredDistrictFeatures();
  count.textContent = String(rows.length);

  sub.textContent = `${state.country} • ${state.sector === "__all__" ? "All sectors" : state.sector} • ${state.metric.replace(/_/g, " ")}`;

  grid.innerHTML = rows.map(x => {
    const scoreText = (x.score == null) ? "N/A" : x.score.toFixed(1);
    const rawText = (x.raw == null) ? "N/A" : fmtInt(x.raw);

    return `
      <button class="districtCard" data-district-id="${String(x.id)}" type="button">
        <div class="districtCard__top">
          <div class="districtCard__name">${x.name}</div>
          <div class="districtCard__badge">${scoreText}</div>
        </div>

        <div class="districtCard__row">
          <span class="districtCard__label">Scaled Score:</span>
          <span class="districtCard__value">${scoreText}</span>
        </div>

        <div class="districtCard__row">
          <span class="districtCard__label">Raw Value:</span>
          <span class="districtCard__value">${rawText}</span>
        </div>

        <div class="districtCard__row">
          <span class="districtCard__label">Risk Level:</span>
          <span class="districtCard__risk">${x.risk}</span>
        </div>
      </button>
    `;
  }).join("");

  // wire click handlers
  grid.querySelectorAll(".districtCard").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-district-id");
      selectDistrict(id, true);
    });
  });
}

// ---------- Score Info (baseline + targets) ----------
const SCORE_INFO = {
  vulnerability_score: {
    title: "Vulnerability Score",
    scale: "0–100 (higher = more vulnerable)",
    baselineYear: 2020,
    baseline: 35,
    targetYear: 2030,
    target: 60,
    notes: "Update baseline/targets to match your framework."
  },
  gender_hotspot_score: {
    title: "Gender Hotspot Score",
    scale: "0–100 (higher = more severe hotspot)",
    baselineYear: 2020,
    baseline: 25,
    targetYear: 2030,
    target: 50,
    notes: "Replace with agreed thresholds and indicators."
  },
  risk_level: {
    title: "Risk Level",
    scale: "Categorical: Very Low → Very High",
    baselineYear: 2020,
    baseline: "N/A",
    targetYear: 2030,
    target: "N/A",
    notes: "Risk levels are derived or set from your scoring logic."
  }
};

function openScoreModal() {
  const modal = document.getElementById("scoreModal");
  const body = document.getElementById("scoreModalBody");
  if (!modal || !body) return;

  const info = SCORE_INFO[state.metric] || {
    title: "Score Info",
    scale: "N/A",
    baselineYear: "N/A",
    baseline: "N/A",
    targetYear: "N/A",
    target: "N/A",
    notes: "Add baseline/targets here."
  };

  const sectorLabel = (state.sector === "__all__") ? "All sectors" : state.sector;

  body.innerHTML = `
    <div class="scoreInfo">
      <p><strong>Country:</strong> ${state.country}</p>
      <p><strong>Sector:</strong> ${sectorLabel}</p>
      <p><strong>Metric:</strong> ${info.title}</p>
      <p><strong>Scale:</strong> ${info.scale}</p>

      <div class="scoreInfo__grid">
        <div class="scoreInfo__box">
          <div class="scoreInfo__k">Baseline (${info.baselineYear})</div>
          <div class="scoreInfo__v">${info.baseline}</div>
        </div>
        <div class="scoreInfo__box">
          <div class="scoreInfo__k">Target (${info.targetYear})</div>
          <div class="scoreInfo__v">${info.target}</div>
        </div>
      </div>

      <p class="muted" style="margin-top:10px;">${info.notes}</p>
      <p class="muted">Tip: put your agreed indicator definitions + thresholds here and align with your “baseline–target” framework.</p>
    </div>
  `;

  modal.style.display = "block";
}

function closeScoreModal() {
  const modal = document.getElementById("scoreModal");
  if (modal) modal.style.display = "none";
}

// ---------- Apply filters ----------
function applyFilters() {
  if (!rawGeoJSON) return;

  const country = state.country;

  // Filter country layer
  const features = (rawGeoJSON.features || []).filter(f => {
    if (country === "__all__") return true;
    return String(f?.properties?.name) === String(country);
  });

  const filtered = { ...rawGeoJSON, features };

  addCountryDataToMap(filtered);
  fitToLayerOrAfrica(country);

  // Load districts for selected country
  loadDistrictsForCountry(country);
}

// ---------- Hook up UI ----------
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

  countrySelect?.addEventListener("change", e => state.country = e.target.value);
  sectorSelect?.addEventListener("change",  e => state.sector  = e.target.value);
  metricSelect?.addEventListener("change",  e => state.metric  = e.target.value);

  refreshBtn?.addEventListener("click", () => applyFilters());

  // District tools
  document.getElementById("districtSearch")?.addEventListener("input", () => {
    if (rawDistrictsGeoJSON) renderDistrictPanel();
  });
  document.getElementById("districtSort")?.addEventListener("change", () => {
    if (rawDistrictsGeoJSON) renderDistrictPanel();
  });

  // Score modal buttons
  document.getElementById("scoreInfoBtn")?.addEventListener("click", openScoreModal);
  document.getElementById("scoreModalClose")?.addEventListener("click", closeScoreModal);
  document.getElementById("scoreModalX")?.addEventListener("click", closeScoreModal);
}

// Initial load
loadGeoJSON(COUNTRIES_POLY)
  .then(geojson => {
    rawGeoJSON = geojson;
    initFilters(rawGeoJSON);
    applyFilters();
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
