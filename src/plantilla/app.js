/* Lógica de la página. Todos los escenarios vienen precalculados en Python;
   aquí solo se filtran, se resumen y se dibujan. */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Datos incrustados
  // ---------------------------------------------------------------------------
  const appData = JSON.parse(document.getElementById("appData").textContent);
  const STATUS_KEPT = 0, STATUS_CAND = 1, STATUS_EXCL = 2;
  const UNASSIGNED = "Sin asignar";
  const colors = { kept: "#00918f", cand: "#e06c00", gray: "#8a94a0", ink: "#1d2730" };

  // Tiendas como objetos legibles
  const stores = appData.stores.map((r, i) => ({
    idx: i, id: r[0], lat: r[1], lon: r[2], volume: r[3],
    state: appData.states[r[4]], muni: appData.munis[r[5]], region: appData.regions[r[6]],
    cp: r[7], eligible: r[8] === 1, latText: r[9], lonText: r[10],
    hasCoords: r[1] !== null && r[2] !== null,
  }));
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const reviewByRow = new Map(appData.review.map((r) => [r.row, r]));

  // Escenario de referencia sin reducción + escenarios calculados
  const scenarios = [{
    radiusM: 0, label: "Sin reducción",
    status: stores.map((s) => (s.eligible ? STATUS_KEPT : STATUS_EXCL)),
    assigned: stores.map(() => -1), distanceM: stores.map(() => null),
  }].concat(appData.scenarios);

  // Para cada escenario: candidatas asignadas a cada conservada (para el clic en una conservada)
  scenarios.forEach((sc) => {
    sc.children = new Map();
    sc.assigned.forEach((a, i) => {
      if (a >= 0) {
        if (!sc.children.has(a)) sc.children.set(a, []);
        sc.children.get(a).push(i);
      }
    });
  });

  // Volúmenes elegibles ordenados (para la comparación "Top N")
  const statesWithStores = appData.states.filter((s) => stores.some((x) => x.state === s));

  // ---------------------------------------------------------------------------
  // Estado de la interfaz
  // ---------------------------------------------------------------------------
  const ui = {
    scenarioIdx: Math.min(1, scenarios.length - 1), // selección inicial: primer radio (no es recomendación)
    stateFilter: "",       // "" = toda la red
    view: "all",           // all | kept | cand
    selectedIdx: null,     // tienda seleccionada en el mapa
    showRadius: false,
    tableSearch: "", tableSort: { key: "volume", dir: -1 }, tablePage: 0,
    reviewFilter: "all",
  };

  // ---------------------------------------------------------------------------
  // Formato
  // ---------------------------------------------------------------------------
  const nf0 = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("es-MX", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtInt = (v) => nf0.format(v);
  const fmtPct = (v) => (v === null || isNaN(v) ? "—" : nf1.format(v) + "%");
  const fmtVol = (v) => (v === null || isNaN(v) ? "—" : nf2.format(v));
  const fmtDist = (m) => (m === null || m === undefined || isNaN(m) ? "—" : m >= 1000 ? nf2.format(m / 1000) + " km" : nf0.format(m) + " m");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const statusText = ["Conservada", "Candidata a cierre", "Excluida (revisión)"];
  const statusBadge = ["badgeKept", "badgeCand", "badgeGray"];
  const badge = (st) => `<span class="badge ${statusBadge[st]}">${statusText[st]}</span>`;

  const currentScenario = () => scenarios[ui.scenarioIdx];
  // "Sí" solo si ambas tiendas tienen estado y difieren; si a alguna le falta, "Indeterminado"
  const crossState = (a, b) => (a.state === UNASSIGNED || b.state === UNASSIGNED ? "Indeterminado" : a.state !== b.state ? "Sí" : "No");
  const inScope = (s) => !ui.stateFilter || s.state === ui.stateFilter;
  const scopeName = () => (ui.stateFilter ? `Estado: ${ui.stateFilter}` : "Toda la red");

  // ---------------------------------------------------------------------------
  // Métricas de un escenario dentro del ámbito actual (toda la red o un estado)
  // ---------------------------------------------------------------------------
  function computeMetrics(sc) {
    let nElig = 0, volElig = 0, nKept = 0, volKept = 0, nExcl = 0, volExcl = 0, nAll = 0, volAll = 0;
    let distSum = 0, distMax = 0, nCand = 0, nCross = 0, nUnknown = 0;
    const eligVolumes = [];
    stores.forEach((s, i) => {
      if (!inScope(s)) return;
      nAll++; volAll += s.volume || 0;
      if (!s.eligible) { nExcl++; volExcl += s.volume || 0; return; }
      nElig++; volElig += s.volume; eligVolumes.push(s.volume);
      if (sc.status[i] === STATUS_KEPT) { nKept++; volKept += s.volume; }
      else {
        nCand++;
        const d = sc.distanceM[i];
        distSum += d; distMax = Math.max(distMax, d);
        const cs = crossState(s, stores[sc.assigned[i]]);
        if (cs === "Sí") nCross++; else if (cs === "Indeterminado") nUnknown++;
      }
    });
    eligVolumes.sort((a, b) => b - a);
    let topN = 0;
    for (let k = 0; k < nKept; k++) topN += eligVolumes[k];
    return {
      nAll, volAll, nElig, volElig, nKept, volKept, nCand, nExcl, volExcl, nCross, nUnknown,
      reductionPct: nElig ? (100 * nCand) / nElig : 0,
      volPct: volElig ? (100 * volKept) / volElig : 0,
      topN, topNPct: volElig ? (100 * topN) / volElig : 0,
      costPp: volElig ? (100 * (topN - volKept)) / volElig : 0,
      distMean: nCand ? distSum / nCand : null, distMax: nCand ? distMax : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Controles
  // ---------------------------------------------------------------------------
  function buildSegmented(container, options, getValue, onPick) {
    container.innerHTML = "";
    options.forEach((opt) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.textContent = opt.label;
      b.dataset.value = opt.value;
      b.addEventListener("click", () => onPick(opt.value));
      container.appendChild(b);
    });
    const sync = () => container.querySelectorAll("button").forEach((b) =>
      b.setAttribute("aria-checked", String(b.dataset.value === String(getValue()))));
    sync();
    return sync;
  }

  const syncScenarioButtons = buildSegmented(
    document.getElementById("scenarioButtons"),
    scenarios.map((sc, i) => ({ label: sc.label, value: String(i) })),
    () => ui.scenarioIdx,
    (v) => { ui.scenarioIdx = Number(v); refreshAll({ keepView: true }); });

  const syncViewButtons = buildSegmented(
    document.getElementById("viewButtons"),
    [{ label: "Todas", value: "all" }, { label: "Conservadas", value: "kept" }, { label: "Candidatas", value: "cand" }],
    () => ui.view,
    (v) => { ui.view = v; refreshAll({ keepView: true }); });

  const stateSelect = document.getElementById("stateSelect");
  stateSelect.innerHTML = `<option value="">Toda la red (${fmtInt(stores.length)} registros)</option>` +
    statesWithStores.map((s) => {
      const n = stores.filter((x) => x.state === s).length;
      return `<option value="${esc(s)}">${esc(s)} (${fmtInt(n)})</option>`;
    }).join("");
  stateSelect.addEventListener("change", () => {
    ui.stateFilter = stateSelect.value;
    refreshAll({ fit: true });
  });

  document.getElementById("searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = document.getElementById("searchInput").value.trim();
    if (!q) return;
    let s = storeById.get(q);
    if (!s) {
      const matches = stores.filter((x) => x.id.startsWith(q));
      if (matches.length === 1) s = matches[0];
      else return showNotice(matches.length ? `Hay ${matches.length} IDs que empiezan con “${esc(q)}”; escribe el ID completo.` : `No se encontró el ID “${esc(q)}”.`);
    }
    focusStore(s.idx, true);
  });

  // ---------------------------------------------------------------------------
  // Mapa
  // ---------------------------------------------------------------------------
  const map = L.map("map", { preferCanvas: true, zoomControl: true, minZoom: 4, maxZoom: 18, worldCopyJump: false })
    .setView([23.6, -102.5], 5);
  map.createPane("contours"); map.getPane("contours").style.zIndex = 350; map.getPane("contours").style.pointerEvents = "none";
  map.createPane("links"); map.getPane("links").style.zIndex = 420;
  map.createPane("stores"); map.getPane("stores").style.zIndex = 450;
  map.createPane("selection"); map.getPane("selection").style.zIndex = 460;

  // Renderizado canvas: eficiente para ~6,000 puntos. 'tolerance' amplía el área de hover/toque.
  const storeRenderer = L.canvas({ padding: 0.3, tolerance: 4, pane: "stores" });
  const selectionRenderer = L.canvas({ padding: 0.3, tolerance: 4, pane: "selection" });

  // Mapa base en línea (Esri, sin clave; requiere internet). Si falla, puntos y contornos siguen operativos.
  const esriUrl = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_{kind}/MapServer/tile/{z}/{y}/{x}";
  const esriAttribution = "Mapa base &copy; Esri &mdash; Esri, HERE, Garmin, &copy; colaboradores de OpenStreetMap";
  map.createPane("labels"); map.getPane("labels").style.zIndex = 430; map.getPane("labels").style.pointerEvents = "none";
  const baseLayer = L.layerGroup([
    L.tileLayer(esriUrl, { kind: "Base", maxNativeZoom: 16, maxZoom: 18, attribution: esriAttribution }),
    L.tileLayer(esriUrl, { kind: "Reference", maxNativeZoom: 16, maxZoom: 18, pane: "labels" }),
  ]);
  let tileLoads = 0;
  baseLayer.eachLayer((t) => {
    t.on("tileload", () => { tileLoads++; });
    t.on("tileerror", () => { if (tileLoads === 0) baseUnavailable(); });
  });
  baseLayer.addTo(map);
  // Respaldo: si tras unos segundos no cargó ningún mosaico, se avisa (sin bloquear nada).
  setTimeout(() => { if (tileLoads === 0 && map.hasLayer(baseLayer)) baseUnavailable(); }, 5000);
  function baseUnavailable() {
    showNotice("No se pudo cargar el mapa base (¿sin internet?). Puntos y contornos siguen disponibles.", true);
  }

  const stateLayer = L.geoJSON(JSON.parse(document.getElementById("statesData").textContent), {
    pane: "contours", interactive: false,
    style: { color: "#5f6b78", weight: 1.1, opacity: 0.75, fill: false },
  }).addTo(map);

  let muniLayer = null; // se crea solo si el usuario lo activa
  function getMuniLayer() {
    if (!muniLayer) {
      muniLayer = L.geoJSON(JSON.parse(document.getElementById("munisData").textContent), {
        pane: "contours", interactive: false,
        style: { color: "#8a94a0", weight: 0.6, opacity: 0.7, dashArray: "2 3", fill: false },
      });
    }
    return muniLayer;
  }

  // Panel de capas
  const LayerPanel = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const div = L.DomUtil.create("div", "mapPanel");
      div.innerHTML = `<div class="panelTitle">Capas</div>
        <label><input type="checkbox" data-layer="base" checked> Mapa base</label>
        <label><input type="checkbox" data-layer="states" checked> Límites estatales</label>
        <label><input type="checkbox" data-layer="munis"> Municipios</label>`;
      L.DomEvent.disableClickPropagation(div);
      div.addEventListener("change", (e) => {
        const layer = { base: baseLayer, states: stateLayer, munis: null }[e.target.dataset.layer];
        const target = e.target.dataset.layer === "munis" ? getMuniLayer() : layer;
        if (e.target.checked) target.addTo(map); else map.removeLayer(target);
      });
      return div;
    },
  });
  new LayerPanel().addTo(map);

  // Leyenda con conteos del ámbito actual
  const legendDiv = L.DomUtil.create("div", "mapPanel");
  const Legend = L.Control.extend({ options: { position: "bottomleft" }, onAdd: () => legendDiv });
  new Legend().addTo(map);

  // Marcadores: uno por tienda con coordenadas válidas; se crean una sola vez.
  const markers = new Array(stores.length).fill(null);
  const markerGroup = L.layerGroup().addTo(map);
  const visible = new Set();

  function markerRadius() {
    const z = map.getZoom();
    return z <= 5 ? 2.6 : z <= 7 ? 3.4 : z <= 9 ? 4.5 : z <= 12 ? 6 : 7.5;
  }

  function styleFor(st) {
    if (st === STATUS_KEPT) return { fillColor: colors.kept, color: "#ffffff", weight: 0.8, fillOpacity: 0.9, opacity: 1 };
    if (st === STATUS_CAND) return { fillColor: colors.cand, color: "#ffffff", weight: 0.8, fillOpacity: 0.9, opacity: 1 };
    return { fillColor: colors.gray, color: "#ffffff", weight: 0.8, fillOpacity: 0.85, opacity: 1 };
  }

  stores.forEach((s) => {
    if (!s.hasCoords) return;
    const m = L.circleMarker([s.lat, s.lon], Object.assign({ renderer: storeRenderer, radius: markerRadius() }, styleFor(STATUS_EXCL)));
    // El contenido se calcula al abrir, así siempre refleja el escenario activo.
    m.bindTooltip(() => tooltipHtml(s.idx), { className: "storeTip", direction: "top", offset: [0, -6], opacity: 1 });
    m.on("click", () => selectStore(s.idx));
    markers[s.idx] = m;
  });

  function isVisible(s, sc) {
    if (!s.hasCoords || !inScope(s)) return false;
    const st = sc.status[s.idx];
    if (ui.view === "kept") return st === STATUS_KEPT;
    if (ui.view === "cand") return st === STATUS_CAND;
    return true;
  }

  function updateMarkers() {
    const sc = currentScenario();
    const r = markerRadius();
    const keptOnTop = [];
    stores.forEach((s) => {
      const m = markers[s.idx];
      if (!m) return;
      const show = isVisible(s, sc);
      if (show) {
        m.setStyle(styleFor(sc.status[s.idx]));
        m.setRadius(r);
        if (!visible.has(s.idx)) { markerGroup.addLayer(m); visible.add(s.idx); }
        if (sc.status[s.idx] === STATUS_KEPT) keptOnTop.push(m);
      } else if (visible.has(s.idx)) {
        markerGroup.removeLayer(m); visible.delete(s.idx);
      }
    });
    // Las conservadas se dibujan encima para que no queden ocultas bajo las candidatas
    keptOnTop.forEach((m) => m.bringToFront());
  }

  map.on("zoomend", () => {
    const r = markerRadius();
    visible.forEach((i) => markers[i].setRadius(r));
  });

  // ---------------------------------------------------------------------------
  // Tooltip, selección y conexiones
  // ---------------------------------------------------------------------------
  function infoGrid(s) {
    return `<div class="tipGrid">
      <span>Latitud</span><span>${esc(s.latText || "—")}</span>
      <span>Longitud</span><span>${esc(s.lonText || "—")}</span>
      <span>Estado</span><span>${esc(s.state)}</span>
      <span>Municipio</span><span>${esc(s.muni)}</span>
      <span>Región SIX</span><span>${esc(s.region)}</span>
      <span>Volumen</span><span>${fmtVol(s.volume)}</span>
    </div>`;
  }

  function tooltipHtml(i, forPopup) {
    const s = stores[i], sc = currentScenario(), st = sc.status[i];
    let foot = `Escenario ${esc(sc.label)}: ${badge(st)}`;
    if (st === STATUS_CAND && !forPopup) {
      const k = stores[sc.assigned[i]];
      foot += `<br>Cubierta por ${esc(k.id)} a ${fmtDist(sc.distanceM[i])}`;
    }
    return `<div class="tipTitle">ID ${esc(s.id)}</div>${infoGrid(s)}<div class="tipFoot">${foot}</div>`;
  }

  const selectionLayer = L.layerGroup().addTo(map);

  function clearSelection() {
    ui.selectedIdx = null; ui.showRadius = false;
    selectionLayer.clearLayers();
    map.closePopup();
  }

  function selectStore(i) {
    ui.selectedIdx = i; ui.showRadius = false;
    drawSelection(true);
  }

  // Dibuja la selección para el escenario ACTIVO (se borra al cambiar escenario o filtro)
  function drawSelection(openPopup) {
    selectionLayer.clearLayers();
    const i = ui.selectedIdx;
    if (i === null) return;
    const s = stores[i], sc = currentScenario(), st = sc.status[i];
    const ring = (x, color) => L.circleMarker([x.lat, x.lon], { renderer: selectionRenderer, radius: markerRadius() + 4, color, weight: 2.5, fill: false, interactive: false });
    let html = tooltipHtml(i, true);
    const actions = [];
    const review = reviewByRow.get(i);

    if (st === STATUS_CAND) {
      const k = stores[sc.assigned[i]];
      L.polyline([[s.lat, s.lon], [k.lat, k.lon]], { pane: "links", color: colors.ink, weight: 2, dashArray: "5 4", interactive: false }).addTo(selectionLayer);
      ring(k, colors.kept).addTo(selectionLayer);
      if (ui.showRadius) circleAround(k, sc).addTo(selectionLayer);
      html += `<div class="tipFoot">Tienda conservada asignada: <strong>${esc(k.id)}</strong> (${esc(k.muni)}, ${esc(k.state)})<br>
        Distancia en línea recta: <strong>${fmtDist(sc.distanceM[i])}</strong> · volumen ${fmtVol(k.volume)}
        ${crossState(s, k) === "Sí" ? '<br><span class="warnText">Asignación entre estados</span>' : crossState(s, k) === "Indeterminado" ? '<br><span class="warnText">Una de las dos tiendas no tiene estado asignado</span>' : ""}</div>`;
      actions.push(`<button type="button" data-action="radius">${ui.showRadius ? "Ocultar" : "Ver"} radio de ${esc(sc.label)}</button>`);
      actions.push(`<button type="button" data-action="goto" data-idx="${k.idx}">Ir a la conservada</button>`);
    } else if (st === STATUS_KEPT && sc.radiusM > 0) {
      const kids = sc.children.get(i) || [];
      kids.forEach((c) => {
        const x = stores[c];
        L.polyline([[s.lat, s.lon], [x.lat, x.lon]], { pane: "links", color: colors.cand, weight: 1.5, opacity: 0.9, interactive: false }).addTo(selectionLayer);
      });
      if (ui.showRadius) circleAround(s, sc).addTo(selectionLayer);
      const kidsVol = kids.reduce((a, c) => a + stores[c].volume, 0);
      html += `<div class="tipFoot">Candidatas asignadas a esta tienda: <strong>${fmtInt(kids.length)}</strong>${kids.length ? ` · volumen ${fmtVol(kidsVol)}` : ""}</div>`;
      actions.push(`<button type="button" data-action="radius">${ui.showRadius ? "Ocultar" : "Ver"} radio de ${esc(sc.label)}</button>`);
    }
    if (review) {
      html += `<div class="tipFoot warnText">${review.issues.map(esc).join("<br>")}</div>`;
    }
    ring(s, colors.ink).addTo(selectionLayer);
    if (actions.length) html += `<div class="popActions">${actions.join("")}</div>`;
    if (openPopup !== false) {
      // Se registra antes de abrir: el cierre del popup anterior no debe borrar esta selección
      currentPopup = L.popup({ maxWidth: 320, autoPanPadding: [20, 20] }).setLatLng([s.lat, s.lon]).setContent(html);
      currentPopup.openOn(map);
    }
  }

  // Un solo círculo de radio a la vez (evita dibujar miles de círculos)
  function circleAround(k, sc) {
    return L.circle([k.lat, k.lon], { radius: sc.radiusM, pane: "links", color: colors.kept, weight: 1.5, fillColor: colors.kept, fillOpacity: 0.08, interactive: false });
  }

  let currentPopup = null;
  map.on("popupclose", (e) => {
    if (e.popup !== currentPopup) return;
    currentPopup = null; selectionLayer.clearLayers(); ui.selectedIdx = null; ui.showRadius = false;
  });
  document.getElementById("map").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "radius") {
      ui.showRadius = !ui.showRadius;
      drawSelection(true);
    } else if (btn.dataset.action === "goto") {
      focusStore(Number(btn.dataset.idx), false);
    }
  });

  // Centra el mapa en una tienda; si el filtro o la vista la ocultan, los ajusta y lo avisa.
  function focusStore(i, fromSearch) {
    const s = stores[i];
    if (!s.hasCoords) {
      const rev = reviewByRow.get(i);
      showNotice(`La tienda ${esc(s.id)} no tiene coordenadas válidas (${esc(rev ? rev.issues[0] : "sin ubicación")}). Consulta “Registros que necesitan revisión”.`);
      document.getElementById("reviewDetails").open = true;
      return;
    }
    let changed = [];
    if (!inScope(s)) { ui.stateFilter = ""; stateSelect.value = ""; changed.push("se quitó el filtro de estado"); }
    if (!isVisible(s, currentScenario())) { ui.view = "all"; changed.push("se muestran todas las tiendas"); }
    if (changed.length) refreshAll({ keepView: true });
    if (fromSearch && changed.length) showNotice(`Para mostrar ${esc(s.id)} ${changed.join(" y ")}.`);
    map.setView([s.lat, s.lon], Math.max(map.getZoom(), 14));
    selectStore(i);
    document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  let noticeTimer = null;
  function showNotice(text, sticky) {
    const el = document.getElementById("mapNotice");
    el.innerHTML = text; el.hidden = false;
    clearTimeout(noticeTimer);
    if (!sticky) noticeTimer = setTimeout(() => { el.hidden = true; }, 6000);
  }

  function fitToScope() {
    const pts = stores.filter((s) => s.hasCoords && inScope(s)).map((s) => [s.lat, s.lon]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 13 });
  }

  // ---------------------------------------------------------------------------
  // Indicadores, leyenda y comparación
  // ---------------------------------------------------------------------------
  function updateKpis() {
    const sc = currentScenario(), m = computeMetrics(sc);
    document.getElementById("scopeText").textContent = `Cifras de: ${scopeName()} · escenario ${sc.label}`;
    document.getElementById("scenarioNote").textContent = ui.scenarioIdx === 1
      ? "Selección inicial: el primer radio; no es una recomendación." : "";
    document.getElementById("kpiKept").textContent = fmtInt(m.nKept);
    document.getElementById("kpiKeptSub").textContent = `de ${fmtInt(m.nElig)} tiendas elegibles`;
    document.getElementById("kpiCand").textContent = fmtInt(m.nCand);
    document.getElementById("kpiCandSub").textContent = m.nCross ? `${fmtInt(m.nCross)} asignadas a tienda de otro estado` + (m.nUnknown ? ` · ${fmtInt(m.nUnknown)} con estado indeterminado` : "") : "todas con una conservada dentro del radio";
    document.getElementById("kpiRed").textContent = fmtPct(m.reductionPct);
    document.getElementById("kpiRedSub").textContent = "candidatas ÷ tiendas elegibles";
    document.getElementById("kpiVol").textContent = fmtPct(m.volPct);
    document.getElementById("kpiVolSub").textContent = `${fmtVol(m.volKept)} ÷ volumen elegible ${fmtVol(m.volElig)}`;

    const nExclMapped = stores.filter((s) => inScope(s) && !s.eligible && s.hasCoords).length;
    const nExclNoMap = stores.filter((s) => inScope(s) && !s.eligible && !s.hasCoords).length;
    legendDiv.innerHTML = `<div class="panelTitle">${esc(sc.label)} · ${esc(ui.stateFilter || "Toda la red")}</div>
      <div class="legendRow"><span class="dot dotKept"></span>Conservada<span class="legendCount">${fmtInt(m.nKept)}</span></div>
      <div class="legendRow"><span class="dot dotCand"></span>Candidata a cierre<span class="legendCount">${fmtInt(m.nCand)}</span></div>
      <div class="legendRow"><span class="dot dotGray"></span>Excluida (revisión)<span class="legendCount">${fmtInt(nExclMapped)}</span></div>
      ${nExclNoMap ? `<div class="legendRow muted">+${fmtInt(nExclNoMap)} excluidas sin ubicación válida</div>` : ""}`;
  }

  function updateCompare() {
    const rows = scenarios.map((sc, i) => ({ sc, i, m: computeMetrics(sc) }));
    const base = rows[0].m;
    document.getElementById("compareScope").innerHTML =
      `Ámbito: <strong>${esc(scopeName())}</strong>. Denominadores: reducción = candidatas ÷ ${fmtInt(base.nElig)} tiendas elegibles;
       volumen = volumen conservado ÷ ${fmtVol(base.volElig)} de volumen elegible. Excluidos del análisis:
       ${fmtInt(base.nExcl)} registros con volumen ${fmtVol(base.volExcl)} (${fmtPct(base.volAll ? 100 * base.volExcl / base.volAll : 0)} del volumen total de ${fmtVol(base.volAll)}).`;
    const head = `<thead><tr><th>Escenario</th><th class="num">Conservadas</th><th class="num">Candidatas</th><th class="num">Reducción</th>
      <th class="num">Volumen conservado</th><th class="num">% vol. elegible</th><th class="num">% vol. Top N</th>
      <th class="num">Costo de proximidad</th><th class="num">Dist. media / máx.</th><th class="num">Entre estados</th></tr></thead>`;
    const body = rows.map(({ sc, i, m }) => `<tr class="${i === ui.scenarioIdx ? "activeRow" : ""}">
      <td>${esc(sc.label)}</td><td class="num">${fmtInt(m.nKept)}</td><td class="num">${fmtInt(m.nCand)}</td>
      <td class="num">${fmtPct(m.reductionPct)}</td><td class="num">${fmtVol(m.volKept)}</td><td class="num">${fmtPct(m.volPct)}</td>
      <td class="num">${fmtPct(m.topNPct)}</td><td class="num">${i === 0 ? "—" : nf1.format(m.costPp) + " pp"}</td>
      <td class="num">${m.distMean === null ? "—" : fmtDist(m.distMean) + " / " + fmtDist(m.distMax)}</td>
      <td class="num">${i === 0 ? "—" : fmtInt(m.nCross) + (m.nUnknown ? ` <span class="muted">(+${fmtInt(m.nUnknown)} indet.)</span>` : "")}</td></tr>`).join("");
    document.getElementById("compareTable").innerHTML = head + `<tbody>${body}</tbody>`;
    const sel = rows[ui.scenarioIdx];
    document.getElementById("compareNote").innerHTML =
      `<p><strong>Top N por volumen</strong>: si conserváramos el mismo número de tiendas que la heurística, pero eligiendo solo las de mayor
       volumen (sin importar la proximidad), ¿qué porcentaje del volumen elegible concentraríamos? La diferencia en puntos porcentuales (pp)
       es el <strong>costo de mantener proximidad</strong> a las ubicaciones actuales.</p>` +
      (ui.scenarioIdx > 0 ? `<p>Con <strong>${esc(sel.sc.label)}</strong> (${esc(scopeName())}): se reducen ${fmtPct(sel.m.reductionPct)} de las tiendas
       y se conserva ${fmtPct(sel.m.volPct)} del volumen histórico elegible; elegir las mismas ${fmtInt(sel.m.nKept)} tiendas solo por volumen
       concentraría ${fmtPct(sel.m.topNPct)} (${nf1.format(sel.m.costPp)} pp más), pero sin garantizar cercanía a las ubicaciones cerradas.</p>` : "") +
      `<p>No se elige un escenario “ganador”: un radio mayor reduce más tiendas pero conserva menos volumen histórico. La elección requiere
       un criterio explícito del negocio (por ejemplo, un mínimo de volumen a conservar o una distancia máxima aceptable).</p>`;
    drawChart(rows);
  }

  // Gráfico de barras agrupadas en SVG (sin dependencias)
  function drawChart(rows) {
    const W = 460, H = 250, pad = { l: 40, r: 10, t: 22, b: 46 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const groupW = iw / rows.length, barW = Math.min(30, groupW / 3.2), gap = 3;
    const y = (v) => pad.t + ih - (v / 100) * ih;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Porcentaje del volumen elegible conservado por escenario">`;
    [0, 25, 50, 75, 100].forEach((t) => {
      svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" stroke="#e2e5e8" stroke-width="1"/>
        <text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end" font-size="10" fill="#6b7682">${t}%</text>`;
    });
    rows.forEach(({ sc, i, m }) => {
      const cx = pad.l + groupW * i + groupW / 2;
      const x1 = cx - barW - gap / 2, x2 = cx + gap / 2;
      const active = i === ui.scenarioIdx;
      svg += `<g class="bar" data-i="${i}">
        <rect x="${cx - groupW / 2 + 2}" y="${pad.t}" width="${groupW - 4}" height="${ih}" fill="${active ? "#f1f4f6" : "transparent"}" rx="6"/>
        <path d="${barPath(x1, y(m.volPct), barW, y(0))}" fill="${colors.kept}"/>
        <path d="${barPath(x2 + 0.75, y(m.topNPct) + 0.75, barW - 1.5, y(0))}" fill="#ffffff" stroke="#4a5561" stroke-width="1.5"/>
        <text x="${x1 + barW / 2}" y="${y(m.volPct) - 5}" text-anchor="middle" font-size="10" font-weight="600" fill="#1d2730">${Math.round(m.volPct)}%</text>
        <text x="${cx}" y="${H - pad.b + 16}" text-anchor="middle" font-size="11" font-weight="${active ? 700 : 500}" fill="#1d2730">${esc(sc.label)}</text>
        <text x="${cx}" y="${H - pad.b + 31}" text-anchor="middle" font-size="10" fill="#6b7682">${i === 0 ? "0 cierres" : "−" + Math.round(m.reductionPct) + "% tiendas"}</text>
      </g>`;
    });
    svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}" stroke="#9aa3ad" stroke-width="1"/></svg>`;
    const box = document.getElementById("chart");
    box.innerHTML = svg;
    const tip = document.getElementById("chartTip");
    box.querySelectorAll(".bar").forEach((g) => {
      const { sc, m, i } = rows[Number(g.dataset.i)];
      g.addEventListener("mousemove", (e) => {
        tip.innerHTML = `<strong>${esc(sc.label)}</strong><br>Reducción: ${fmtPct(m.reductionPct)} (${fmtInt(m.nCand)} candidatas)<br>
          Heurística: ${fmtPct(m.volPct)} del volumen elegible<br>Top ${fmtInt(m.nKept)} por volumen: ${fmtPct(m.topNPct)}
          ${i ? `<br>Costo de proximidad: ${nf1.format(m.costPp)} pp` : ""}`;
        tip.hidden = false;
        tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 270) + "px";
        tip.style.top = e.clientY + 14 + "px";
      });
      g.addEventListener("mouseleave", () => { tip.hidden = true; });
      g.style.cursor = "pointer";
      g.addEventListener("click", () => { ui.scenarioIdx = i; refreshAll({ keepView: true }); });
    });
  }

  // Barra con extremo superior redondeado (4 px) anclada a la línea base
  function barPath(x, yTop, w, yBase) {
    const r = Math.min(4, w / 2, Math.max(0, yBase - yTop));
    return `M${x},${yBase} L${x},${yTop + r} Q${x},${yTop} ${x + r},${yTop} L${x + w - r},${yTop} Q${x + w},${yTop} ${x + w},${yTop + r} L${x + w},${yBase} Z`;
  }

  // ---------------------------------------------------------------------------
  // Tabla de tiendas
  // ---------------------------------------------------------------------------
  const PAGE_SIZE = 20;
  const tableCols = [
    { key: "id", label: "ID" }, { key: "state", label: "Estado" }, { key: "muni", label: "Municipio" },
    { key: "region", label: "Región SIX" }, { key: "volume", label: "Volumen", num: true },
    { key: "status", label: "Clasificación" }, { key: "assignedId", label: "Asignada a" },
    { key: "distance", label: "Distancia", num: true },
  ];

  function tableRows() {
    const sc = currentScenario();
    const q = ui.tableSearch.toLowerCase();
    const rows = stores.filter((s) => {
      if (!inScope(s)) return false;
      const st = sc.status[s.idx];
      if (ui.view === "kept" && st !== STATUS_KEPT) return false;
      if (ui.view === "cand" && st !== STATUS_CAND) return false;
      return !q || s.id.includes(q) || s.muni.toLowerCase().includes(q);
    }).map((s) => ({
      s, id: s.id, state: s.state, muni: s.muni, region: s.region, volume: s.volume ?? -1,
      status: sc.status[s.idx], assignedId: sc.assigned[s.idx] >= 0 ? stores[sc.assigned[s.idx]].id : "",
      distance: sc.distanceM[s.idx] ?? -1,
    }));
    const { key, dir } = ui.tableSort;
    rows.sort((a, b) => (a[key] < b[key] ? -dir : a[key] > b[key] ? dir : a.id < b.id ? -1 : 1));
    return rows;
  }

  function updateTable() {
    const sc = currentScenario();
    const rows = tableRows();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    ui.tablePage = Math.min(ui.tablePage, pages - 1);
    const viewText = { all: "todas las clasificaciones", kept: "solo conservadas", cand: "solo candidatas" }[ui.view];
    document.getElementById("storesScope").textContent = `${scopeName()} · escenario ${sc.label} · ${viewText}. Haz clic en una fila para verla en el mapa.`;
    document.getElementById("tableCount").textContent = `${fmtInt(rows.length)} tiendas`;
    document.getElementById("downloadBtn").textContent = `Descargar CSV (${sc.label} · ${ui.stateFilter || "toda la red"})`;
    const head = "<thead><tr>" + tableCols.map((c) => {
      const arrow = ui.tableSort.key === c.key ? (ui.tableSort.dir < 0 ? " ↓" : " ↑") : "";
      return `<th class="sortable ${c.num ? "num" : ""}" data-key="${c.key}">${c.label}${arrow}</th>`;
    }).join("") + "</tr></thead>";
    const body = rows.slice(ui.tablePage * PAGE_SIZE, (ui.tablePage + 1) * PAGE_SIZE).map((r) => `<tr data-idx="${r.s.idx}">
      <td>${esc(r.id)}</td><td>${esc(r.state)}</td><td>${esc(r.muni)}</td><td>${esc(r.region)}</td>
      <td class="num">${fmtVol(r.s.volume)}</td><td>${badge(r.status)}</td><td>${esc(r.assignedId) || "—"}</td>
      <td class="num">${r.distance >= 0 ? fmtDist(r.distance) : "—"}</td></tr>`).join("");
    document.getElementById("storesTable").innerHTML = head + `<tbody>${body || '<tr><td colspan="8" class="muted">Sin resultados</td></tr>'}</tbody>`;
    document.getElementById("pager").innerHTML = `<button type="button" data-page="-1" ${ui.tablePage === 0 ? "disabled" : ""}>Anterior</button>
      <span>Página ${ui.tablePage + 1} de ${pages}</span>
      <button type="button" data-page="1" ${ui.tablePage >= pages - 1 ? "disabled" : ""}>Siguiente</button>`;
  }

  document.getElementById("storesTable").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-key]");
    if (th) {
      const key = th.dataset.key;
      ui.tableSort = { key, dir: ui.tableSort.key === key ? -ui.tableSort.dir : (key === "volume" || key === "distance" ? -1 : 1) };
      ui.tablePage = 0;
      return updateTable();
    }
    const tr = e.target.closest("tr[data-idx]");
    if (tr) focusStore(Number(tr.dataset.idx), false);
  });
  document.getElementById("pager").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-page]");
    if (b) { ui.tablePage += Number(b.dataset.page); updateTable(); }
  });
  document.getElementById("tableSearch").addEventListener("input", (e) => {
    ui.tableSearch = e.target.value.trim(); ui.tablePage = 0; updateTable();
  });

  // ---------------------------------------------------------------------------
  // Descarga CSV del escenario activo (en el ámbito actual)
  // ---------------------------------------------------------------------------
  document.getElementById("downloadBtn").addEventListener("click", () => {
    const sc = currentScenario();
    const header = ["id", "region_six", "cp", "latitud", "longitud", "volumen", "estado", "municipio", "elegible",
      "escenario", "clasificacion", "asignada_a", "distancia_m", "asignacion_entre_estados", "observaciones"];
    const q = (v) => { const t = String(v ?? ""); return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = [header.join(",")];
    stores.forEach((s) => {
      if (!inScope(s)) return;
      const st = sc.status[s.idx], a = sc.assigned[s.idx];
      const rev = reviewByRow.get(s.idx);
      lines.push([s.id, s.region, s.cp, s.latText, s.lonText, s.volume, s.state, s.muni, s.eligible ? "Sí" : "No",
        sc.label, statusText[st], a >= 0 ? stores[a].id : "", sc.distanceM[s.idx] ?? "",
        a >= 0 ? crossState(s, stores[a]) : "", rev ? rev.issues.join(" | ") : ""].map(q).join(","));
    });
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    const scopeSlug = (ui.stateFilter || "toda_la_red").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\W+/g, "_");
    a.href = URL.createObjectURL(blob);
    a.download = `tiendas_${sc.label.replace(/\s+/g, "")}_${scopeSlug}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // ---------------------------------------------------------------------------
  // Registros para revisión, contornos y comprobaciones
  // ---------------------------------------------------------------------------
  const nExcluded = appData.review.filter((r) => r.excluded).length;
  const volExcluded = appData.review.filter((r) => r.excluded).reduce((a, r) => a + (stores[r.row].volume || 0), 0);
  document.getElementById("reviewSummary").textContent =
    `Registros que necesitan revisión (${fmtInt(appData.review.length)}): ${fmtInt(nExcluded)} excluidos del análisis · ` +
    `volumen excluido ${fmtVol(volExcluded)} · ${fmtInt(appData.review.length - nExcluded)} con observaciones`;

  const syncReviewButtons = buildSegmented(document.getElementById("reviewButtons"),
    [{ label: "Todos", value: "all" }, { label: `Excluidos (${nExcluded})`, value: "excluded" },
     { label: `Observaciones (${appData.review.length - nExcluded})`, value: "warning" }],
    () => ui.reviewFilter, (v) => { ui.reviewFilter = v; syncReviewButtons(); updateReview(); });

  function updateReview() {
    const rows = appData.review.filter((r) => ui.reviewFilter === "all" || (ui.reviewFilter === "excluded") === r.excluded);
    const head = `<thead><tr><th class="num">Línea</th><th>ID</th><th>Latitud</th><th>Longitud</th><th>CP</th><th class="num">Volumen</th>
      <th>Estado</th><th>Situación</th><th>Problemas detectados</th></tr></thead>`;
    const body = rows.map((r) => {
      const s = stores[r.row];
      return `<tr><td class="num">${r.line}</td><td>${esc(s.id)}</td><td>${esc(s.latText || "—")}</td><td>${esc(s.lonText || "—")}</td>
        <td>${esc(s.cp)}</td><td class="num">${fmtVol(s.volume)}</td><td>${esc(s.state)}</td>
        <td>${r.excluded ? '<span class="badge badgeGray">Excluido</span>' : '<span class="badge badgeKept">Elegible</span>'}</td>
        <td class="wrapCell">${r.issues.map(esc).join("<br>")}</td></tr>`;
    }).join("");
    document.getElementById("reviewTable").innerHTML = head + `<tbody>${body}</tbody>`;
  }

  document.getElementById("contourList").innerHTML = appData.contourReport.map((c) =>
    `<li><strong>${esc(c.archivo)}</strong> — ${esc(c.estado)}: ${esc(c.detalle)}</li>`).join("");
  document.getElementById("checkList").innerHTML = appData.checks.map((c) =>
    `<li><span class="${c.resultado === "OK" ? "ok" : "fail"}">${esc(c.resultado)}</span> ${esc(c.comprobacion)}</li>`).join("");
  document.getElementById("generatedAt").textContent = appData.generatedAt;

  // ---------------------------------------------------------------------------
  // Actualización coherente de todo al cambiar escenario, filtro o vista
  // ---------------------------------------------------------------------------
  function refreshAll(opts) {
    clearSelection(); // evita mostrar detalles de un escenario o filtro anterior
    syncScenarioButtons(); syncViewButtons();
    stateSelect.value = ui.stateFilter;
    updateMarkers(); updateKpis(); updateCompare();
    ui.tablePage = 0; updateTable();
    if (opts && opts.fit) fitToScope();
  }

  updateReview();
  refreshAll({ fit: true });

  // Gancho mínimo para pruebas automatizadas (no afecta al uso normal)
  window.storeApp = { ui, stores, scenarios, computeMetrics, markers, visible, map, focusStore };
})();
