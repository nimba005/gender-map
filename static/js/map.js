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

const state = {
  country: "__all__",
  sector: "Water",
  metric: "gender_hotspot_score",
  risk: "__all__",
  search: "",
  sort: "score_desc"
};

let hotspotData = null;
let kenyaGeojson = null;
let map;
let countyLayer;
let markerLayer;
let selectedRecord = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatScore(value) {
  return value == null ? "N/A" : Number(value).toFixed(1);
}

function riskRank(risk) {
  return RISK_ORDER.indexOf(risk) + 1;
}

function metricForRecord(record, sector = state.sector) {
  const metrics = record?.metrics?.[sector] || {};
  if (state.metric === "risk_level") return metrics.risk_level || record.risk_level || "No data";
  return metrics[state.metric] ?? record.composite_score ?? null;
}

function riskForRecord(record, sector = state.sector) {
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
  map = L.map("map", { zoomControl: true, scrollWheelZoom: true }).setView([1, 25], 4);

  const fallbackLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors"
  });

  const baseLayers = {};

  if (L.gridLayer?.googleMutant && window.google?.maps) {
    const googleRoadmap = L.gridLayer.googleMutant({
      type: "roadmap",
      maxZoom: 20,
      styles: []
    }).addTo(map);
    const googleHybrid = L.gridLayer.googleMutant({
      type: "hybrid",
      maxZoom: 20,
      styles: []
    });
    const googleTerrain = L.gridLayer.googleMutant({
      type: "terrain",
      maxZoom: 20,
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
  markerLayer = L.layerGroup().addTo(map);
}

function countryByName(name) {
  return hotspotData.countries.find((country) => country.country === name);
}

function renderCountryCards() {
  const container = document.getElementById("countryCards");
  container.innerHTML = hotspotData.countries.map((country) => `
    <button class="country-card ${state.country === country.country ? "is-active" : ""}" data-country="${country.country}" type="button">
      <span class="risk-dot" style="background:${colorForCountry(country)}"></span>
      <strong>${country.country}</strong>
      <small>${country.status}</small>
      <span>${country.record_count || 0} ${country.admin_label.toLowerCase()} loaded</span>
    </button>
  `).join("");

  container.querySelectorAll("[data-country]").forEach((button) => {
    button.addEventListener("click", () => {
      state.country = button.dataset.country;
      document.getElementById("countrySelect").value = state.country;
      applyState();
    });
  });
}

function popupForCountry(country) {
  return `
    <div class="popup-card">
      <strong>${country.country}</strong>
      <span>${country.status}</span>
      <p>${country.study_note}</p>
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
  hotspotData.countries.forEach((country) => {
    const marker = L.circleMarker(country.center, {
      radius: country.country === "Kenya" ? 11 : 9,
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

function recordByCounty(name) {
  return (hotspotData.records.Kenya || []).find((record) => record.name === name);
}

function styleCounty(feature) {
  const record = recordByCounty(countyNameFromFeature(feature));
  return {
    color: "#ffffff",
    weight: 1,
    fillColor: record ? colorForRecord(record) : RISK_COLORS["No data"],
    fillOpacity: record ? 0.78 : 0.2
  };
}

function popupForRecord(record) {
  const metrics = record.metrics[state.sector] || {};
  const indicators = (metrics.indicators || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  return `
    <div class="popup-card">
      <strong>${escapeHtml(record.name)}</strong>
      <span>${escapeHtml(state.sector)} - ${escapeHtml(riskForRecord(record))}</span>
      <dl>
        <dt>Hotspot score</dt><dd>${formatScore(metrics.gender_hotspot_score)}</dd>
        <dt>Vulnerability</dt><dd>${formatScore(metrics.vulnerability_score)}</dd>
        <dt>Exposure</dt><dd>${formatScore(metrics.exposure)}</dd>
        <dt>Sensitivity</dt><dd>${formatScore(metrics.sensitivity)}</dd>
        <dt>Adaptive capacity</dt><dd>${formatScore(metrics.adaptive_capacity)}</dd>
      </dl>
      <ul>${indicators}</ul>
      <button class="popup-action" type="button" data-read-record="${escapeHtml(record.name)}">Open overview</button>
    </div>
  `;
}

function sectorReportRows(record) {
  return hotspotData.meta.sectors.map((sector) => {
    const metrics = record.metrics?.[sector] || {};
    const indicators = (metrics.indicators || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    return `
      <article class="report-sector-card">
        <div>
          <span class="card-kicker">${escapeHtml(sector)}</span>
          <h4>${escapeHtml(metrics.risk_level || "No data")} risk</h4>
        </div>
        <div class="report-metrics">
          <span>Hotspot <strong>${formatScore(metrics.gender_hotspot_score)}</strong></span>
          <span>Vulnerability <strong>${formatScore(metrics.vulnerability_score)}</strong></span>
          <span>Exposure <strong>${formatScore(metrics.exposure)}</strong></span>
          <span>Sensitivity <strong>${formatScore(metrics.sensitivity)}</strong></span>
          <span>Adaptive capacity <strong>${formatScore(metrics.adaptive_capacity)}</strong></span>
          <span>Raw value <strong>${metrics.raw_value == null ? "N/A" : Number(metrics.raw_value).toLocaleString()}</strong></span>
        </div>
        <ul>${indicators}</ul>
      </article>
    `;
  }).join("");
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

function adminReportSections(record) {
  const reports = record.reports || [];
  if (!reports.length) {
    return `
      <article class="report-text-block">
        <h3>Admin narrative</h3>
        <p>No admin-written narrative has been added for this county yet. Use the admin dashboard to publish context, findings, recommendations, and methodology notes.</p>
      </article>
    `;
  }

  return reports.map((report) => `
    <article class="report-narrative">
      <div>
        <span class="card-kicker">${escapeHtml(report.sector || "All sectors")}</span>
        <h3>${escapeHtml(report.title)}</h3>
      </div>
      ${textBlock("Overview", report.overview)}
      ${textBlock("Key findings", report.findings)}
      ${textBlock("Recommendations", report.recommendations)}
      ${textBlock("Methodology and notes", report.methodology)}
    </article>
  `).join("");
}

function documentSections(record) {
  const docs = record.documents || [];
  if (!docs.length) {
    return `
      <article class="document-empty">
        <h3>Documents</h3>
        <p>No PDFs have been attached yet. Admins can upload county documents, evidence notes, and full reports from the admin dashboard.</p>
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

function selectRecord(recordName, shouldScroll = true) {
  const record = recordByCounty(recordName);
  if (!record) return;
  selectedRecord = record;

  const metrics = record.metrics[state.sector] || {};
  const overview = document.getElementById("countyOverview");
  document.getElementById("overviewKicker").textContent = `${record.country} county overview`;
  document.getElementById("overviewTitle").textContent = record.name;
  document.getElementById("overviewScore").textContent = formatScore(metricForRecord(record));
  document.getElementById("overviewSummary").textContent =
    `${record.name} is currently classified as ${riskForRecord(record)} for ${state.sector}. The overview below highlights the selected sector, while the full report compares all sectors for this county.`;

  document.getElementById("overviewGrid").innerHTML = `
    <article><span>Risk level</span><strong>${escapeHtml(riskForRecord(record))}</strong></article>
    <article><span>Exposure</span><strong>${formatScore(metrics.exposure)}</strong></article>
    <article><span>Sensitivity</span><strong>${formatScore(metrics.sensitivity)}</strong></article>
    <article><span>Adaptive capacity</span><strong>${formatScore(metrics.adaptive_capacity)}</strong></article>
    <article><span>Vulnerability</span><strong>${formatScore(metrics.vulnerability_score)}</strong></article>
    <article><span>Top pressure</span><strong>${escapeHtml(record.top_sector || "N/A")}</strong></article>
  `;
  overview.hidden = false;

  document.querySelectorAll(".record-card").forEach((card) => {
    card.classList.toggle("is-selected", card.dataset.recordName === record.name);
  });

  if (shouldScroll) {
    overview.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderFullReport(record = selectedRecord) {
  if (!record) return;
  const existing = document.getElementById("fullReport");
  if (existing) existing.remove();

  const section = document.createElement("section");
  section.id = "fullReport";
  section.className = "full-report";
  section.innerHTML = `
    <div class="full-report-head">
      <div>
        <span class="card-kicker">Full county report</span>
        <h2>${escapeHtml(record.name)} gender hotspot report</h2>
        <p>
          This report brings together water, energy, and agriculture indicators for ${escapeHtml(record.name)}.
          Use it to understand the data behind the map color and identify which sector requires the strongest gender-responsive attention.
        </p>
      </div>
      <button class="button button-secondary" type="button" data-close-report>Close report</button>
    </div>
    <div class="report-summary">
      <article><span>Composite score</span><strong>${formatScore(record.composite_score)}</strong></article>
      <article><span>Composite risk</span><strong>${escapeHtml(record.risk_level)}</strong></article>
      <article><span>Highest pressure sector</span><strong>${escapeHtml(record.top_sector || "N/A")}</strong></article>
      <article><span>Selected sector</span><strong>${escapeHtml(state.sector)}</strong></article>
    </div>
    <div class="report-reading-grid">
      ${adminReportSections(record)}
      ${documentSections(record)}
    </div>
    <div class="report-sector-grid">
      ${sectorReportRows(record)}
    </div>
  `;

  document.querySelector(".records-section").after(section);
  section.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderCountyLayer() {
  if (countyLayer) {
    map.removeLayer(countyLayer);
    countyLayer = null;
  }

  if (!kenyaGeojson || (state.country !== "__all__" && state.country !== "Kenya")) return;

  const visibleNames = new Set(getFilteredRecords().map((record) => record.name));
  const filteredGeojson = {
    ...kenyaGeojson,
    features: kenyaGeojson.features.filter((feature) => visibleNames.has(countyNameFromFeature(feature)))
  };

  countyLayer = L.geoJSON(filteredGeojson, {
    style: styleCounty,
    onEachFeature(feature, layer) {
      const record = recordByCounty(countyNameFromFeature(feature));
      if (!record) return;
      layer.bindPopup(popupForRecord(record));
      layer.on("click", () => selectRecord(record.name, false));
      layer.on("mouseover", () => layer.setStyle({ weight: 2.5, color: "#111827" }));
      layer.on("mouseout", () => countyLayer.resetStyle(layer));
    }
  }).addTo(map);
}

function fitMap() {
  if (state.country === "__all__") {
    const group = L.featureGroup();
    hotspotData.countries.forEach((country) => group.addLayer(L.marker(country.center)));
    if (countyLayer) group.addLayer(countyLayer);
    map.fitBounds(group.getBounds().pad(0.18));
    return;
  }

  const country = countryByName(state.country);
  if (!country) return;
  if (state.country === "Kenya" && countyLayer && countyLayer.getBounds().isValid()) {
    map.fitBounds(countyLayer.getBounds().pad(0.08));
    return;
  }
  map.setView(country.center, country.zoom);
}

function renderSummary(records) {
  const scores = records.map((record) => Number(metricForRecord(record))).filter(Number.isFinite);
  const avg = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
  const highest = records.length ? records.reduce((best, record) => {
    return (Number(metricForRecord(record)) || 0) > (Number(metricForRecord(best)) || 0) ? record : best;
  }, records[0]) : null;

  const sectorScores = hotspotData.meta.sectors.map((sector) => {
    const values = records.map((record) => record.metrics?.[sector]?.gender_hotspot_score).filter((value) => value != null);
    return { sector, avg: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null };
  }).filter((item) => item.avg != null);
  const top = sectorScores.length ? sectorScores.sort((a, b) => b.avg - a.avg)[0].sector : null;

  document.getElementById("visibleCount").textContent = records.length;
  document.getElementById("averageScore").textContent = formatScore(avg);
  document.getElementById("highestHotspot").textContent = highest?.name || "N/A";
  document.getElementById("topSector").textContent = top || "N/A";
}

function renderSectorChart(records) {
  const container = document.getElementById("sectorChart");
  const rows = hotspotData.meta.sectors.map((sector) => {
    const values = records.map((record) => record.metrics?.[sector]?.gender_hotspot_score).filter((value) => value != null);
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    return { sector, average };
  });

  container.innerHTML = rows.map(({ sector, average }) => `
    <div class="bar-row">
      <span>${sector}</span>
      <div class="bar-track"><i style="width:${average || 0}%"></i></div>
      <strong>${formatScore(average)}</strong>
    </div>
  `).join("");
}

function renderRiskList(records) {
  const counts = Object.fromEntries(RISK_ORDER.map((risk) => [risk, 0]));
  records.forEach((record) => {
    const risk = riskForRecord(record);
    if (counts[risk] != null) counts[risk] += 1;
  });

  document.getElementById("riskList").innerHTML = [...RISK_ORDER].reverse().map((risk) => `
    <div class="risk-row">
      <span><i style="background:${RISK_COLORS[risk]}"></i>${risk}</span>
      <strong>${counts[risk]}</strong>
    </div>
  `).join("");
}

function renderRecordCards(records) {
  const grid = document.getElementById("recordGrid");
  const empty = document.getElementById("emptyState");
  document.getElementById("recordsTitle").textContent =
    state.country === "__all__" ? "All detailed hotspot records" : `${state.country} hotspot records`;

  empty.hidden = records.length > 0;
  grid.innerHTML = records.map((record) => {
    const metrics = record.metrics[state.sector] || {};
    const indicators = (metrics.indicators || []).slice(0, 3).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    return `
      <article class="record-card ${selectedRecord?.name === record.name ? "is-selected" : ""}" data-record-name="${escapeHtml(record.name)}">
        <div class="record-top">
          <div>
            <span class="card-kicker">${escapeHtml(record.country)} - ${escapeHtml(state.sector)}</span>
            <h3>${escapeHtml(record.name)}</h3>
          </div>
          <strong style="color:${colorForRecord(record)}">${formatScore(metricForRecord(record))}</strong>
        </div>
        <div class="record-meta">
          <span>${escapeHtml(riskForRecord(record))}</span>
          <span>Top pressure: ${escapeHtml(record.top_sector || "N/A")}</span>
        </div>
        <div class="mini-grid">
          <span>Exposure <strong>${formatScore(metrics.exposure)}</strong></span>
          <span>Sensitivity <strong>${formatScore(metrics.sensitivity)}</strong></span>
          <span>Capacity <strong>${formatScore(metrics.adaptive_capacity)}</strong></span>
        </div>
        <ul>${indicators}</ul>
        <button class="read-more-btn" type="button" data-read-record="${escapeHtml(record.name)}">Read full report</button>
      </article>
    `;
  }).join("");
}

function renderLegend() {
  document.getElementById("mapLegend").innerHTML = [...RISK_ORDER].reverse().map((risk) => `
    <span><i style="background:${RISK_COLORS[risk]}"></i>${risk}</span>
  `).join("");
}

function renderMetricNote() {
  const country = state.country === "__all__" ? "All countries" : state.country;
  document.getElementById("metricNote").innerHTML = `
    <strong>${country} - ${state.sector}</strong>
    <p>${METRIC_COPY[state.metric]}</p>
  `;
}

function applyState() {
  const records = getFilteredRecords();
  if (selectedRecord && !records.some((record) => record.name === selectedRecord.name)) {
    selectedRecord = null;
    const overview = document.getElementById("countyOverview");
    if (overview) overview.hidden = true;
    document.getElementById("fullReport")?.remove();
  }
  renderCountryCards();
  renderCountryMarkers();
  renderCountyLayer();
  fitMap();
  renderSummary(records);
  renderSectorChart(records);
  renderRiskList(records);
  renderRecordCards(records);
  renderLegend();
  renderMetricNote();
}

async function init() {
  initMap();
  const [data, geojson] = await Promise.all([
    fetch("/api/hotspot-data").then((res) => res.json()),
    fetch("/data/kenya_districts.geojson").then((res) => res.json())
  ]);
  hotspotData = data;
  kenyaGeojson = geojson;

  buildOptions(document.getElementById("countrySelect"), hotspotData.meta.countries, "All study countries");
  buildOptions(document.getElementById("sectorSelect"), hotspotData.meta.sectors, null);
  document.getElementById("countrySelect").value = state.country;
  document.getElementById("sectorSelect").value = state.sector;
  document.getElementById("metricSelect").value = state.metric;

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
  document.getElementById("overviewReadMore").addEventListener("click", () => renderFullReport());
  document.addEventListener("click", (event) => {
    const readTarget = event.target.closest("[data-read-record]");
    if (readTarget) {
      const name = readTarget.getAttribute("data-read-record");
      selectRecord(name, true);
      renderFullReport(recordByCounty(name));
      return;
    }

    if (event.target.closest("[data-close-report]")) {
      document.getElementById("fullReport")?.remove();
    }
  });

  applyState();
}

init().catch((error) => {
  console.error("Failed to initialize hotspot map:", error);
  document.getElementById("recordGrid").innerHTML = `
    <article class="record-card">
      <h3>Map data could not be loaded</h3>
      <p>Please confirm the generated hotspot data file is available in the data folder.</p>
    </article>
  `;
});
