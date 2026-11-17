const RISK_ORDER = ["Very Low", "Low", "Medium", "High", "Very High"];
const RISK_COLORS = {
  "Very High": "#b91c1c",
  High: "#ef4444",
  Medium: "#f59e0b",
  Low: "#84cc16",
  "Very Low": "#16a34a",
  "Data pending": "#64748b",
  "No data": "#94a3b8"
};

const METRIC_COPY = {
  gender_hotspot_score: "Composite 0-100 score combining exposure, sensitivity, and adaptive capacity. Higher means a more severe gender hotspot.",
  vulnerability_score: "Weighted 0-100 vulnerability score. Higher values point to places requiring closer adaptation support.",
  exposure: "Climate exposure component from the source workbook, normalized to a 0-100 scale.",
  sensitivity: "Gender and livelihood sensitivity component, normalized to a 0-100 scale.",
  adaptive_capacity: "Capacity component, normalized to a 0-100 scale. Higher capacity can reduce hotspot severity.",
  risk_level: "Risk class derived from the selected score thresholds."
};

const REPORT_METRIC_LABELS = {
  gender_hotspot_score: "Gender hotspot score",
  vulnerability_score: "Vulnerability score",
  exposure: "Exposure",
  sensitivity: "Sensitivity",
  adaptive_capacity: "Adaptive capacity"
};

const AFRICA_BOUNDS = L.latLngBounds(
  L.latLng(-37, -26),
  L.latLng(38, 64)
);

const state = {
  country: "__all__",
  sector: "__all__",
  metric: "gender_hotspot_score",
  risk: "__all__",
  search: "",
  sort: "score_desc"
};

let hotspotData = null;
let boundaries = {};
let map;
let countyLayer;
let markerLayer;
let maskLayer;
let outlineLayer;
let countryOutlines = null;
let selectedRecord = null;
let panelTab = "places";
const layerByKey = new Map();

const WORLD_RING = [[-89, -540], [-89, 540], [89, 540], [89, -540]];

const PAGE_SIZE = 24;
let visibleLimit = PAGE_SIZE;
let lastListKey = "";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function recordKey(record) {
  return `${record.country}::${record.name}`;
}

function recordByKey(key) {
  return Object.values(hotspotData?.records || {}).flat().find((record) => recordKey(record) === key);
}

function placeLabel(countryName) {
  return hotspotData?.countries?.find((country) => country.country === countryName)?.place_label || "County";
}

function adminLabel(countryName) {
  return hotspotData?.countries?.find((country) => country.country === countryName)?.admin_label || "Counties";
}

function formatScore(value) {
  return value == null ? "N/A" : Number(value).toFixed(1);
}

function metricLabel(metric) {
  return REPORT_METRIC_LABELS[metric] || metric.replace(/_/g, " ");
}

function selectedSectorLabel() {
  return state.sector === "__all__" ? "All sectors" : state.sector;
}

function riskRank(risk) {
  return RISK_ORDER.indexOf(risk) + 1;
}

function sectorMetricValues(record, metric) {
  return (hotspotData?.meta?.sectors || [])
    .map((sector) => record?.metrics?.[sector]?.[metric])
    .filter((value) => value != null && Number.isFinite(Number(value)))
    .map(Number);
}

function aggregateMetricForRecord(record, metric) {
  const values = sectorMetricValues(record, metric);
  if (!values.length) return record?.composite_score ?? null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sectorForDisplay(record) {
  if (state.sector !== "__all__") return state.sector;
  return record?.top_sector || hotspotData?.meta?.sectors?.[0] || "Water";
}

function metricForRecord(record, sector = state.sector) {
  if (sector === "__all__") {
    if (state.metric === "risk_level") return record?.risk_level || "No data";
    if (state.metric === "gender_hotspot_score") return record?.composite_score ?? null;
    return aggregateMetricForRecord(record, state.metric);
  }
  const metrics = record?.metrics?.[sector] || {};
  if (state.metric === "risk_level") return metrics.risk_level || record.risk_level || "No data";
  return metrics[state.metric] ?? record.composite_score ?? null;
}

function riskForRecord(record, sector = state.sector) {
  if (sector === "__all__") return record?.risk_level || "No data";
  const metrics = record?.metrics?.[sector] || {};
  return metrics.risk_level || record.risk_level || "No data";
}

function colorForRecord(record) {
  return RISK_COLORS[riskForRecord(record)] || RISK_COLORS["No data"];
}

function colorForCountry(country) {
  return RISK_COLORS[country.risk_level] || RISK_COLORS["Data pending"];
}

function getRecords() {
  if (!hotspotData) return [];
  if (state.country === "__all__") {
    return Object.values(hotspotData.records).flat();
  }
  return hotspotData.records[state.country] || [];
}

function getFilteredRecords() {
  const query = state.search.trim().toLowerCase();
  return getRecords()
    .filter((record) => {
      if (state.risk !== "__all__" && riskForRecord(record) !== state.risk) return false;
      if (query && !record.name.toLowerCase().includes(query)) return false;
      return true;
    })
    .sort((a, b) => {
      if (state.sort === "name_asc") return a.name.localeCompare(b.name);
      if (state.sort === "score_asc") return (Number(metricForRecord(a)) || 0) - (Number(metricForRecord(b)) || 0);
      if (state.sort === "risk_desc") return riskRank(riskForRecord(b)) - riskRank(riskForRecord(a));
      return (Number(metricForRecord(b)) || 0) - (Number(metricForRecord(a)) || 0);
    });
}

function buildOptions(select, values, allLabel) {
  select.innerHTML = "";
  if (allLabel) {
    const option = document.createElement("option");
    option.value = "__all__";
    option.textContent = allLabel;
    select.appendChild(option);
  }
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
}

function initMap() {
  map = L.map("map", {
    zoomControl: false,
    scrollWheelZoom: true,
    minZoom: 3,
    maxZoom: 10,
    maxBounds: AFRICA_BOUNDS,
    maxBoundsViscosity: 1
  }).fitBounds(AFRICA_BOUNDS, { padding: [8, 8] });

  const fallbackLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 10,
    attribution: "&copy; OpenStreetMap contributors"
  });

  const baseLayers = {};

  if (L.gridLayer?.googleMutant && window.google?.maps) {
    const googleRoadmap = L.gridLayer.googleMutant({
      type: "roadmap",
      maxZoom: 10,
      styles: []
    }).addTo(map);
    const googleHybrid = L.gridLayer.googleMutant({
      type: "hybrid",
      maxZoom: 10,
      styles: []
    });
    const googleTerrain = L.gridLayer.googleMutant({
      type: "terrain",
      maxZoom: 10,
      styles: []
    });

    baseLayers["Google Roadmap"] = googleRoadmap;
    baseLayers["Google Hybrid"] = googleHybrid;
    baseLayers["Google Terrain"] = googleTerrain;
    baseLayers["OpenStreetMap fallback"] = fallbackLayer;
  } else {
    fallbackLayer.addTo(map);
    baseLayers["OpenStreetMap"] = fallbackLayer;
  }

  map._usingGoogleBasemap = Boolean(L.gridLayer?.googleMutant && window.google?.maps);
  L.control.layers(baseLayers, null, { collapsed: true }).addTo(map);
  L.control.zoom({ position: "topright" }).addTo(map);

  // Stacking: basemap < focus mask < places < country markers < tooltips and popups.
  map.createPane("focusMask").style.zIndex = 350;
  map.getPane("focusMask").style.pointerEvents = "none";
  map.createPane("countryMarkers").style.zIndex = 450;
  markerLayer = L.layerGroup().addTo(map);
}

// Outer rings ([lat, lng]) of the countries that stay lit: national outlines when available,
// otherwise every sub-national unit.
function focusRings(countries) {
  const rings = [];
  const addGeometry = (geometry) => {
    if (!geometry) return;
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    polygons.forEach((polygon) => rings.push(polygon[0].map(([lng, lat]) => [lat, lng])));
  };
  countries.forEach((country) => {
    const outline = countryOutlines?.features.find((feature) => feature.properties.country === country);
    if (outline) {
      addGeometry(outline.geometry);
    } else {
      (boundaries[country]?.features || []).forEach((feature) => addGeometry(feature.geometry));
    }
  });
  return rings;
}

// Dims everything outside the study countries (or outside the selected country).
function renderFocusMask() {
  if (maskLayer) map.removeLayer(maskLayer);
  if (outlineLayer) map.removeLayer(outlineLayer);
  maskLayer = outlineLayer = null;

  const countries = state.country === "__all__" ? hotspotData.meta.countries : [state.country];
  const rings = focusRings(countries);
  if (!rings.length) return;

  maskLayer = L.polygon([WORLD_RING, ...rings], {
    pane: "focusMask",
    stroke: false,
    fillColor: "#06140f",
    fillOpacity: 0.74,
    fillRule: "evenodd",
    interactive: false
  }).addTo(map);

  outlineLayer = L.polyline(rings.map((ring) => [...ring, ring[0]]), {
    pane: "focusMask",
    color: "#ffffff",
    weight: 1.6,
    opacity: 0.9,
    interactive: false
  }).addTo(map);
}

function countryByName(name) {
  return hotspotData.countries.find((country) => country.country === name);
}

function renderCountryCards() {
  const container = document.getElementById("countryCards");
  const total = hotspotData.countries.reduce((sum, country) => sum + (country.record_count || 0), 0);
  const globe = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
  const tabs = [{ country: "__all__", label: "All countries", count: total, mark: globe, title: "All four study countries" }]
    .concat(hotspotData.countries.map((country) => ({
      country: country.country,
      label: country.country,
      count: country.record_count || 0,
      mark: `<i style="background:${colorForCountry(country)}"></i>`,
      title: `${country.country}: ${country.record_count || 0} ${country.admin_label.toLowerCase()}, average score ${formatScore(country.average_score)} (${country.risk_level || "No data"})`
    })));
  container.innerHTML = tabs.map((tab) => `
    <button class="ma-country-tab ${state.country === tab.country ? "is-active" : ""}" data-country="${escapeHtml(tab.country)}" type="button"
      aria-pressed="${state.country === tab.country}" title="${escapeHtml(tab.title)}">
      ${tab.mark}<span>${escapeHtml(tab.label)}</span><small>${tab.count}</small>
    </button>
  `).join("");

  // Keep the selected country visible when the row scrolls sideways on small screens.
  const active = container.querySelector(".is-active");
  if (active) {
    const overflowRight = active.offsetLeft + active.offsetWidth - (container.scrollLeft + container.clientWidth);
    if (overflowRight > 0) container.scrollLeft += overflowRight + 8;
    else if (active.offsetLeft < container.scrollLeft) container.scrollLeft = Math.max(0, active.offsetLeft - 8);
  }

  container.querySelectorAll("[data-country]").forEach((button) => {
    button.addEventListener("click", () => {
      state.country = button.dataset.country;
      document.getElementById("countrySelect").value = state.country;
      if (selectedRecord) clearSelectedRecord();
      applyState();
    });
  });
}

function popupForCountry(country) {
  return `
    <div class="popup-card">
      <strong>${country.country}</strong>
      <span>${escapeHtml(country.status)}</span>
      <p>${escapeHtml(country.study_note)}</p>
      <dl>
        <dt>Average score</dt><dd>${formatScore(country.average_score)}</dd>
        <dt>Highest hotspot</dt><dd>${country.highest_hotspot || "Awaiting data"}</dd>
        <dt>Top sector</dt><dd>${country.top_sector || "Awaiting data"}</dd>
      </dl>
    </div>
  `;
}

function renderCountryMarkers() {
  markerLayer.clearLayers();
  if (state.country !== "__all__") return;
  hotspotData.countries.forEach((country) => {
    const marker = L.circleMarker(country.center, {
      pane: "countryMarkers",
      radius: 9,
      color: "#ffffff",
      weight: 2,
      fillColor: colorForCountry(country),
      fillOpacity: 0.95
    }).bindPopup(popupForCountry(country));

    marker.on("click", () => {
      state.country = country.country;
      document.getElementById("countrySelect").value = state.country;
      applyState();
    });
    marker.addTo(markerLayer);
  });
}

function countyNameFromFeature(feature) {
  const p = feature.properties || {};
  return p.county || p.district_name || p.name;
}

function recordForFeature(feature) {
  const country = feature.properties?.country;
  const name = countyNameFromFeature(feature);
  return (hotspotData?.records?.[country] || []).find((record) => record.name === name);
}

function styleCounty(feature) {
  const record = recordForFeature(feature);
  const isSelected = Boolean(record && selectedRecord && recordKey(record) === recordKey(selectedRecord));
  return {
    color: isSelected ? "#0f172a" : "#ffffff",
    weight: isSelected ? 2.6 : 1,
    fillColor: record ? colorForRecord(record) : RISK_COLORS["No data"],
    fillOpacity: record ? (isSelected ? 0.92 : 0.8) : 0.2
  };
}

// Number shown as "the score" for a place under the current filters.
function displayScore(record) {
  if (state.metric !== "risk_level") return metricForRecord(record);
  return state.sector === "__all__" ? record.composite_score : record.metrics?.[state.sector]?.gender_hotspot_score;
}

// Text colour that stays readable on each risk colour.
function inkOnRisk(risk) {
  return risk === "Medium" || risk === "Low" ? "#1a1a0a" : "#ffffff";
}

function refreshCountyStyles() {
  if (countyLayer) countyLayer.setStyle(styleCounty);
}

function popupBar(label, value, tone) {
  const number = Number(value);
  const width = Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
  return `
    <div class="popup-bar">
      <span>${escapeHtml(label)}</span>
      <div class="popup-bar-track"><i class="tone-${tone}" style="width:${width}%"></i></div>
      <b>${formatScore(value)}</b>
    </div>
  `;
}

// Small card that follows the pointer while hovering a place.
function hoverCardForRecord(record) {
  const risk = riskForRecord(record);
  return `
    <div class="hover-card">
      <span class="hover-swatch" style="background:${colorForRecord(record)}"></span>
      <div>
        <strong>${escapeHtml(record.name)}</strong>
        <small>${escapeHtml(record.country)} &middot; ${escapeHtml(selectedSectorLabel())}</small>
      </div>
      <div class="hover-score">
        <b>${formatScore(state.metric === "risk_level" ? (state.sector === "__all__" ? record.composite_score : record.metrics?.[state.sector]?.gender_hotspot_score) : metricForRecord(record))}</b>
        <small>${escapeHtml(state.metric === "risk_level" || state.metric === "gender_hotspot_score" ? risk : metricLabel(state.metric))}</small>
      </div>
      <em>Click for overview</em>
    </div>
  `;
}

// Overview shown when a place is clicked; "Read more" opens the full report below the map.
function popupForRecord(record) {
  const activeSector = sectorForDisplay(record);
  const metrics = record.metrics[activeSector] || {};
  const risk = riskForRecord(record);
  const color = RISK_COLORS[risk] || RISK_COLORS["No data"];
  const indicators = (metrics.indicators || []).slice(0, 2).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const key = escapeHtml(recordKey(record));
  return `
    <div class="popup-card">
      <div class="popup-head">
        <div>
          <span class="popup-kicker">${escapeHtml(record.country)} &middot; ${escapeHtml(placeLabel(record.country))}</span>
          <strong>${escapeHtml(record.name)}</strong>
        </div>
        <div class="popup-score" style="background:${color};color:${inkOnRisk(risk)}">
          <b>${formatScore(state.sector === "__all__" ? record.composite_score : metrics.gender_hotspot_score)}</b>
          <small>${escapeHtml(risk)}</small>
        </div>
      </div>
      <p class="popup-meta">
        ${state.sector === "__all__" ? "Composite across sectors" : `${escapeHtml(state.sector)} sector`}
        &middot; strongest pressure: <b>${escapeHtml(record.top_sector || activeSector)}</b>
      </p>
      <div class="popup-bars" aria-label="${escapeHtml(activeSector)} components">
        ${popupBar("Exposure", metrics.exposure, "risk")}
        ${popupBar("Sensitivity", metrics.sensitivity, "risk")}
        ${popupBar("Adaptive capacity", metrics.adaptive_capacity, "good")}
        ${popupBar("Vulnerability", metrics.vulnerability_score, "risk")}
      </div>
      ${indicators ? `<ul>${indicators}</ul>` : ""}
      ${record.data_status === "illustrative" ? '<p class="popup-flag">Illustrative placeholder figures</p>' : ""}
      <button class="popup-action" type="button" data-read-record="${key}">
        Read more
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </button>
    </div>
  `;
}

function narrativeTextValue(narrative, ...keys) {
  for (const key of keys) {
    const value = narrative?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function narrativeListValue(narrative, ...keys) {
  for (const key of keys) {
    const value = narrative?.[key];
    if (Array.isArray(value) && value.filter(Boolean).length) return value.filter(Boolean);
  }
  return [];
}

function narrativeReferences(narrative) {
  const items = Array.isArray(narrative?.references) ? narrative.references : [];
  return items
    .map((item) => {
      if (typeof item === "string" && item.trim()) return { title: item.trim(), url: null };
      if (!item || typeof item !== "object") return null;
      const title = String(item.title || "").trim();
      const url = String(item.url || "").trim() || null;
      return title ? { title, url } : null;
    })
    .filter(Boolean);
}

function metricBar(label, value, tone = "default") {
  const numeric = value == null || !Number.isFinite(Number(value)) ? null : Math.max(0, Math.min(100, Number(value)));
  return `
    <div class="metric-bar metric-bar-${tone}">
      <div class="metric-bar-head">
        <span>${escapeHtml(label)}</span>
        <strong>${numeric == null ? "N/A" : numeric.toFixed(1)}</strong>
      </div>
      <div class="metric-bar-track" aria-hidden="true">
        <span class="metric-bar-fill" style="width:${numeric == null ? 0 : numeric}%;"></span>
      </div>
    </div>
  `;
}

function aiInsightSummary(record) {
  const sector = sectorForDisplay(record);
  const selectedMetrics = record.metrics?.[sector] || {};
  return `
    <div class="ai-insight-summary">
      <article>
        <span>Composite score</span>
        <strong>${formatScore(record.composite_score)}</strong>
        <small>Overall hotspot reading across available sectors.</small>
      </article>
      <article>
        <span>Composite risk</span>
        <strong>${escapeHtml(record.risk_level || "No data")}</strong>
        <small>Current overall risk label used in the map overview.</small>
      </article>
      <article>
        <span>Lead pressure sector</span>
        <strong>${escapeHtml(record.top_sector || "N/A")}</strong>
        <small>Sector with the strongest hotspot signal for this place.</small>
      </article>
      <article>
        <span>${escapeHtml(sector)} hotspot score</span>
        <strong>${formatScore(selectedMetrics.gender_hotspot_score)}</strong>
        <small>Sector-specific hotspot score used for the current detailed reading.</small>
      </article>
    </div>
  `;
}

function aiMetricPanels(record) {
  const sectors = hotspotData?.meta?.sectors || [];
  const selectedSector = sectorForDisplay(record);
  const selectedMetrics = record.metrics?.[selectedSector] || {};
  const sectorBars = sectors.map((sector) => {
    const metrics = record.metrics?.[sector] || {};
    return `
      <div class="ai-sector-row ${sector === selectedSector ? "is-selected" : ""}">
        <div class="ai-sector-labels">
          <strong>${escapeHtml(sector)}</strong>
          <span>${escapeHtml(metrics.risk_level || "No data")}</span>
        </div>
        <div class="ai-sector-bar-track" aria-hidden="true">
          <span class="ai-sector-bar-fill" style="width:${Math.max(0, Math.min(100, Number(metrics.gender_hotspot_score) || 0))}%;"></span>
        </div>
        <em>${formatScore(metrics.gender_hotspot_score)}</em>
      </div>
    `;
  }).join("");

  const dimensionBars = [
    metricBar(metricLabel("gender_hotspot_score"), selectedMetrics.gender_hotspot_score, "primary"),
    metricBar(metricLabel("vulnerability_score"), selectedMetrics.vulnerability_score, "alert"),
    metricBar(metricLabel("exposure"), selectedMetrics.exposure),
    metricBar(metricLabel("sensitivity"), selectedMetrics.sensitivity),
    metricBar(metricLabel("adaptive_capacity"), selectedMetrics.adaptive_capacity, "capacity")
  ].join("");

  return `
    <div class="ai-visual-grid">
      <section class="ai-visual-card">
        <div class="ai-visual-head">
          <h4>Sector comparison</h4>
          <p>Hotspot score across Water, Energy, and Agriculture with the active focus sector clearly labeled.</p>
        </div>
        <div class="ai-sector-bars">
          ${sectorBars}
        </div>
      </section>
      <section class="ai-visual-card">
        <div class="ai-visual-head">
          <h4>${escapeHtml(selectedSector)} metric profile</h4>
          <p>Full labeled reading of the selected sector dimensions used in the hotspot model.</p>
        </div>
        <div class="metric-bar-grid">
          ${dimensionBars}
        </div>
      </section>
    </div>
  `;
}

function referenceListMarkup(references) {
  if (!references.length) return "";
  return `
    <section class="ai-reference-card">
      <h4>Related references</h4>
      <p>Related reports, datasets, and institutional sources surfaced during AI generation.</p>
      <ul class="ai-reference-list">
        ${references.map((reference) => `
          <li>
            ${reference.url
              ? `<a href="${escapeHtml(reference.url)}" target="_blank" rel="noopener">${escapeHtml(reference.title)}</a>`
              : `<span>${escapeHtml(reference.title)}</span>`}
          </li>
        `).join("")}
      </ul>
    </section>
  `;
}

function textBlock(title, text) {
  const value = String(text || "").trim();
  if (!value) return "";
  const paragraphs = value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
  return `
    <article class="report-text-block">
      <h3>${escapeHtml(title)}</h3>
      ${paragraphs}
    </article>
  `;
}

function buildAiNarrativeExportHtml(record, sector, ai) {
  const narrative = ai?.narrative || {};
  const overview = narrativeTextValue(narrative, "overview");
  const localContext = narrativeTextValue(narrative, "local_context", "context");
  const headlineFindings = narrativeListValue(narrative, "headline_findings", "gender_implications");
  const vulnerableGroups = narrativeListValue(narrative, "vulnerable_groups");
  const sectorImplications = narrativeListValue(narrative, "sector_implications", "sector_reading");
  const priorityActions = narrativeListValue(narrative, "priority_actions", "recommended_actions");
  const monitoringSignals = narrativeListValue(narrative, "monitoring_signals");
  const dataCautions = narrativeListValue(narrative, "data_cautions");
  const references = narrativeReferences(narrative);
  const imageHtml = ai?.image_url
    ? `<img src="${escapeHtml(ai.image_url)}" alt="${escapeHtml(ai.image_alt || narrative.image_alt || "AI-generated report image")}" style="width:100%;max-height:360px;object-fit:cover;border-radius:12px;border:1px solid #d8e3da;margin:16px 0;">`
    : "";
  const listSection = (title, items) => {
    const values = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!values.length) return "";
    return `
      <section style="margin-top:18px;">
        <h3 style="margin:0 0 10px;font-size:16px;color:#10231c;">${escapeHtml(title)}</h3>
        <ul style="margin:0;padding-left:20px;color:#4c6158;line-height:1.7;">
          ${values.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      </section>
    `;
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(record.name)} ${escapeHtml(sector)} AI Report</title>
</head>
<body style="margin:0;background:#f4f7f2;color:#10231c;font:15px/1.65 Inter, Arial, sans-serif;">
  <main style="max-width:920px;margin:0 auto;padding:32px 24px 48px;">
    <section style="padding:28px;border:1px solid #d8e3da;border-radius:18px;background:#ffffff;">
      <span style="display:inline-block;padding:6px 10px;border-radius:999px;background:#eef5ed;color:#176b4d;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;">AI Insight Brief</span>
      <h1 style="margin:14px 0 10px;font-size:28px;line-height:1.2;">${escapeHtml(record.name)} ${escapeHtml(sector)} Narrative</h1>
      <p style="margin:0;color:#607269;">Generated from dashboard metrics with broader public context for policy, research, and programme use.</p>
      ${imageHtml}
      <section style="margin-top:18px;">
        <h2 style="margin:0 0 10px;font-size:18px;color:#10231c;">Executive overview</h2>
        <p style="margin:0;color:#4c6158;white-space:pre-wrap;">${escapeHtml(overview)}</p>
      </section>
      <section style="margin-top:18px;">
        <h2 style="margin:0 0 10px;font-size:18px;color:#10231c;">Local context</h2>
        <p style="margin:0;color:#4c6158;white-space:pre-wrap;">${escapeHtml(localContext)}</p>
      </section>
      ${listSection("Headline findings", headlineFindings)}
      ${listSection("Vulnerable groups", vulnerableGroups)}
      ${listSection("Sector implications", sectorImplications)}
      ${listSection("Priority actions", priorityActions)}
      ${listSection("Monitoring signals", monitoringSignals)}
      ${listSection("Data cautions", dataCautions)}
      ${references.length ? `
        <section style="margin-top:18px;">
          <h3 style="margin:0 0 10px;font-size:16px;color:#10231c;">Related references</h3>
          <ul style="margin:0;padding-left:20px;color:#4c6158;line-height:1.7;">
            ${references.map((reference) => `
              <li>${reference.url
                ? `<a href="${escapeHtml(reference.url)}" style="color:#176b4d;">${escapeHtml(reference.title)}</a>`
                : escapeHtml(reference.title)}</li>
            `).join("")}
          </ul>
        </section>
      ` : ""}
    </section>
  </main>
</body>
</html>`;
}

function downloadAiNarrative(key) {
  const record = recordByKey(key);
  if (!record || state.sector === "__all__") return;
  const ai = record.ai_narratives?.[state.sector];
  if (!ai) return;

  const html = buildAiNarrativeExportHtml(record, state.sector, ai);
  const safeName = `${record.country}_${record.name}_${state.sector}_ai_report`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeName || "ai_report"}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const DRIVER_ACTIONS = {
  Water: {
    exposure: "Prioritise drought- and flood-resilient water sources (protected boreholes, storage, rainwater harvesting) sited with women's user groups.",
    sensitivity: "Shorten collection distances with nearer water points and household connections, and track women's and girls' collection time as a programme result.",
    capacity: "Expand safe water coverage and put women on water committees with real say over tariffs, siting, and maintenance budgets."
  },
  Energy: {
    exposure: "Protect energy supply chains and woodland resources from climate shocks, and plan for clean-fuel access during drought and flood periods.",
    sensitivity: "Reduce firewood dependence through improved cookstoves, LPG and biogas access, and woodlot schemes managed by women's groups.",
    capacity: "Scale grid, mini-grid, and solar connections with financing women can access, and open energy-sector jobs and enterprise support to women."
  },
  Agriculture: {
    exposure: "Roll out climate information services, drought-tolerant seed, and small-scale irrigation that reach women farmers directly.",
    sensitivity: "Diversify women's income beyond rain-fed farming through value addition, market access, and off-farm enterprise support.",
    capacity: "Strengthen women's land rights through joint titling and registration, and link secure tenure to credit, inputs, and extension."
  }
};

function leadDriver(metrics) {
  const drivers = [
    { key: "exposure", label: "climate exposure", value: metrics.exposure },
    { key: "sensitivity", label: "gendered sensitivity", value: metrics.sensitivity },
    { key: "capacity", label: "low adaptive capacity", value: metrics.adaptive_capacity == null ? null : 100 - metrics.adaptive_capacity }
  ].filter((driver) => driver.value != null && Number.isFinite(Number(driver.value)));
  if (!drivers.length) return null;
  return drivers.sort((a, b) => b.value - a.value)[0];
}

function dataSourceSentence(record) {
  if (record.data_status === "illustrative") {
    return `Figures for ${record.name} are illustrative placeholders, not survey results. They are replaced when the ${record.country} sector workbooks are uploaded.`;
  }
  if (record.data_status === "uploaded") {
    return "Figures come from sector workbooks uploaded through the admin dashboard.";
  }
  return "Figures come from the supplied water, energy, and agriculture sector workbooks.";
}

function listItems(items) {
  const values = Array.isArray(items) ? items : [];
  return values.length ? `<ul>${values.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";
}

function aiNarrativeSections(record) {
  if (state.sector === "__all__") {
    return `
      <article class="ai-narrative-card">
        <div>
          <span class="card-kicker">AI ${escapeHtml(placeLabel(record.country).toLowerCase())} report</span>
          <h3>Select a sector to generate an AI report</h3>
          <p>
            AI report generation is available for a specific sector. Switch from <strong>All sectors</strong>
            to Water, Energy, or Agriculture to generate or review the report for ${escapeHtml(record.name)}.
          </p>
        </div>
      </article>
    `;
  }
  const ai = record.ai_narratives?.[state.sector];
  if (!ai) {
    return `
      <article class="ai-narrative-card" data-ai-card>
        <div>
          <span class="card-kicker">AI ${escapeHtml(placeLabel(record.country).toLowerCase())} report</span>
          <h3>Generate a professional ${escapeHtml(placeLabel(record.country).toLowerCase())} report</h3>
          <p>
            No AI report has been generated for ${escapeHtml(record.name)} and ${escapeHtml(state.sector)} yet.
            Use AI to draft a readable report using the hotspot metrics and wider public context.
          </p>
        </div>
        <button class="button button-primary" type="button" data-generate-ai="${escapeHtml(recordKey(record))}">Generate AI report</button>
        <small>The AI report is cached after generation and does not expose external website links in the public report.</small>
      </article>
    `;
  }

  const narrative = ai.narrative || {};
  const overview = narrativeTextValue(narrative, "overview");
  const localContext = narrativeTextValue(narrative, "local_context", "context");
  const headlineFindings = narrativeListValue(narrative, "headline_findings", "gender_implications");
  const vulnerableGroups = narrativeListValue(narrative, "vulnerable_groups");
  const sectorImplications = narrativeListValue(narrative, "sector_implications", "sector_reading");
  const priorityActions = narrativeListValue(narrative, "priority_actions", "recommended_actions");
  const monitoringSignals = narrativeListValue(narrative, "monitoring_signals");
  const dataCautions = narrativeListValue(narrative, "data_cautions");
  const references = narrativeReferences(narrative);
  return `
    <article class="ai-narrative-card ai-narrative-card-ready" data-ai-card>
      <div class="ai-narrative-head">
        <div>
          <span class="card-kicker">AI ${escapeHtml(placeLabel(record.country).toLowerCase())} report</span>
          <h3>${escapeHtml(record.name)} ${escapeHtml(state.sector)} report</h3>
          <p>Generated from dashboard metrics with broader public context and organized for decision-ready reading. No external website links are shown in this reader view.</p>
        </div>
        <div class="ai-narrative-actions">
          <button class="button button-secondary" type="button" data-download-ai="${escapeHtml(recordKey(record))}">Download report</button>
          <button class="button button-secondary" type="button" data-generate-ai="${escapeHtml(recordKey(record))}" data-force-ai="1">Regenerate</button>
        </div>
      </div>
      ${aiInsightSummary(record)}
      ${aiMetricPanels(record)}
      ${ai.image_url ? `<img class="ai-report-image" src="${escapeHtml(ai.image_url)}" alt="${escapeHtml(ai.image_alt || narrative.image_alt || "AI-generated report image")}">` : ""}
      ${textBlock("Executive overview", overview)}
      ${textBlock("Local context", localContext)}
      <div class="ai-report-grid">
        <section>
          <h4>Headline findings</h4>
          ${listItems(headlineFindings)}
        </section>
        <section>
          <h4>Vulnerable groups</h4>
          ${listItems(vulnerableGroups)}
        </section>
        <section>
          <h4>Sector implications</h4>
          ${listItems(sectorImplications)}
        </section>
        <section>
          <h4>Priority actions</h4>
          ${listItems(priorityActions)}
        </section>
        <section>
          <h4>Monitoring signals</h4>
          ${listItems(monitoringSignals)}
        </section>
        <section>
          <h4>Data cautions</h4>
          ${listItems(dataCautions)}
        </section>
      </div>
      ${referenceListMarkup(references)}
    </article>
  `;
}

function documentSections(record) {
  const docs = record.documents || [];
  if (!docs.length) {
    return `
      <article class="document-empty">
        <h3>Documents</h3>
        <p>No PDFs have been attached yet. Admins can upload documents, evidence notes, and full reports from the admin dashboard.</p>
      </article>
    `;
  }

  return `
    <article class="document-list">
      <h3>Attached PDF documents</h3>
      <div>
        ${docs.map((doc) => `
          <a href="${escapeHtml(doc.url)}" target="_blank" rel="noopener">
            <strong>${escapeHtml(doc.title)}</strong>
            <span>${escapeHtml(doc.sector || "All sectors")} - ${escapeHtml(doc.original_filename || "PDF document")}</span>
          </a>
        `).join("")}
      </div>
    </article>
  `;
}

function selectRecord(key, focusPanel = true) {
  const record = recordByKey(key);
  if (!record) return;
  selectedRecord = record;

  const activeSector = sectorForDisplay(record);
  const metrics = record.metrics[activeSector] || {};
  const risk = riskForRecord(record);
  const place = placeLabel(record.country);
  const overview = document.getElementById("countyOverview");
  document.getElementById("overviewKicker").textContent = `${record.country} · ${place}${record.data_status === "illustrative" ? " · illustrative data" : ""}`;
  document.getElementById("overviewBack").textContent = `All ${adminLabel(record.country).toLowerCase()}`;
  document.getElementById("overviewTitle").textContent = record.name;
  document.getElementById("overviewScore").textContent = formatScore(displayScore(record));
  document.getElementById("overviewRisk").textContent = risk;
  const scoreBox = document.getElementById("overviewScoreBox");
  scoreBox.style.background = RISK_COLORS[risk] || RISK_COLORS["No data"];
  scoreBox.style.color = inkOnRisk(risk);
  document.getElementById("overviewSummary").textContent =
    state.sector === "__all__"
      ? `${record.name} is classed as ${risk} overall across the three sectors. ${activeSector} is its strongest pressure.`
      : `${record.name} is classed as ${risk} for ${state.sector}. The full report compares all three sectors.`;

  const indicators = (metrics.indicators || []).slice(0, 3).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  document.getElementById("overviewGrid").innerHTML = `
    <div class="ma-facts">
      <div><span>Strongest pressure</span><strong>${escapeHtml(record.top_sector || "N/A")}</strong></div>
      <div><span>Vulnerability</span><strong>${formatScore(metrics.vulnerability_score)}</strong></div>
    </div>
    <h3>${escapeHtml(activeSector)} components</h3>
    <div class="popup-bars">
      ${popupBar("Exposure", metrics.exposure, "risk")}
      ${popupBar("Sensitivity", metrics.sensitivity, "risk")}
      ${popupBar("Adaptive capacity", metrics.adaptive_capacity, "good")}
    </div>
    <h3>Hotspot score by sector</h3>
    <div class="popup-bars">
      ${hotspotData.meta.sectors.map((sector) => popupBar(sector, record.metrics?.[sector]?.gender_hotspot_score, "brand")).join("")}
    </div>
    ${indicators ? `<h3>Key indicators</h3><ul>${indicators}</ul>` : ""}
  `;
  overview.hidden = false;
  setDetailMode(true);

  document.querySelectorAll("[data-record-name]").forEach((row) => {
    row.classList.toggle("is-selected", row.dataset.recordName === recordKey(record));
  });

  refreshCountyStyles();
  if (focusPanel) {
    setPanelCollapsed(false);
    overview.scrollTop = 0;
  }
  syncUrl();
}

function setDetailMode(isFocused) {
  const panel = document.getElementById("sidePanel");
  if (!panel) return;
  panel.dataset.mode = isFocused ? "detail" : panelTab;
  panel.querySelectorAll("[data-panel-tab]").forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.panelTab === panelTab));
  });
}

function setPanelCollapsed(collapsed) {
  const app = document.getElementById("mapApp");
  if (!app || app.classList.contains("is-collapsed") === collapsed) return;
  app.classList.toggle("is-collapsed", collapsed);
  document.getElementById("panelToggle")?.setAttribute("aria-expanded", String(!collapsed));
  window.setTimeout(() => map && map.invalidateSize(), 260);
}

function closeReport() {
  closeSectionChooser();
  document.getElementById("fullReport")?.remove();
  const overlay = document.getElementById("reportOverlay");
  if (overlay) overlay.hidden = true;
  document.body.classList.remove("has-report-open");
  syncUrl();
}

// Zooms the map to one place (used when a place is picked from the list or a link).
function focusPlaceOnMap(key) {
  const layer = layerByKey.get(key);
  if (!layer || !map) return;
  map.fitBounds(layer.getBounds(), { maxZoom: 7, padding: [70, 70] });
}

function setListHover(key, isOn) {
  const layer = layerByKey.get(key);
  if (!layer) return;
  if (isOn) {
    layer.setStyle({ weight: 3, color: "#ffffff", fillOpacity: 0.97 });
    layer.bringToFront();
    layer.getElement()?.classList.add("is-hovered");
  } else {
    layer.getElement()?.classList.remove("is-hovered");
    if (countyLayer) countyLayer.resetStyle(layer);
  }
}

function clearSelectedRecord() {
  selectedRecord = null;
  const overview = document.getElementById("countyOverview");
  if (overview) overview.hidden = true;
  closeReport();
  setDetailMode(false);
  document.querySelectorAll("[data-record-name]").forEach((row) => row.classList.remove("is-selected"));
  refreshCountyStyles();
  if (map) map.closePopup();
  syncUrl();
}

const COMPONENT_HELP = {
  exposure: "Climate hazards such as drought, flood, and heat",
  sensitivity: "How far women's work and income depend on this resource",
  adaptive_capacity: "Access and assets that help women cope. Higher is better"
};
const SCORE_THRESHOLDS = [20, 40, 60, 75];
let countryReportSort = { key: "composite", dir: -1 };

function riskChip(risk) {
  const label = risk || "No data";
  return `<span class="rp-chip"><i style="background:${RISK_COLORS[label] || RISK_COLORS["No data"]}"></i>${escapeHtml(label)}</span>`;
}

function scoreMeter(value, tone = "") {
  const number = Number(value);
  const width = Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
  const ticks = SCORE_THRESHOLDS.map((mark) => `<b style="left:${mark}%"></b>`).join("");
  return `<span class="rp-meter ${tone}" role="img" aria-label="${formatScore(value)} out of 100"><i style="width:${width}%"></i>${ticks}</span>`;
}

function average(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function countryRecords(country) {
  return hotspotData.records?.[country] || [];
}

function sectorAverage(country, sector) {
  return average(countryRecords(country).map((item) => item.metrics?.[sector]?.gender_hotspot_score).filter((value) => value != null));
}

function rankInCountry(record) {
  const peers = countryRecords(record.country)
    .filter((item) => item.composite_score != null)
    .sort((a, b) => b.composite_score - a.composite_score);
  return { rank: peers.findIndex((item) => item.name === record.name) + 1, total: peers.length };
}

function dataStatusLabel(record) {
  if (record.data_status === "illustrative") return "Illustrative";
  if (record.data_status === "uploaded") return "Uploaded workbook";
  return "Sector workbooks";
}

// Keys match ALL_SECTIONS, COUNTRY_SECTIONS and PLACE_SECTIONS in exports.py.
const EXPORT_PARTS = {
  all: [
    ["summary", "Regional summary"],
    ["countries", "Country comparison"],
    ["sectors", "Sector averages by country"],
    ["hotspots", "Highest hotspots in each country"],
    ["table", "Full table of all places"],
    ["guide", "Reading guide and data source"]
  ],
  country: [
    ["summary", "Country summary"],
    ["sectors", "Sector averages and risk mix"],
    ["table", "Full table of places"],
    ["guide", "Reading guide and data source"]
  ],
  place: [
    ["summary", "Headline score and summary"],
    ["sectors", "Sector breakdown and indicators"],
    ["priorities", "Suggested priorities"],
    ["figures", "Table of all figures"],
    ["analysis", "Written analysis and documents"],
    ["guide", "Reading guide and data source"]
  ]
};

const EXPORT_ICONS = {
  pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  view: '<path d="M2 12s3.600-7 10-7 10 7 10 7-3.600 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  share: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  xlsx: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>'
};

const EXPORT_NOTES = {
  all: {
    label: () => "All four study countries",
    pdf: "Print-ready A4 regional report. Choose which sections to include.",
    xlsx: "Summary, country comparison, and every place with all sector figures.",
    share: "Copy a link to the all-countries view."
  },
  country: {
    label: (context) => `${context.country}: all ${adminLabel(context.country).toLowerCase()}`,
    pdf: "Print-ready A4 country report. Choose which sections to include.",
    xlsx: "Summary and every place with all sector figures.",
    share: "Copy a link that opens this country's data table."
  },
  place: {
    label: (context) => `${context.place}, ${context.country}`,
    pdf: "Print-ready A4 place report. Choose which sections to include.",
    xlsx: "Summary, sector figures, indicators, and priorities.",
    share: "Copy a link that opens this place's report."
  }
};

function exportMenuItem(action, title, note) {
  return `
    <button type="button" role="menuitem" data-export="${action}">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.800" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EXPORT_ICONS[action]}</svg>
      <span><strong>${title}</strong><small>${note}</small></span>
    </button>`;
}

function exportMenuMarkup(context) {
  const notes = EXPORT_NOTES[context.kind];
  return `
    <div class="rp-export-scope"><span>Exporting</span><strong>${escapeHtml(notes.label(context))}</strong></div>
    ${exportMenuItem("pdf", "PDF report", notes.pdf)}
    ${exportMenuItem("view", "View PDF", "Open the full PDF here to read or print.")}
    ${exportMenuItem("share", "Share link", notes.share)}
    ${exportMenuItem("xlsx", "Excel workbook", notes.xlsx)}
  `;
}

// The same Export control is used in the top bar (current view) and in an open report.
function exportControl(scope) {
  return `
    <div class="rp-export" data-export-scope="${scope}">
      <button class="button button-primary" type="button" data-export-toggle aria-haspopup="true" aria-expanded="false">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>
        <span>Export</span>
        <svg class="rp-export-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.400" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="rp-export-menu" role="menu" hidden></div>
    </div>`;
}

function reportShell(kicker, title, body) {
  return `
    <div class="full-report-head">
      <div>
        <span class="rp-eyebrow">${kicker}</span>
        <h2>${title}</h2>
      </div>
      <div class="rp-actions">
        ${exportControl("report")}
        <button class="button button-secondary" type="button" data-close-report>Close</button>
      </div>
    </div>
    ${body}
  `;
}

// What an Export control acts on: { kind: "all" | "country" | "place", country, place }.
function exportContext(scope) {
  if (scope === "report") {
    const report = document.getElementById("fullReport");
    if (report?.dataset.place) {
      const record = recordByKey(report.dataset.place);
      if (record) return { kind: "place", country: record.country, place: record.name };
    }
    if (report?.dataset.country) return { kind: "country", country: report.dataset.country };
  }
  if (selectedRecord) return { kind: "place", country: selectedRecord.country, place: selectedRecord.name };
  if (state.country !== "__all__") return { kind: "country", country: state.country };
  return { kind: "all" };
}

function exportUrl(context, format, sections, inline = false) {
  const params = new URLSearchParams();
  if (context.country) params.set("country", context.country);
  if (context.place) params.set("place", context.place);
  if (sections && sections.length) params.set("sections", sections.join(","));
  if (inline) params.set("inline", "1");
  const query = params.toString();
  return `/export/${context.kind}.${format}${query ? `?${query}` : ""}`;
}

function shareUrl(context) {
  const params = new URLSearchParams();
  if (context.country) params.set("country", context.country);
  if (context.place) params.set("place", context.place);
  else if (context.kind === "country") params.set("report", "country");
  const query = params.toString();
  return `${window.location.origin}${window.location.pathname}${query ? `?${query}` : ""}`;
}

function startDownload(url) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function closeExportMenus() {
  document.querySelectorAll(".rp-export-menu").forEach((menu) => { menu.hidden = true; });
  document.querySelectorAll("[data-export-toggle]").forEach((toggle) => toggle.setAttribute("aria-expanded", "false"));
}

function toggleExportMenu(control) {
  const menu = control.querySelector(".rp-export-menu");
  const willOpen = menu.hidden;
  closeExportMenus();
  if (!willOpen) return;
  menu.innerHTML = exportMenuMarkup(exportContext(control.dataset.exportScope));
  menu.hidden = false;
  control.querySelector("[data-export-toggle]").setAttribute("aria-expanded", "true");
}

let chooserContext = null;

function closeSectionChooser() {
  document.getElementById("sectionChooser")?.remove();
  chooserContext = null;
}

function updateChooserCount() {
  const chooser = document.getElementById("sectionChooser");
  if (!chooser) return;
  const boxes = [...chooser.querySelectorAll("input[type=checkbox]")];
  const chosen = boxes.filter((box) => box.checked).length;
  chooser.querySelector("[data-chooser-count]").textContent = `${chosen} of ${boxes.length} selected`;
  chooser.querySelector("[data-chooser-download]").disabled = chosen === 0;
}

function openSectionChooser(context) {
  closeSectionChooser();
  chooserContext = context;
  const parts = EXPORT_PARTS[context.kind];
  const chooser = document.createElement("div");
  chooser.id = "sectionChooser";
  chooser.className = "rp-chooser";
  chooser.innerHTML = `
    <div class="rp-chooser-backdrop" data-chooser-cancel></div>
    <div class="rp-chooser-card" role="dialog" aria-modal="true" aria-labelledby="chooserTitle">
      <h3 id="chooserTitle">Choose what to include</h3>
      <p><strong>${escapeHtml(EXPORT_NOTES[context.kind].label(context))}.</strong> This PDF has ${parts.length} parts. Untick the ones you do not need.</p>
      <div class="rp-chooser-tools">
        <button type="button" data-chooser-all>Select all</button>
        <button type="button" data-chooser-clear>Clear</button>
        <span data-chooser-count></span>
      </div>
      <div class="rp-chooser-list">
        ${parts.map(([key, label]) => `<label><input type="checkbox" value="${key}" checked><span>${escapeHtml(label)}</span></label>`).join("")}
      </div>
      <div class="rp-chooser-foot">
        <button class="button button-secondary" type="button" data-chooser-cancel>Cancel</button>
        <button class="button button-primary" type="button" data-chooser-download>Download selected</button>
      </div>
    </div>
  `;
  document.body.appendChild(chooser);
  chooser.addEventListener("change", updateChooserCount);
  updateChooserCount();
  chooser.querySelector("input")?.focus();
}

async function handleExportAction(action, control) {
  const context = exportContext(control.dataset.exportScope);
  closeExportMenus();
  if (action === "pdf") {
    openSectionChooser(context);
  } else if (action === "view") {
    window.open(exportUrl(context, "pdf", null, true), "_blank", "noopener");
  } else if (action === "xlsx") {
    startDownload(exportUrl(context, "xlsx"));
  } else if (action === "share") {
    const url = shareUrl(context);
    const label = control.querySelector("[data-export-toggle] span");
    try {
      await navigator.clipboard.writeText(url);
      if (label) {
        label.textContent = "Link copied";
        window.setTimeout(() => { label.textContent = "Export"; }, 1800);
      }
    } catch (error) {
      window.prompt("Copy this link", url);
    }
  }
}

function sectionHead(eyebrow, title, note) {
  return `
    <header class="rp-section-head">
      <div><span class="rp-eyebrow">${escapeHtml(eyebrow)}</span><h3>${escapeHtml(title)}</h3></div>
      ${note ? `<p>${escapeHtml(note)}</p>` : ""}
    </header>
  `;
}

function placeHero(record) {
  const { rank, total } = rankInCountry(record);
  const admin = adminLabel(record.country).toLowerCase();
  const countryAverage = average(countryRecords(record.country).map((item) => item.composite_score).filter((value) => value != null));
  const summary = [
    `${record.name} scores ${formatScore(record.composite_score)} out of 100, which places it in the ${record.risk_level} risk class.`,
    rank ? `It ranks ${rank} of ${total} ${admin} in ${record.country}, where 1 is the most severe hotspot.` : "",
    record.top_sector ? `${record.top_sector} is the sector under the most pressure.` : ""
  ].filter(Boolean).join(" ");
  return `
    <section class="rp-hero">
      <div class="rp-hero-score">
        <span>Composite gender hotspot score</span>
        <strong>${formatScore(record.composite_score)}<small>/ 100</small></strong>
        ${scoreMeter(record.composite_score, "is-light")}
        <div class="rp-hero-scale"><span>0</span><span>Low 20</span><span>Medium 40</span><span>High 60</span><span>Very high 75</span></div>
      </div>
      <div class="rp-hero-copy">
        ${riskChip(record.risk_level)}
        <p>${escapeHtml(summary)}</p>
      </div>
      <dl class="rp-hero-facts">
        <div><dt>Rank in ${escapeHtml(record.country)}</dt><dd>${rank ? `${rank} <small>of ${total}</small>` : "N/A"}</dd></div>
        <div><dt>${escapeHtml(record.country)} average</dt><dd>${formatScore(countryAverage)}</dd></div>
        <div><dt>Strongest pressure</dt><dd>${escapeHtml(record.top_sector || "N/A")}</dd></div>
        <div><dt>Data source</dt><dd>${escapeHtml(dataStatusLabel(record))}</dd></div>
      </dl>
    </section>
  `;
}

function indicatorRows(indicators) {
  return (indicators || []).map((item) => {
    const text = String(item);
    const split = text.indexOf(": ");
    return split > 0
      ? `<div><dt>${escapeHtml(text.slice(0, split))}</dt><dd>${escapeHtml(text.slice(split + 2))}</dd></div>`
      : `<div><dt>${escapeHtml(text)}</dt><dd></dd></div>`;
  }).join("");
}

function placeSectors(record) {
  const cards = hotspotData.meta.sectors.map((sector) => {
    const metrics = record.metrics?.[sector];
    if (!metrics || metrics.gender_hotspot_score == null) {
      return `<article class="rp-sector"><header><h4>${escapeHtml(sector)}</h4>${riskChip("No data")}</header><p class="rp-muted">No figures have been loaded for this sector yet.</p></article>`;
    }
    const driver = leadDriver(metrics);
    const sectorMean = sectorAverage(record.country, sector);
    const gap = sectorMean == null ? null : metrics.gender_hotspot_score - sectorMean;
    const component = (key, label, tone) => `
      <div class="rp-component">
        <div><strong>${label}</strong><span>${COMPONENT_HELP[key]}</span></div>
        ${scoreMeter(metrics[key], tone)}
        <b>${formatScore(metrics[key])}</b>
      </div>`;
    return `
      <article class="rp-sector ${record.top_sector === sector ? "is-top" : ""}">
        <header>
          <div>
            <h4>${escapeHtml(sector)}</h4>
            ${record.top_sector === sector ? '<span class="rp-tag">Strongest pressure</span>' : ""}
          </div>
          <div class="rp-sector-score"><strong>${formatScore(metrics.gender_hotspot_score)}</strong>${riskChip(metrics.risk_level)}</div>
        </header>
        <p class="rp-compare">
          ${gap == null ? "" : `<b class="${gap > 0 ? "is-worse" : "is-better"}">${gap > 0 ? "+" : ""}${gap.toFixed(1)}</b> against the ${escapeHtml(record.country)} average of ${formatScore(sectorMean)}.`}
          ${driver ? ` Main driver: <b>${escapeHtml(driver.label)}</b>.` : ""}
        </p>
        <div class="rp-components">
          ${component("exposure", "Exposure", "is-risk")}
          ${component("sensitivity", "Sensitivity", "is-risk")}
          ${component("adaptive_capacity", "Adaptive capacity", "is-good")}
        </div>
        ${(metrics.indicators || []).length ? `<dl class="rp-indicators">${indicatorRows(metrics.indicators)}</dl>` : ""}
      </article>
    `;
  }).join("");
  return `
    <section class="rp-section">
      ${sectionHead("Sector by sector", "Where the pressure comes from", "Each sector has its own 0 to 100 hotspot score, built from exposure, sensitivity, and adaptive capacity.")}
      <div class="rp-sector-grid">${cards}</div>
    </section>
  `;
}

function placePriorities(record) {
  const sectors = hotspotData.meta.sectors
    .filter((sector) => record.metrics?.[sector]?.gender_hotspot_score != null)
    .sort((a, b) => record.metrics[b].gender_hotspot_score - record.metrics[a].gender_hotspot_score);
  const items = sectors.map((sector) => {
    const driver = leadDriver(record.metrics[sector]);
    const action = driver ? DRIVER_ACTIONS[sector]?.[driver.key] : "";
    return action ? `
      <li>
        <span class="rp-step"></span>
        <div>
          <strong>${escapeHtml(sector)} <small>${formatScore(record.metrics[sector].gender_hotspot_score)} &middot; ${escapeHtml(record.metrics[sector].risk_level)}</small></strong>
          <p>${escapeHtml(action)}</p>
          <em>Suggested because the main driver is ${escapeHtml(driver.label)}.</em>
        </div>
      </li>` : "";
  }).join("");
  if (!items) return "";
  return `
    <section class="rp-section">
      ${sectionHead("Suggested priorities", "Where to act first", "Ordered from the highest sector score. These are starting points drawn from the figures, not a full programme design.")}
      <ol class="rp-priorities">${items}</ol>
    </section>
  `;
}

function placeTable(record) {
  const cell = (value) => `<td class="is-number">${formatScore(value)}</td>`;
  const rows = hotspotData.meta.sectors.map((sector) => {
    const metrics = record.metrics?.[sector] || {};
    return `<tr><th scope="row">${escapeHtml(sector)}</th>${cell(metrics.gender_hotspot_score)}<td>${riskChip(metrics.risk_level)}</td>${cell(metrics.vulnerability_score)}${cell(metrics.exposure)}${cell(metrics.sensitivity)}${cell(metrics.adaptive_capacity)}</tr>`;
  }).join("");
  return `
    <section class="rp-section">
      ${sectionHead("All figures", "The numbers behind this report", "All values are on a 0 to 100 scale.")}
      <div class="rp-table-wrap">
        <table class="rp-table">
          <thead><tr><th scope="col">Sector</th><th scope="col" class="is-number">Hotspot score</th><th scope="col">Risk class</th><th scope="col" class="is-number">Vulnerability</th><th scope="col" class="is-number">Exposure</th><th scope="col" class="is-number">Sensitivity</th><th scope="col" class="is-number">Adaptive capacity</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><th scope="row">Composite</th><td class="is-number">${formatScore(record.composite_score)}</td><td>${riskChip(record.risk_level)}</td><td colspan="4" class="rp-muted">Average of the three sector hotspot scores</td></tr></tfoot>
        </table>
      </div>
    </section>
  `;
}

function readingGuide(statusText, isIllustrative) {
  return `
    <section class="rp-section">
      ${sectionHead("Reading guide", "How to read these figures", "")}
      <div class="rp-guide">
        <article>
          <h4>What the score means</h4>
          <p>The hotspot score is the average of exposure, sensitivity, and the gap in adaptive capacity (100 minus capacity). A higher score means climate pressure and gender vulnerability combine more severely.</p>
          <ul class="rp-classes">
            ${[...RISK_ORDER].reverse().map((risk, index) => `<li>${riskChip(risk)}<span>${["75 and above", "60 to 74", "40 to 59", "20 to 39", "Below 20"][index]}</span></li>`).join("")}
          </ul>
        </article>
        <article class="${isIllustrative ? "is-caution" : ""}">
          <h4>${isIllustrative ? "Illustrative data" : "Data source"}</h4>
          <p>${escapeHtml(statusText)}</p>
          <p>Scores compare places within the study. They show where to look first and do not replace local assessment.</p>
          <a class="text-link" href="/methodology">Read the full methodology</a>
        </article>
      </div>
    </section>
  `;
}

function publishedAnalysis(record) {
  const reports = record.reports || [];
  const published = reports.map((report) => `
    <article class="report-narrative">
      <div>
        <span class="rp-eyebrow">${escapeHtml(report.sector || "All sectors")}</span>
        <h3>${escapeHtml(report.title)}</h3>
      </div>
      ${textBlock("Overview", report.overview)}
      ${textBlock("Key findings", report.findings)}
      ${textBlock("Recommendations", report.recommendations)}
      ${textBlock("Methodology and notes", report.methodology)}
    </article>
  `).join("");
  return `
    <section class="rp-section">
      ${sectionHead("Analysis and documents", "Written analysis for this place", "Reports published by the AGNES team, AI-drafted narratives, and attached documents.")}
      <div class="rp-analysis">
        ${published}
        ${aiNarrativeSections(record)}
        ${documentSections(record)}
      </div>
    </section>
  `;
}

function openReport(html) {
  const existing = document.getElementById("fullReport");
  const section = document.createElement("section");
  section.id = "fullReport";
  section.className = "full-report rp";
  section.innerHTML = html;
  const host = document.getElementById("reportHost");
  const previousScroll = existing ? host.scrollTop : 0;
  host.replaceChildren(section);
  document.getElementById("reportOverlay").hidden = false;
  document.body.classList.add("has-report-open");
  host.scrollTop = previousScroll;
  host.focus({ preventScroll: true });
  return section;
}

function renderFullReport(record = selectedRecord) {
  if (!record) return;
  const previous = document.getElementById("fullReport");
  const samePlace = previous?.dataset.place === recordKey(record);
  const place = placeLabel(record.country);
  const section = openReport(reportShell(
    `${escapeHtml(record.country)} &middot; ${escapeHtml(place)} report${record.zone ? ` &middot; ${escapeHtml(record.zone)}` : ""}`,
    escapeHtml(record.name),
    placeHero(record)
      + placeSectors(record)
      + placePriorities(record)
      + placeTable(record)
      + publishedAnalysis(record)
      + readingGuide(dataSourceSentence(record), record.data_status === "illustrative")
  ));
  section.dataset.place = recordKey(record);
  if (!samePlace) document.getElementById("reportHost").scrollTop = 0;
}

// Country-level data table: every place in the country with its sector scores.
function renderCountryReport(countryName = state.country) {
  const country = countryByName(countryName);
  if (!country) return;
  const records = countryRecords(countryName);
  const sectors = hotspotData.meta.sectors;
  const value = (record, key) => key === "composite" ? record.composite_score
    : key === "name" ? record.name
    : key === "risk" ? riskRank(record.risk_level)
    : record.metrics?.[key]?.gender_hotspot_score;
  const { key, dir } = countryReportSort;
  const sorted = [...records].sort((a, b) => {
    const left = value(a, key);
    const right = value(b, key);
    if (key === "name") return dir * String(left).localeCompare(String(right));
    return dir * ((Number(left) || 0) - (Number(right) || 0));
  });
  const admin = country.admin_label.toLowerCase();
  const mean = average(records.map((item) => item.composite_score).filter((item) => item != null));
  const priority = records.filter((item) => ["High", "Very High"].includes(item.risk_level)).length;
  const sectorMeans = sectors.map((sector) => ({ sector, mean: sectorAverage(countryName, sector) })).filter((item) => item.mean != null);
  const topSector = [...sectorMeans].sort((a, b) => b.mean - a.mean)[0];
  const mix = [...RISK_ORDER].reverse().map((risk) => ({ risk, count: records.filter((item) => item.risk_level === risk).length })).filter((item) => item.count);
  const sortHead = (sortKey, label, numeric = true) => `
    <th scope="col" class="${numeric ? "is-number" : ""}" aria-sort="${key === sortKey ? (dir === 1 ? "ascending" : "descending") : "none"}">
      <button type="button" data-report-sort="${sortKey}">${escapeHtml(label)}<span aria-hidden="true">${key === sortKey ? (dir === 1 ? "↑" : "↓") : ""}</span></button>
    </th>`;
  const rows = sorted.map((record, index) => `
    <tr data-read-record="${escapeHtml(recordKey(record))}" tabindex="0">
      <td class="is-number rp-muted">${index + 1}</td>
      <th scope="row">${escapeHtml(record.name)}</th>
      <td class="is-number"><b>${formatScore(record.composite_score)}</b></td>
      <td>${riskChip(record.risk_level)}</td>
      ${sectors.map((sector) => `<td class="is-number">${formatScore(record.metrics?.[sector]?.gender_hotspot_score)}</td>`).join("")}
      <td>${escapeHtml(record.top_sector || "N/A")}</td>
    </tr>`).join("");

  const section = openReport(reportShell(
    `${escapeHtml(countryName)} &middot; country data`,
    `${escapeHtml(countryName)}: all ${escapeHtml(admin)}`,
    `
    <section class="rp-hero">
      <div class="rp-hero-score">
        <span>Average composite score</span>
        <strong>${formatScore(mean)}<small>/ 100</small></strong>
        ${scoreMeter(mean, "is-light")}
        <div class="rp-hero-scale"><span>0</span><span>Low 20</span><span>Medium 40</span><span>High 60</span><span>Very high 75</span></div>
      </div>
      <div class="rp-hero-copy">
        <p>${escapeHtml(`${priority} of ${records.length} ${admin} are classed High or Very High.`)}${topSector ? escapeHtml(` ${topSector.sector} carries the highest average pressure at ${formatScore(topSector.mean)}.`) : ""}</p>
        <div class="rp-mix" role="img" aria-label="Risk class mix">${mix.map((item) => `<i style="flex:${item.count};background:${RISK_COLORS[item.risk]}"></i>`).join("")}</div>
        <ul class="rp-mix-key">${mix.map((item) => `<li><i style="background:${RISK_COLORS[item.risk]}"></i>${escapeHtml(item.risk)} <b>${item.count}</b></li>`).join("")}</ul>
      </div>
      <dl class="rp-hero-facts">
        <div><dt>${escapeHtml(country.admin_label)}</dt><dd>${records.length}</dd></div>
        ${sectorMeans.map((item) => `<div><dt>${escapeHtml(item.sector)} average</dt><dd>${formatScore(item.mean)}</dd></div>`).join("")}
      </dl>
    </section>
    <section class="rp-section">
      ${sectionHead("Full dataset", `Every ${placeLabel(countryName).toLowerCase()} and its sector scores`, "Select a column heading to sort. Select a row to open that place's report.")}
      <div class="rp-table-wrap">
        <table class="rp-table is-clickable">
          <thead><tr><th scope="col" class="is-number">#</th>${sortHead("name", placeLabel(countryName), false)}${sortHead("composite", "Composite")}${sortHead("risk", "Risk class", false)}${sectors.map((sector) => sortHead(sector, sector)).join("")}<th scope="col">Strongest pressure</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
    ${readingGuide(country.illustrative
      ? `Figures for ${countryName} are illustrative placeholders, not survey results. They are replaced when the ${countryName} sector workbooks are uploaded.`
      : "Figures come from the supplied water, energy, and agriculture sector workbooks.", Boolean(country.illustrative))}
    `
  ));
  section.dataset.country = countryName;
  syncUrl();
}

async function generateAiNarrative(key, force = false) {
  const record = recordByKey(key);
  if (!record) return;
  const card = document.querySelector("[data-ai-card]");
  if (card) {
    card.classList.add("is-loading");
    card.querySelector("button")?.setAttribute("disabled", "disabled");
  }

  try {
    const response = await fetch("/api/ai-narrative", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        country: record.country,
        place_name: record.name,
        sector: state.sector,
        force
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "AI narrative could not be generated.");

    record.ai_narratives = record.ai_narratives || {};
    record.ai_narratives[state.sector] = payload;
    if (selectedRecord && recordKey(selectedRecord) === recordKey(record)) selectedRecord = record;
    renderFullReport(record);
  } catch (error) {
    if (card) {
      card.classList.remove("is-loading");
      card.querySelector("button")?.removeAttribute("disabled");
      const errorBox = document.createElement("p");
      errorBox.className = "ai-error";
      errorBox.textContent = error.message;
      card.appendChild(errorBox);
    }
  }
}

function renderCountyLayer() {
  if (countyLayer) {
    map.removeLayer(countyLayer);
    countyLayer = null;
  }
  layerByKey.clear();

  const countries = state.country === "__all__" ? Object.keys(boundaries) : [state.country];
  const visibleKeys = new Set(getFilteredRecords().map(recordKey));
  const features = countries.flatMap((country) => (boundaries[country]?.features || []).filter((feature) => {
    const record = recordForFeature(feature);
    return record && visibleKeys.has(recordKey(record));
  }));
  if (!features.length) return;

  countyLayer = L.geoJSON({ type: "FeatureCollection", features }, {
    style: styleCounty,
    attribution: "Boundaries: geoBoundaries (RCMRD, UN OCHA, OpenStreetMap contributors)",
    onEachFeature(feature, layer) {
      const record = recordForFeature(feature);
      if (!record) return;
      layerByKey.set(recordKey(record), layer);
      layer.bindPopup(() => popupForRecord(record), { className: "place-popup", maxWidth: 320, minWidth: 270, autoPanPaddingTopLeft: [16, 84], autoPanPaddingBottomRight: [60, 30] });
      layer.bindTooltip(() => hoverCardForRecord(record), {
        sticky: true,
        direction: "top",
        offset: [0, -14],
        opacity: 1,
        className: "place-tooltip"
      });
      layer.on("click", () => {
        layer.closeTooltip();
        selectRecord(recordKey(record), false);
      });
      layer.on("mouseover", () => {
        layer.setStyle({ weight: 3, color: "#ffffff", fillOpacity: 0.97 });
        layer.bringToFront();
        layer.getElement()?.classList.add("is-hovered");
      });
      layer.on("mouseout", () => {
        layer.getElement()?.classList.remove("is-hovered");
        if (countyLayer) countyLayer.resetStyle(layer);
      });
      layer.on("add", () => layer.getElement()?.classList.add("place-shape"));
    }
  }).addTo(map);
}

function formatScoreOrRisk(record) {
  const value = metricForRecord(record);
  return state.metric === "risk_level" ? value : `${formatScore(value)} (${riskForRecord(record)})`;
}

let lastFitKey = null;
// Keeps fitted areas clear of the summary strip and the legend.
function fitPadding() {
  const summary = document.getElementById("summaryGrid");
  const overlaid = summary && window.getComputedStyle(summary).position === "absolute";
  const size = map.getSize();
  const top = overlaid ? Math.min(summary.offsetHeight + 28, size.y / 3) : 16;
  const side = size.x < 520 ? 14 : 28;
  return { paddingTopLeft: [side, top], paddingBottomRight: [side, overlaid ? 44 : 30] };
}

function fitMap(force = false) {
  // Only move the map when the country changes, so filtering and selecting places does not reset the view.
  if (!force && lastFitKey === state.country) return;
  lastFitKey = state.country;

  if (state.country === "__all__") {
    const group = L.featureGroup();
    hotspotData.countries.forEach((country) => group.addLayer(L.marker(country.center)));
    Object.values(boundaries).forEach((geojson) => group.addLayer(L.geoJSON(geojson)));
    map.fitBounds(group.getBounds(), fitPadding());
    map.panInsideBounds(AFRICA_BOUNDS, { animate: false });
    return;
  }

  const country = countryByName(state.country);
  if (!country) return;
  const countryFeatures = boundaries[state.country]?.features || [];
  if (countryFeatures.length) {
    map.fitBounds(L.geoJSON({ type: "FeatureCollection", features: countryFeatures }).getBounds(), fitPadding());
    map.panInsideBounds(AFRICA_BOUNDS, { animate: false });
    return;
  }
  map.setView(country.center, country.zoom);
  map.panInsideBounds(AFRICA_BOUNDS, { animate: false });
}

function riskClassForScore(score) {
  if (score == null || !Number.isFinite(Number(score))) return "No data";
  return score >= 75 ? "Very High" : score >= 60 ? "High" : score >= 40 ? "Medium" : score >= 20 ? "Low" : "Very Low";
}

function riskDot(risk) {
  return `<i style="background:${RISK_COLORS[risk] || RISK_COLORS["No data"]}"></i>`;
}

function renderSummary(records) {
  const scores = records.map((record) => Number(displayScore(record))).filter(Number.isFinite);
  const avg = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
  const highest = records.length ? records.reduce((best, record) => {
    return (Number(displayScore(record)) || 0) > (Number(displayScore(best)) || 0) ? record : best;
  }, records[0]) : null;

  const sectorScores = hotspotData.meta.sectors.map((sector) => {
    const values = records.map((record) => record.metrics?.[sector]?.gender_hotspot_score).filter((value) => value != null);
    return { sector, avg: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null };
  }).filter((item) => item.avg != null);
  const top = sectorScores.length ? sectorScores.sort((a, b) => b.avg - a.avg)[0] : null;

  const usesHotspotScale = state.metric === "gender_hotspot_score" || state.metric === "risk_level";
  const total = getRecords().length;
  document.getElementById("summaryContext").textContent = state.country === "__all__" ? "All countries" : state.country;
  document.getElementById("summaryMetric").textContent = `${selectedSectorLabel()} · ${usesHotspotScale ? "Gender hotspot score" : metricLabel(state.metric)}`;
  document.getElementById("visibleCount").textContent = records.length;
  document.getElementById("visibleNote").textContent = records.length === total ? "in view" : `of ${total} after filters`;
  document.getElementById("averageScore").textContent = formatScore(avg);
  const averageRisk = riskClassForScore(avg);
  document.getElementById("averageRisk").innerHTML = avg == null ? "" : usesHotspotScale ? `${riskDot(averageRisk)}${escapeHtml(averageRisk)} risk` : "out of 100";
  document.getElementById("highestHotspot").textContent = highest?.name || "N/A";
  document.getElementById("highestNote").innerHTML = highest
    ? `${riskDot(riskForRecord(highest))}${formatScore(displayScore(highest))}${state.country === "__all__" ? ` · ${escapeHtml(highest.country)}` : ""}`
    : "";
  const highestButton = document.getElementById("highestButton");
  highestButton.disabled = !highest;
  highestButton.dataset.overviewRecord = highest ? recordKey(highest) : "";
  document.getElementById("topSector").textContent = top?.sector || "N/A";
  document.getElementById("topSectorNote").textContent = top ? `average ${formatScore(top.avg)}` : "";
}

function renderSectorChart(records) {
  const container = document.getElementById("sectorChart");
  const detail = document.getElementById("sectorChartDetail");
  const rows = hotspotData.meta.sectors.map((sector) => {
    const sectorRecords = records.filter((record) => record.metrics?.[sector]?.gender_hotspot_score != null);
    const values = sectorRecords.map((record) => record.metrics?.[sector]?.gender_hotspot_score).filter((value) => value != null);
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const highest = sectorRecords.length
      ? sectorRecords.reduce((best, record) => (Number(record.metrics?.[sector]?.gender_hotspot_score) || 0) > (Number(best.metrics?.[sector]?.gender_hotspot_score) || 0) ? record : best, sectorRecords[0])
      : null;
    return { sector, average, count: sectorRecords.length, highest, topRisk: highest?.metrics?.[sector]?.risk_level || "No data" };
  });

  const thresholds = [20, 40, 60, 75];
  const riskOfScore = (score) => score == null ? "No data"
    : score >= 75 ? "Very High" : score >= 60 ? "High" : score >= 40 ? "Medium" : score >= 20 ? "Low" : "Very Low";
  const ticks = thresholds.map((value) => `<b style="left:${value}%"></b>`).join("");

  container.innerHTML = rows.map(({ sector, average, count, highest, topRisk }) => {
    const risk = riskOfScore(average);
    return `
    <button class="bar-row interactive-chart-row ${state.sector === sector ? "is-active" : ""}" type="button"
      data-sector-chart="${escapeHtml(sector)}"
      data-average="${average == null ? "" : Number(average).toFixed(1)}"
      data-count="${count}"
      data-highest="${escapeHtml(highest?.name || "No visible record")}"
      data-risk="${escapeHtml(topRisk)}"
      aria-label="${escapeHtml(sector)}: average score ${formatScore(average)}, ${escapeHtml(risk)} risk">
      <span class="bar-head">
        <span class="bar-name">${escapeHtml(sector)}</span>
        <span class="bar-risk"><i style="background:${RISK_COLORS[risk] || RISK_COLORS["No data"]}"></i>${escapeHtml(risk)}</span>
        <strong>${formatScore(average)}</strong>
      </span>
      <span class="bar-track"><i style="width:${Math.max(0, Math.min(100, average || 0))}%"></i>${ticks}</span>
    </button>
  `;
  }).join("") + `
    <div class="bar-axis" aria-hidden="true">
      ${[0, ...thresholds, 100].map((value) => `<span style="left:${value}%">${value}</span>`).join("")}
    </div>
    <p class="bar-axis-note">Score from 0 to 100. Marks show where the risk classes change: Low from 20, Medium from 40, High from 60, Very High from 75.</p>
  `;

  const first = rows.find((row) => row.sector === state.sector) || rows[0];
  if (detail) {
    detail.innerHTML = first ? `
      <div class="chart-detail-copy">
        <strong>${escapeHtml(first.sector)} sector detail</strong>
        <p>${escapeHtml(metricLabel("gender_hotspot_score"))}: ${formatScore(first.average)} average across ${first.count} visible records.</p>
        <p>Highest visible hotspot: <strong>${escapeHtml(first.highest?.name || "No visible record")}</strong> with a <strong>${escapeHtml(first.topRisk)}</strong> risk label.</p>
        <small>Hover over another sector or click it to filter the full workspace to that sector.</small>
      </div>
    ` : "";
  }
}

function renderRiskList(records) {
  const counts = Object.fromEntries(RISK_ORDER.map((risk) => [risk, 0]));
  const samples = Object.fromEntries(RISK_ORDER.map((risk) => [risk, []]));
  records.forEach((record) => {
    const risk = riskForRecord(record);
    if (counts[risk] != null) {
      counts[risk] += 1;
      if (samples[risk].length < 3) samples[risk].push(record.name);
    }
  });

  const largest = Math.max(1, ...Object.values(counts));
  document.getElementById("riskList").innerHTML = [...RISK_ORDER].reverse().map((risk) => `
    <button class="risk-row interactive-chart-row ${state.risk === risk ? "is-active" : ""}" type="button"
      data-risk-chart="${escapeHtml(risk)}"
      data-count="${counts[risk]}"
      data-samples="${escapeHtml(samples[risk].join(', '))}"
      aria-label="${escapeHtml(risk)}: ${counts[risk]} places">
      <span class="risk-name"><i style="background:${RISK_COLORS[risk]}"></i>${risk}</span>
      <span class="risk-bar"><i style="width:${(counts[risk] / largest) * 100}%;background:${RISK_COLORS[risk]}"></i></span>
      <strong>${counts[risk]}</strong>
    </button>
  `).join("");

  const detail = document.getElementById("riskChartDetail");
  if (detail) {
    const activeRisk = state.risk !== "__all__" ? state.risk : [...RISK_ORDER].reverse().find((risk) => counts[risk] > 0) || "No data";
    detail.innerHTML = `
      <div class="chart-detail-copy">
        <strong>${escapeHtml(activeRisk)} risk detail</strong>
        <p>${counts[activeRisk] || 0} visible records currently fall in this risk class.</p>
        <p>${samples[activeRisk]?.length ? `Examples: ${escapeHtml(samples[activeRisk].join(", "))}.` : "No example records are currently visible in this class."}</p>
        <small>Hover over another risk class or click it to filter the record list by that class.</small>
      </div>
    `;
  }
}

function updateSectorChartDetailFromElement(element) {
  const detail = document.getElementById("sectorChartDetail");
  if (!detail || !element) return;
  detail.innerHTML = `
    <div class="chart-detail-copy">
      <strong>${escapeHtml(element.getAttribute("data-sector-chart"))} sector detail</strong>
      <p>${escapeHtml(metricLabel("gender_hotspot_score"))}: ${escapeHtml(element.getAttribute("data-average") || "N/A")} average across ${escapeHtml(element.getAttribute("data-count") || "0")} visible records.</p>
      <p>Highest visible hotspot: <strong>${escapeHtml(element.getAttribute("data-highest") || "No visible record")}</strong> with a <strong>${escapeHtml(element.getAttribute("data-risk") || "No data")}</strong> risk label.</p>
      <small>Click to focus the map, records, and report flow on this sector.</small>
    </div>
  `;
}

function updateRiskChartDetailFromElement(element) {
  const detail = document.getElementById("riskChartDetail");
  if (!detail || !element) return;
  const samples = element.getAttribute("data-samples");
  detail.innerHTML = `
    <div class="chart-detail-copy">
      <strong>${escapeHtml(element.getAttribute("data-risk-chart"))} risk detail</strong>
      <p>${escapeHtml(element.getAttribute("data-count") || "0")} visible records currently fall in this risk class.</p>
      <p>${samples ? `Examples: ${escapeHtml(samples)}.` : "No example records are currently visible in this class."}</p>
      <small>Click to filter the visible record list by this risk class.</small>
    </div>
  `;
}

function renderCountryRecordCards(records) {
  const grid = document.getElementById("recordGrid");
  document.getElementById("recordsTitle").textContent = "Study countries";
  document.getElementById("recordsIntro").textContent = "Pick a country to list its places, or click any area on the map.";
  document.getElementById("emptyState").hidden = true;

  const byCountry = new Map();
  records.forEach((record) => {
    if (!byCountry.has(record.country)) byCountry.set(record.country, []);
    byCountry.get(record.country).push(record);
  });

  grid.innerHTML = hotspotData.countries.map((country) => {
    const countryRecords = byCountry.get(country.country) || [];
    const scores = countryRecords.map((record) => Number(displayScore(record))).filter(Number.isFinite);
    const average = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
    const highest = countryRecords.length
      ? countryRecords.reduce((best, record) => (Number(displayScore(record)) || 0) > (Number(displayScore(best)) || 0) ? record : best, countryRecords[0])
      : null;
    const strip = [...RISK_ORDER].reverse().map((risk) => {
      const count = countryRecords.filter((record) => riskForRecord(record) === risk).length;
      return count ? `<i style="flex:${count};background:${RISK_COLORS[risk]}" title="${escapeHtml(risk)}: ${count}"></i>` : "";
    }).join("");

    return `
      <button class="ma-country" type="button" data-open-country="${escapeHtml(country.country)}">
        <span class="ma-country-top">
          <strong>${escapeHtml(country.country)}</strong>
          <span class="ma-pill ${country.illustrative ? "is-illustrative" : ""}">${country.illustrative ? "Illustrative data" : "Workbook data"}</span>
        </span>
        <span class="ma-strip" role="img" aria-label="Risk class mix">${strip}</span>
        <span class="ma-country-stats">
          <span><b>${countryRecords.length}</b> ${escapeHtml(country.admin_label.toLowerCase())}</span>
          <span><b>${formatScore(average)}</b> average</span>
        </span>
        <span class="ma-country-foot">
          <span>Highest: <b>${escapeHtml(highest?.name || "No match")}</b></span>
          <em>Open <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.400" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></em>
        </span>
      </button>
    `;
  }).join("");
}

function renderRecordCards(records) {
  const grid = document.getElementById("recordGrid");
  const empty = document.getElementById("emptyState");
  const showMoreRow = document.getElementById("showMoreRow");
  const sortTools = document.getElementById("sortSelect");
  sortTools.hidden = state.country === "__all__";
  document.getElementById("countryReportButton").hidden = state.country === "__all__";
  if (state.country === "__all__") {
    showMoreRow.hidden = true;
    renderCountryRecordCards(records);
    return;
  }

  const listKey = [state.country, state.sector, state.metric, state.risk, state.search, state.sort].join("|");
  if (listKey !== lastListKey) {
    visibleLimit = PAGE_SIZE;
    lastListKey = listKey;
  }
  const total = records.length;
  records = records.slice(0, visibleLimit);
  showMoreRow.hidden = total <= records.length;
  document.getElementById("showMoreCount").textContent = `Showing ${records.length} of ${total}`;
  document.getElementById("showMoreButton").textContent = `Show ${Math.min(PAGE_SIZE, total - records.length)} more`;

  document.getElementById("recordsTitle").textContent = `${state.country} ${adminLabel(state.country).toLowerCase()}`;
  document.getElementById("recordsIntro").textContent = `${total} shown · ${selectedSectorLabel()} · ${metricLabel(state.metric)}`;

  empty.hidden = total > 0;
  grid.innerHTML = records.map((record) => {
    const key = escapeHtml(recordKey(record));
    const score = displayScore(record);
    const width = Math.max(0, Math.min(100, Number(score) || 0));
    const isSelected = selectedRecord && recordKey(selectedRecord) === recordKey(record);
    return `
      <button class="ma-row ${isSelected ? "is-selected" : ""}" type="button" data-record-name="${key}" data-overview-record="${key}">
        <i class="ma-row-dot" style="background:${colorForRecord(record)}"></i>
        <span class="ma-row-main">
          <strong>${escapeHtml(record.name)}</strong>
          <small>${escapeHtml(riskForRecord(record))} risk · strongest: ${escapeHtml(record.top_sector || "N/A")}</small>
        </span>
        <span class="ma-row-score">
          <b>${formatScore(score)}</b>
          <span class="ma-row-bar"><i style="width:${width}%"></i></span>
        </span>
      </button>
    `;
  }).join("");
}

function renderLegend() {
  document.getElementById("mapLegend").innerHTML = "<b>Risk class</b>" + [...RISK_ORDER].reverse().map((risk) => `
    <span><i style="background:${RISK_COLORS[risk]}"></i>${risk}</span>
  `).join("");
}

function renderMetricNote() {
  const country = state.country === "__all__" ? "All countries" : state.country;
  document.getElementById("metricNote").innerHTML = `
    <strong>${country} - ${selectedSectorLabel()}</strong>
    <p>${METRIC_COPY[state.metric]}</p>
  `;
}

function renderDataNotice() {
  const notice = document.getElementById("dataNotice");
  if (!notice) return;
  const illustrative = hotspotData.countries.filter((country) => country.illustrative
    && (state.country === "__all__" || state.country === country.country));
  notice.hidden = illustrative.length === 0;
  notice.innerHTML = illustrative.length ? `
    <strong>Illustrative data</strong>
    <span>${escapeHtml(illustrative.map((country) => country.country).join(", "))} ${illustrative.length > 1 ? "show" : "shows"} placeholder figures, not survey results.</span>
  ` : "";
}

function currentViewUrl() {
  const params = new URLSearchParams();
  if (state.country !== "__all__") params.set("country", state.country);
  if (state.sector !== "__all__") params.set("sector", state.sector);
  if (state.metric !== "gender_hotspot_score") params.set("metric", state.metric);
  if (state.risk !== "__all__") params.set("risk", state.risk);
  if (state.search.trim()) params.set("q", state.search.trim());
  if (selectedRecord) {
    params.set("country", selectedRecord.country);
    params.set("place", selectedRecord.name);
  }
  const openCountryTable = document.getElementById("fullReport")?.dataset.country;
  if (openCountryTable && !selectedRecord) {
    params.set("country", openCountryTable);
    params.set("report", "country");
  }
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}`;
}

function syncUrl() {
  if (!hotspotData) return;
  window.history.replaceState(null, "", currentViewUrl());
}

function flashButton(button, label) {
  const text = button.querySelector("span");
  const original = text.textContent;
  text.textContent = label;
  button.classList.add("is-done");
  window.setTimeout(() => {
    text.textContent = original;
    button.classList.remove("is-done");
  }, 1800);
}

async function copyViewLink(button) {
  const url = new URL(currentViewUrl(), window.location.origin).toString();
  try {
    await navigator.clipboard.writeText(url);
    flashButton(button, "Link copied");
  } catch (error) {
    window.prompt("Copy this link", url);
  }
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadVisibleCsv(button) {
  const records = getFilteredRecords();
  if (!records.length) return;
  const sectors = hotspotData.meta.sectors;
  const sectorFields = [
    ["gender_hotspot_score", "hotspot score"],
    ["risk_level", "risk"],
    ["vulnerability_score", "vulnerability"],
    ["exposure", "exposure"],
    ["sensitivity", "sensitivity"],
    ["adaptive_capacity", "adaptive capacity"]
  ];
  const header = ["Country", "Place", "Zone", "Data status", "Composite score", "Composite risk", "Top sector"];
  sectors.forEach((sector) => sectorFields.forEach(([, label]) => header.push(`${sector} ${label}`)));
  const rows = records.map((record) => {
    const row = [record.country, record.name, record.zone || "", record.data_status || "", record.composite_score, record.risk_level, record.top_sector || ""];
    sectors.forEach((sector) => sectorFields.forEach(([field]) => row.push(record.metrics?.[sector]?.[field])));
    return row;
  });
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const scope = [state.country === "__all__" ? "all-countries" : state.country, state.sector === "__all__" ? "" : state.sector, state.risk === "__all__" ? "" : state.risk]
    .filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `gender-hotspots-${scope}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  flashButton(button, `${records.length} rows saved`);
}

function resetFilters() {
  state.country = "__all__";
  state.sector = "__all__";
  state.metric = "gender_hotspot_score";
  state.risk = "__all__";
  state.search = "";
  state.sort = "score_desc";
  document.getElementById("countrySelect").value = state.country;
  document.getElementById("sectorSelect").value = state.sector;
  document.getElementById("metricSelect").value = state.metric;
  document.getElementById("riskSelect").value = state.risk;
  document.getElementById("searchInput").value = "";
  document.getElementById("sortSelect").value = state.sort;
  clearSelectedRecord();
  applyState();
}

function updateRecordsBackButton() {
  const button = document.getElementById("recordsBackButton");
  if (!button) return;
  button.hidden = state.country === "__all__";
}

function applyState() {
  const records = getFilteredRecords();
  if (selectedRecord && !records.some((record) => recordKey(record) === recordKey(selectedRecord))) {
    selectedRecord = null;
    const overview = document.getElementById("countyOverview");
    if (overview) overview.hidden = true;
    closeReport();
    setDetailMode(false);
  }
  renderCountryCards();
  renderCountryMarkers();
  renderFocusMask();
  renderCountyLayer();
  fitMap();
  renderSummary(records);
  renderSectorChart(records);
  renderRiskList(records);
  renderRecordCards(records);
  updateRecordsBackButton();
  if (selectedRecord) {
    selectRecord(recordKey(selectedRecord), false);
  } else {
    setDetailMode(false);
  }
  renderLegend();
  renderMetricNote();
  renderDataNotice();
  syncUrl();
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const requestedCountry = params.get("country");
  const requestedSector = params.get("sector");
  const requestedMetric = params.get("metric");
  const requestedRisk = params.get("risk");
  const requestedSearch = params.get("q");
  const requestedPlace = params.get("place");

  initMap();
  hotspotData = await fetch("/api/hotspot-data").then((res) => res.json());
  await Promise.all(hotspotData.countries.filter((country) => country.geometry_file).map(async (country) => {
    try {
      const response = await fetch(`/data/${country.geometry_file}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const geojson = await response.json();
      geojson.features.forEach((feature) => {
        feature.properties = { ...feature.properties, country: country.country };
      });
      boundaries[country.country] = geojson;
    } catch (error) {
      console.warn(`Boundaries for ${country.country} could not be loaded:`, error);
    }
  }));

  try {
    const response = await fetch("/data/study_countries.geojson");
    if (response.ok) countryOutlines = await response.json();
  } catch (error) {
    console.warn("Country outlines could not be loaded; using sub-national boundaries for the focus mask.", error);
  }

  if (requestedCountry && hotspotData.meta.countries.includes(requestedCountry)) {
    state.country = requestedCountry;
  }
  if (requestedSector && [...hotspotData.meta.sectors, "__all__"].includes(requestedSector)) {
    state.sector = requestedSector;
  }
  if (requestedMetric && (hotspotData.meta.metrics || []).includes(requestedMetric)) {
    state.metric = requestedMetric;
  }
  if (requestedRisk && RISK_ORDER.includes(requestedRisk)) {
    state.risk = requestedRisk;
  }
  if (requestedSearch) {
    state.search = requestedSearch;
  }

  buildOptions(document.getElementById("countrySelect"), hotspotData.meta.countries, "All study countries");
  buildOptions(document.getElementById("sectorSelect"), hotspotData.meta.sectors, "All sectors");
  document.getElementById("countrySelect").value = state.country;
  document.getElementById("sectorSelect").value = state.sector;
  document.getElementById("metricSelect").value = state.metric;
  document.getElementById("riskSelect").value = state.risk;
  document.getElementById("searchInput").value = state.search;

  document.getElementById("showMoreButton").addEventListener("click", () => {
    visibleLimit += PAGE_SIZE;
    renderRecordCards(getFilteredRecords());
  });

  document.getElementById("countrySelect").addEventListener("change", (event) => {
    state.country = event.target.value;
    applyState();
  });
  document.getElementById("sectorSelect").addEventListener("change", (event) => {
    state.sector = event.target.value;
    applyState();
  });
  document.getElementById("metricSelect").addEventListener("change", (event) => {
    state.metric = event.target.value;
    applyState();
  });
  document.getElementById("riskSelect").addEventListener("change", (event) => {
    state.risk = event.target.value;
    applyState();
  });
  document.getElementById("searchInput").addEventListener("input", (event) => {
    state.search = event.target.value;
    applyState();
  });
  document.getElementById("sortSelect").addEventListener("change", (event) => {
    state.sort = event.target.value;
    applyState();
  });
  document.getElementById("recordsBackButton").addEventListener("click", () => {
    state.country = "__all__";
    document.getElementById("countrySelect").value = state.country;
    clearSelectedRecord();
    applyState();
  });
  document.getElementById("resetFilters").addEventListener("click", resetFilters);

  document.querySelectorAll("[data-panel-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      panelTab = tab.dataset.panelTab;
      if (selectedRecord) clearSelectedRecord();
      setDetailMode(false);
    });
  });
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      map.invalidateSize();
      if (!selectedRecord) fitMap(true);
    }, 220);
  });
  document.getElementById("panelToggle").addEventListener("click", () => {
    setPanelCollapsed(!document.getElementById("mapApp").classList.contains("is-collapsed"));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.getElementById("reportOverlay").hidden) {
      if (document.getElementById("sectionChooser")) closeSectionChooser();
      else closeExportMenus();
    }
    if (event.key === "Escape" && !document.getElementById("reportOverlay").hidden) {
      if (document.getElementById("sectionChooser")) closeSectionChooser();
      else if (document.querySelector(".rp-export-menu:not([hidden])")) closeExportMenus();
      else closeReport();
    }
    if (event.key === "Enter" && event.target.matches?.("tr[data-read-record]")) event.target.click();
  });
  const recordGrid = document.getElementById("recordGrid");
  recordGrid.addEventListener("mouseover", (event) => {
    const row = event.target.closest("[data-record-name]");
    if (row) setListHover(row.dataset.recordName, true);
  });
  recordGrid.addEventListener("mouseout", (event) => {
    const row = event.target.closest("[data-record-name]");
    if (row && !row.contains(event.relatedTarget)) setListHover(row.dataset.recordName, false);
  });
  document.getElementById("overviewReadMore").addEventListener("click", () => renderFullReport());
  document.getElementById("overviewBack").addEventListener("click", clearSelectedRecord);
  document.addEventListener("click", (event) => {
    const exportToggle = event.target.closest("[data-export-toggle]");
    if (exportToggle) {
      toggleExportMenu(exportToggle.closest(".rp-export"));
      return;
    }
    const exportItem = event.target.closest("[data-export]");
    if (exportItem) {
      handleExportAction(exportItem.getAttribute("data-export"), exportItem.closest(".rp-export"));
      return;
    }
    if (!event.target.closest(".rp-export")) closeExportMenus();

    const chooser = document.getElementById("sectionChooser");
    if (chooser && chooser.contains(event.target)) {
      if (event.target.closest("[data-chooser-cancel]")) {
        closeSectionChooser();
      } else if (event.target.closest("[data-chooser-all]") || event.target.closest("[data-chooser-clear]")) {
        const checked = Boolean(event.target.closest("[data-chooser-all]"));
        chooser.querySelectorAll("input[type=checkbox]").forEach((box) => { box.checked = checked; });
        updateChooserCount();
      } else if (event.target.closest("[data-chooser-download]")) {
        const boxes = [...chooser.querySelectorAll("input[type=checkbox]")];
        const chosen = boxes.filter((box) => box.checked).map((box) => box.value);
        if (chosen.length) {
          startDownload(exportUrl(chooserContext, "pdf", chosen.length === boxes.length ? null : chosen));
          closeSectionChooser();
        }
      }
      return;
    }

    const sectorChartTarget = event.target.closest("[data-sector-chart]");
    if (sectorChartTarget) {
      state.sector = sectorChartTarget.getAttribute("data-sector-chart");
      document.getElementById("sectorSelect").value = state.sector;
      clearSelectedRecord();
      applyState();
      return;
    }

    const riskChartTarget = event.target.closest("[data-risk-chart]");
    if (riskChartTarget) {
      state.risk = riskChartTarget.getAttribute("data-risk-chart");
      document.getElementById("riskSelect").value = state.risk;
      clearSelectedRecord();
      applyState();
      return;
    }

    const countryTarget = event.target.closest("[data-open-country]");
    if (countryTarget) {
      state.country = countryTarget.getAttribute("data-open-country");
      document.getElementById("countrySelect").value = state.country;
      clearSelectedRecord();
      applyState();
      return;
    }

    const overviewTarget = event.target.closest("[data-overview-record]");
    if (overviewTarget) {
      selectRecord(overviewTarget.getAttribute("data-overview-record"), true);
      focusPlaceOnMap(overviewTarget.getAttribute("data-overview-record"));
      return;
    }

    const readTarget = event.target.closest("[data-read-record]");
    if (readTarget) {
      const name = readTarget.getAttribute("data-read-record");
      map.closePopup();
      const target = recordByKey(name);
      if (target && state.country !== "__all__" && state.country !== target.country) {
        state.country = target.country;
        document.getElementById("countrySelect").value = state.country;
        applyState();
      }
      selectRecord(name, true);
      renderFullReport(recordByKey(name));
      return;
    }

    if (event.target.closest("[data-close-report]")) {
      closeReport();
      return;
    }

    if (event.target.closest("[data-country-report]")) {
      countryReportSort = { key: "composite", dir: -1 };
      renderCountryReport(state.country);
      return;
    }

    const sortTarget = event.target.closest("[data-report-sort]");
    if (sortTarget) {
      const sortKey = sortTarget.getAttribute("data-report-sort");
      countryReportSort = countryReportSort.key === sortKey
        ? { key: sortKey, dir: -countryReportSort.dir }
        : { key: sortKey, dir: sortKey === "name" ? 1 : -1 };
      const scroll = document.getElementById("reportHost").scrollTop;
      renderCountryReport(document.getElementById("fullReport")?.dataset.country || state.country);
      document.getElementById("reportHost").scrollTop = scroll;
      return;
    }

    const aiTarget = event.target.closest("[data-generate-ai]");
    if (aiTarget) {
      generateAiNarrative(
        aiTarget.getAttribute("data-generate-ai"),
        aiTarget.getAttribute("data-force-ai") === "1"
      );
      return;
    }

    const aiDownloadTarget = event.target.closest("[data-download-ai]");
    if (aiDownloadTarget) {
      downloadAiNarrative(aiDownloadTarget.getAttribute("data-download-ai"));
    }
  });

  document.addEventListener("mouseover", (event) => {
    const sectorChartTarget = event.target.closest("[data-sector-chart]");
    if (sectorChartTarget) {
      updateSectorChartDetailFromElement(sectorChartTarget);
      return;
    }

    const riskChartTarget = event.target.closest("[data-risk-chart]");
    if (riskChartTarget) {
      updateRiskChartDetailFromElement(riskChartTarget);
    }
  });

  document.addEventListener("focusin", (event) => {
    const sectorChartTarget = event.target.closest("[data-sector-chart]");
    if (sectorChartTarget) {
      updateSectorChartDetailFromElement(sectorChartTarget);
      return;
    }

    const riskChartTarget = event.target.closest("[data-risk-chart]");
    if (riskChartTarget) {
      updateRiskChartDetailFromElement(riskChartTarget);
    }
  });

  applyState();

  if (!requestedPlace && params.get("report") === "country" && state.country !== "__all__") {
    renderCountryReport(state.country);
  }

  if (requestedPlace && state.country !== "__all__" && recordByKey(`${state.country}::${requestedPlace}`)) {
    const key = `${state.country}::${requestedPlace}`;
    selectRecord(key, true);
    focusPlaceOnMap(key);
    renderFullReport(recordByKey(key));
  }
}

init().catch((error) => {
  console.error("Failed to initialize hotspot map:", error);
  document.getElementById("recordGrid").innerHTML = `
    <article class="ma-empty">
      <h3>Map data could not be loaded</h3>
      <p>Please confirm the generated hotspot data file is available in the data folder.</p>
    </article>
  `;
});
