/* CELEC · Dashboard Energético
   - Dos módulos independientes: Producción e Hidrología
   - Comparativa de años (1 Ene - 31 Dic)
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

  // Production Controls
  const selProdCentral = $("prodCentral");
  const selProdYears = $("prodYears");
  const plotProd = $("plotProd");

  // Hydrology Controls
  const selHidroCentral = $("hidroCentral");
  const selHidroYears = $("hidroYears");
  const plotHidro = $("plotHidro");

  // ---- State ----
  let META = null;
  let PROD_DATA = null;
  let HIDRO_DATA = null;

  // ---- Helpers ----
  function pad2(n) { return String(n).padStart(2, "0"); }

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

  function setSelectedMulti(sel, valuesSet) {
    for (const opt of sel.options) {
      opt.selected = valuesSet.has(Number(opt.value)) || valuesSet.has(opt.value);
    }
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

    if (!serie || years.length === 0) {
      Plotly.react(plotProd, [], baseLayout("Producción: Seleccione Central y Años", "Energía (MWh)"));
      return;
    }

    const rows = PROD_DATA.filter(r => r.serie === serie);
    const traces = buildYearTraces(rows, years, "value", "Energía (MWh)");

    Plotly.react(plotProd, traces, baseLayout(`Producción · ${serie}`, "Energía (MWh)"), { responsive: true, displayModeBar: false });
  }

  function drawHidrology() {
    if (!HIDRO_DATA || !META) return;

    const serie = selHidroCentral.value;
    const years = getSelectedValues(selHidroYears).map(Number);

    if (!serie || years.length === 0) {
      Plotly.react(plotHidro, [], baseLayout("Hidrología: Seleccione Central y Años", "Caudal (m³/s)"));
      return;
    }

    const rows = HIDRO_DATA.filter(r => r.serie === serie);
    const caudalVar = "Caudal (m³/s)";
    const cotaVar = "Cota (msnm)";

    const rowsC = rows.filter(r => r.variable === caudalVar);
    const rowsH = rows.filter(r => r.variable === cotaVar);

    const traces = [];
    traces.push(...buildYearTraces(rowsC, years, "value", caudalVar));

    if (rowsH.length > 0) {
      const tracesH = buildYearTraces(rowsH, years, "value", cotaVar, "y2");
      for (const t of tracesH) {
        t.line = Object.assign({}, t.line || {}, { dash: "dot", width: 1.5 });
        t.opacity = 0.6;
      }
      traces.push(...tracesH);
    }

    const layout = baseLayout(`Hidrología · ${serie}`, caudalVar);
    if (rowsH.length > 0) {
      layout.yaxis2 = {
        title: cotaVar,
        overlaying: "y",
        side: "right",
        showgrid: false,
        zeroline: false,
        tickfont: { color: "#94a3b8" },
        titlefont: { color: "#94a3b8" }
      };
    }

    Plotly.react(plotHidro, traces, layout, { responsive: true, displayModeBar: false });
  }

  function buildYearTraces(rows, years, valueCol, labelPrefix, yaxisName = "y") {
    const yearSet = new Set(years);
    const maxYearSelected = Math.max(...years);

    const byYear = new Map();
    for (const r of rows) {
      const y = Number(r.date.slice(0, 4));
      if (!yearSet.has(y)) continue;

      const v = parseNumber(r[valueCol]);
      if (isNaN(v)) continue;

      const doy = doyFromISO(r.date);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push({ doy, v, date: r.date });
    }

    const traces = [];
    const sortedYears = Array.from(byYear.keys()).sort((a, b) => a - b);

    // Color palette for multiple years
    const colors = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4"];

    sortedYears.forEach((y, i) => {
      const pts = byYear.get(y).sort((a, b) => a.doy - b.doy);
      const color = colors[i % colors.length];

      traces.push({
        type: "scatter",
        mode: "lines",
        name: String(y),
        x: pts.map(p => p.doy),
        y: pts.map(p => p.v),
        text: pts.map(p => `${p.date}: ${p.v.toFixed(2)}`),
        hoverinfo: "text",
        yaxis: yaxisName,
        line: {
          color: color,
          width: y === maxYearSelected ? 3.5 : 2
        }
      });
    });

    return traces;
  }

  function baseLayout(title, yTitle) {
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
      legend: {
        orientation: "h",
        y: 1.15,
        font: { color: "#94a3b8" }
      },
      xaxis: {
        title: "Día del Año (1 - 366)",
        gridcolor: "rgba(255,255,255,0.05)",
        tickfont: { color: "#94a3b8" },
        titlefont: { color: "#94a3b8" },
        range: [1, 366]
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
      metaStatus.textContent = "Cargando datos...";
      META = await (await fetch(FILES.meta)).json();

      // Populate Production
      clearSelect(selProdCentral);
      META.produccion.series.forEach(s => addOption(selProdCentral, s, s));
      selProdCentral.value = META.produccion.series[0];

      clearSelect(selProdYears);
      META.produccion.years.sort((a, b) => b - a).forEach(y => addOption(selProdYears, y, y));
      // Select last 2 years by default
      if (selProdYears.options.length >= 2) {
        selProdYears.options[0].selected = true;
        selProdYears.options[1].selected = true;
      }

      // Populate Hydrology
      clearSelect(selHidroCentral);
      META.hidrologia.series.forEach(s => addOption(selHidroCentral, s, s));
      selHidroCentral.value = META.hidrologia.series[0];

      clearSelect(selHidroYears);
      META.hidrologia.years.sort((a, b) => b - a).forEach(y => addOption(selHidroYears, y, y));
      if (selHidroYears.options.length >= 1) {
        selHidroYears.options[0].selected = true;
      }

      metaStatus.textContent = "Datos listos";

      // Load CSVs
      const [pData, hData] = await Promise.all([
        loadCSV(FILES.prod),
        loadCSV(FILES.hidro)
      ]);

      PROD_DATA = pData.map(r => ({ date: r.date, serie: r.series, variable: r.metric, value: r.value }));
      HIDRO_DATA = hData.map(r => ({ date: r.date, serie: r.series, variable: r.metric, value: r.value }));

      // Listeners
      selProdCentral.addEventListener("change", drawProduction);
      selProdYears.addEventListener("change", drawProduction);
      selHidroCentral.addEventListener("change", drawHidrology);
      selHidroYears.addEventListener("change", drawHidrology);

      drawProduction();
      drawHidrology();

    } catch (e) {
      console.error(e);
      metaStatus.textContent = "Error al cargar datos";
    }
  }

  boot();
})();
