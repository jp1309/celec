/* CELEC · Dashboard Energético
   - Navegación por pestañas
   - Producción: Líneas (Eje X: Fecha Real) + Proporción Total (Pie)
   - Hidrología: Eje X: Día del año para comparación
*/

(function () {
  "use strict";

  const DATA_BASE = "data/";
  const FILES = {
    meta: DATA_BASE + "meta.json",
    prod: DATA_BASE + "produccion_diaria_larga.csv",
    hidro: DATA_BASE + "hidrologia_diaria_larga.csv",
  };

  // ---- DOM References ----
  const $ = (id) => document.getElementById(id);
  const metaStatus = $("metaStatus");

  // Tab Navigation
  const tabBtns = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".module-content");

  // Production Controls
  const selProdCentral = $("prodCentral");
  const selProdYears = $("prodYears");
  const plotProdLine = $("plotProdLine");
  const plotProdPie = $("plotProdPie");

  // Hydrology Controls
  const selHidroCentral = $("hidroCentral");
  const selHidroYears = $("hidroYears");
  const plotHidroMain = $("plotHidroMain");

  // ---- State ----
  let META = null;
  let PROD_DATA = null;
  let HIDRO_DATA = null;

  // ---- Tab Logic ----
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const tabId = btn.getAttribute("data-tab");

      tabBtns.forEach(b => b.classList.remove("active"));
      tabContents.forEach(c => c.classList.remove("active"));

      btn.classList.add("active");
      $(`tab-${tabId}`).classList.add("active");

      // Force restyle of plots when switching tabs
      if (tabId === "prod") drawProduction();
      else drawHidrology();
    });
  });

  // ---- Helpers ----
  function doyFromISO(iso) {
    const d = new Date(iso + "T00:00:00Z");
    const year = d.getUTCFullYear();
    const start = new Date(Date.UTC(year, 0, 1));
    const diff = d - start;
    return Math.floor(diff / 86400000) + 1;
  }

  function clearSelect(sel) {
    while (sel && sel.firstChild) sel.removeChild(sel.firstChild);
  }

  function addOption(sel, value, label) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  }

  function getSelectedValues(sel) {
    return Array.from(sel.options).filter(opt => opt.selected).map(opt => opt.value);
  }

  function parseNumber(x) {
    if (x === null || x === undefined) return NaN;
    const s = String(x).trim().replace(",", ".");
    const v = Number(s);
    return Number.isFinite(v) ? v : NaN;
  }

  async function loadCSV(url) {
    const resp = await fetch(url, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
    const text = await resp.text();
    const lines = text.trim().split("\n");
    if (lines.length < 1) return [];
    const headers = lines[0].split(",").map(h => h.trim());
    return lines.slice(1).map(line => {
      const values = line.split(",").map(v => v.trim());
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = values[i] || "";
      });
      return obj;
    });
  }

  // ---- Redraw Logic ----
  function drawProduction() {
    if (!PROD_DATA || !META) return;

    const serie = selProdCentral.value;
    const years = getSelectedValues(selProdYears).map(Number);
    const yearSet = new Set(years);

    // 1. Line Chart (Full Date X-Axis)
    const lineRows = PROD_DATA.filter(r => r.serie === serie && yearSet.has(Number(r.date.slice(0, 4))));

    // Group for different colors by year in line chart
    const tracesLine = [];
    const colors = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4"];

    years.sort().forEach((y, i) => {
      const yearRows = lineRows.filter(r => r.date.startsWith(String(y)));
      if (yearRows.length === 0) return;

      tracesLine.push({
        type: "scatter",
        mode: "lines",
        name: String(y),
        x: yearRows.map(r => r.date),
        y: yearRows.map(r => r.value),
        line: { color: colors[i % colors.length], width: 2 },
        hovertemplate: "%{x}<br>%{y:.2f} MWh<extra></extra>"
      });
    });

    Plotly.react(plotProdLine, tracesLine, baseLayout(`${serie} - Evolución Temporal`, "MWh", true), { responsive: true, displayModeBar: false });

    // 2. Pie Chart (Comparison of plants for selected range)
    // We calculate total by plant excluding the sum series "CSR..."
    const pieDataMap = new Map();
    const plantsToInclude = META.produccion.series.filter(s => !s.includes("CSR") && !s.includes("+"));

    plantsToInclude.forEach(p => {
      const total = PROD_DATA
        .filter(r => r.serie === p && yearSet.has(Number(r.date.slice(0, 4))))
        .reduce((acc, r) => acc + (parseNumber(r.value) || 0), 0);
      if (total > 0) pieDataMap.set(p, total);
    });

    const tracesPie = [{
      type: "pie",
      labels: Array.from(pieDataMap.keys()),
      values: Array.from(pieDataMap.values()),
      hole: 0.4,
      marker: { colors: colors },
      textinfo: "percent+label",
      insidetextorientation: "radial",
      automargin: true
    }];

    Plotly.react(plotProdPie, tracesPie, {
      title: { text: "Distribución por Central", font: { color: "#f8fafc", size: 14 } },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      margin: { t: 50, b: 20, l: 20, r: 20 },
      showlegend: false
    }, { responsive: true, displayModeBar: false });
  }

  function drawHidrology() {
    if (!HIDRO_DATA || !META) return;

    const serie = selHidroCentral.value;
    const years = getSelectedValues(selHidroYears).map(Number);
    if (!serie || years.length === 0) return;

    const rows = HIDRO_DATA.filter(r => r.serie === serie);
    const caudalVar = "Caudal (m³/s)";
    const cotaVar = "Cota (msnm)";

    const traces = [];
    const colors = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4"];
    const yearSet = new Set(years);

    years.sort().forEach((y, i) => {
      const yearRows = rows.filter(r => r.date.startsWith(String(y)));

      // Caudal Lines
      const caudalRows = yearRows.filter(r => r.variable === caudalVar).sort((a, b) => doyFromISO(a.date) - doyFromISO(b.date));
      if (caudalRows.length > 0) {
        traces.push({
          type: "scatter", mode: "lines", name: `${y} Caudal`,
          x: caudalRows.map(r => doyFromISO(r.date)),
          y: caudalRows.map(r => r.value),
          line: { color: colors[i % colors.length], width: 2.5 },
          yaxis: "y"
        });
      }

      // Cota Lines (Dashed)
      const cotaRows = yearRows.filter(r => r.variable === cotaVar).sort((a, b) => doyFromISO(a.date) - doyFromISO(b.date));
      if (cotaRows.length > 0) {
        traces.push({
          type: "scatter", mode: "lines", name: `${y} Cota`,
          x: cotaRows.map(r => doyFromISO(r.date)),
          y: cotaRows.map(r => r.value),
          line: { color: colors[i % colors.length], dash: "dot", width: 1.5 },
          yaxis: "y2",
          opacity: 0.5
        });
      }
    });

    const layout = baseLayout(`Hidrología · ${serie}`, caudalVar, false);
    layout.yaxis2 = {
      title: cotaVar, overlaying: "y", side: "right",
      showgrid: false, zeroline: false,
      tickfont: { color: "#94a3b8" }, titlefont: { color: "#94a3b8" }
    };

    Plotly.react(plotHidroMain, traces, layout, { responsive: true, displayModeBar: false });
  }

  function baseLayout(title, yTitle, isDateX) {
    return {
      title: {
        text: title,
        font: { family: 'Outfit, sans-serif', color: '#f8fafc', size: 16 },
        x: 0.05
      },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      margin: { l: 60, r: 60, t: 80, b: 60 },
      showlegend: true,
      legend: { orientation: "h", y: 1.15, font: { color: "#94a3b8" } },
      xaxis: {
        title: isDateX ? "Fecha" : "Día del Año",
        type: isDateX ? "date" : "linear",
        gridcolor: "rgba(255,255,255,0.05)",
        tickfont: { color: "#94a3b8" },
        titlefont: { color: "#94a3b8" },
        range: isDateX ? undefined : [1, 366]
      },
      yaxis: {
        title: yTitle,
        gridcolor: "rgba(255,255,255,0.05)",
        tickfont: { color: "#94a3b8" },
        titlefont: { color: "#94a3b8" },
        zeroline: false
      }
    };
  }

  // ---- Init ----
  async function boot() {
    try {
      metaStatus.textContent = "Cargando metadatos...";
      META = await (await fetch(FILES.meta)).json();

      // Populate Production
      clearSelect(selProdCentral);
      const sumSeries = META.produccion.series.find(s => s.includes("CSR") || s.includes("+"));
      META.produccion.series.forEach(s => addOption(selProdCentral, s, s));
      if (sumSeries) selProdCentral.value = sumSeries;

      clearSelect(selProdYears);
      META.produccion.years.sort((a, b) => b - a).forEach(y => addOption(selProdYears, y, y));
      if (selProdYears.options.length >= 1) selProdYears.options[0].selected = true;

      // Populate Hydrology
      clearSelect(selHidroCentral);
      META.hidrologia.series.forEach(s => addOption(selHidroCentral, s, s));
      selHidroCentral.value = META.hidrologia.series[0];

      clearSelect(selHidroYears);
      META.hidrologia.years.sort((a, b) => b - a).forEach(y => addOption(selHidroYears, y, y));
      if (selHidroYears.options.length >= 1) selHidroYears.options[0].selected = true;

      metaStatus.textContent = "Datos listos";

      const [pData, hData] = await Promise.all([
        loadCSV(FILES.prod),
        loadCSV(FILES.hidro)
      ]);

      PROD_DATA = pData.map(r => ({ date: r.date, serie: r.serie, variable: r.variable, value: r.value }));
      HIDRO_DATA = hData.map(r => ({ date: r.date, serie: r.serie, variable: r.variable, value: r.value }));

      // Listeners
      selProdCentral.addEventListener("change", drawProduction);
      selProdYears.addEventListener("change", drawProduction);
      selHidroCentral.addEventListener("change", drawHidrology);
      selHidroYears.addEventListener("change", drawHidrology);

      drawProduction();
    } catch (e) {
      console.error(e);
      metaStatus.textContent = "Error al cargar datos";
    }
  }

  boot();
})();
