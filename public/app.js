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
  const selProdStartMonth = $("prodStartMonth");
  const selProdEndMonth = $("prodEndMonth");
  const plotProdLine = $("plotProdLine");
  const plotProdPie = $("plotProdPie");

  // Hydrology Controls
  const selHidroCentral = $("hidroCentral");
  const selHidroVariable = $("hidroVariable");
  const selHidroYears = $("hidroYears");
  const selHidroStartMonth = $("hidroStartMonth");
  const selHidroEndMonth = $("hidroEndMonth");
  const plotHidroMain = $("plotHidroMain");

  const btnResetProdPeriod = $("btnResetProdPeriod");
  const btnResetHidroPeriod = $("btnResetHidroPeriod");

  const YEAR_COLORS = {
    2025: "#3b82f6", // Blue
    2024: "#ef4444", // Red
    2023: "#10b981", // Green
    2022: "#f59e0b", // Orange
    2021: "#8b5cf6", // Purple
    2020: "#ec4899", // Pink
    "default": "#94a3b8"
  };

  function getYearColor(y) {
    return YEAR_COLORS[y] || YEAR_COLORS.default;
  }

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
    let text = await resp.text();

    // Remove UTF-8 BOM if present
    if (text.charCodeAt(0) === 0xFEFF) {
      text = text.slice(1);
    }

    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];

    // Simple CSV parser that handles quotes and multiple delimiters (comma or semicolon)
    const delimiter = lines[0].includes(";") ? ";" : ",";
    const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ""));

    return lines.slice(1).map(line => {
      const values = line.split(delimiter).map(v => v.trim().replace(/^["']|["']$/g, ""));
      const obj = {};
      headers.forEach((h, i) => {
        if (h) obj[h] = values[i] || "";
      });
      return obj;
    });
  }

  // ---- Redraw Logic ----
  const TICK_VALS = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  const TICK_TEXT = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

  const getGenericDoy = (m, day) => {
    const d = new Date(2025, m - 1, day); // Non-leap ref
    const start = new Date(2025, 0, 1);
    return Math.floor((d - start) / 86400000) + 1;
  };

  function drawProduction() {
    if (!PROD_DATA || !META) return;

    const serie = selProdCentral.value;
    const years = getSelectedValues(selProdYears).map(Number);
    const startMonth = parseInt(selProdStartMonth.value);
    const endMonth = parseInt(selProdEndMonth.value);

    // Filter Rows
    const filteredProdData = PROD_DATA.filter(r => {
      const m = parseInt(r.date.slice(5, 7));
      return m >= startMonth && m <= endMonth;
    });

    // 1. Line Chart (DOY X-Axis for comparison)
    const tracesLine = [];
    const minDoy = getGenericDoy(startMonth, 1);
    const maxDoy = getGenericDoy(endMonth + 1, 0);

    years.sort().forEach(y => {
      const color = getYearColor(y);
      const yearRows = filteredProdData
        .filter(r => r.serie === serie && r.date.startsWith(String(y)))
        .sort((a, b) => a.date.localeCompare(b.date));

      if (yearRows.length === 0) return;

      tracesLine.push({
        type: "scatter",
        mode: "lines",
        name: String(y),
        x: yearRows.map(r => doyFromISO(r.date)),
        y: yearRows.map(r => (parseNumber(r.value) || 0) / 1000), // MWh to GWh
        customdata: yearRows.map(r => r.date),
        line: { color: color, width: 2 },
        hovertemplate: "<b>%{customdata}</b><br>%{y:.2f} GWh<extra></extra>"
      });
    });

    const layout = baseLayout(`${serie} - Evolución (GWh)`, "Generación (GWh)", false);
    layout.xaxis.range = [minDoy, maxDoy];
    layout.xaxis.tickvals = TICK_VALS;
    layout.xaxis.ticktext = TICK_TEXT;

    Plotly.react(plotProdLine, tracesLine, layout, { responsive: true, displayModeBar: false });

    // 2. Pie Chart (Comparison of plants for selected range)
    const pieDataMap = new Map();
    const plantsToInclude = META.produccion.series.filter(s => !s.includes("CSR") && !s.includes("+"));

    plantsToInclude.forEach(p => {
      const total = filteredProdData
        .filter(r => r.serie === p && yearSet.has(Number(r.date.slice(0, 4))))
        .reduce((acc, r) => acc + (parseNumber(r.value) || 0), 0);
      if (total > 0) pieDataMap.set(p, total / 1000); // MWh to GWh
    });

    const pieColors = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4"];
    const tracesPie = [{
      type: "pie",
      labels: Array.from(pieDataMap.keys()),
      values: Array.from(pieDataMap.values()),
      hole: 0.4,
      marker: { colors: pieColors },
      textinfo: "percent+label",
      insidetextorientation: "radial",
      hovertemplate: "<b>%{label}</b><br>%{value:.0f} GWh<br>%{percent}<extra></extra>",
      automargin: true
    }];

    Plotly.react(plotProdPie, tracesPie, {
      title: { text: "Distribución por Central", font: { color: "#1e293b", size: 14, family: 'Outfit, sans-serif' } },
      paper_bgcolor: "#ffffff",
      plot_bgcolor: "#ffffff",
      margin: { t: 50, b: 20, l: 20, r: 20 },
      showlegend: false
    }, { responsive: true, displayModeBar: false });
  }

  function drawHidrology() {
    if (!HIDRO_DATA || !META) return;

    const variable = selHidroVariable.value;
    const years = getSelectedValues(selHidroYears).map(Number);
    const startMonth = parseInt(selHidroStartMonth.value);
    const endMonth = parseInt(selHidroEndMonth.value);
    if (years.length === 0) return;

    // Fixed series per user request
    let targetSerie = "";
    if (variable.includes("Caudal")) targetSerie = "Cuenca del Rio Paute";
    if (variable.includes("Cota")) targetSerie = "Mazar";

    const rows = HIDRO_DATA
      .filter(r => r.serie === targetSerie && r.variable === variable)
      .sort((a, b) => a.date.localeCompare(b.date));

    function calculateMA(data, period) {
      return data.map((val, idx, arr) => {
        if (idx < period - 1) return null;
        const slice = arr.slice(idx - period + 1, idx + 1);
        const sum = slice.reduce((a, b) => a + b, 0);
        return sum / period;
      });
    }

    // Pre-calculate MA for ALL rows to have January continuity
    const allValues = rows.map(r => r.value);
    const allMA = calculateMA(allValues, 30);
    // Attach MA to rows
    rows.forEach((r, idx) => r.ma30 = allMA[idx]);

    const traces = [];
    const minDoy = getGenericDoy(startMonth, 1);
    const maxDoy = getGenericDoy(endMonth + 1, 0); // Last day of endMonth

    years.sort().forEach((y, i) => {
      const color = getYearColor(y);
      // Filtering by year and month range
      const yearRows = rows
        .filter(r => r.date.startsWith(String(y)))
        .sort((a, b) => doyFromISO(a.date) - doyFromISO(b.date));

      // Secondary filter by month range for the chart display range
      const displayRows = yearRows.filter(r => {
        const m = parseInt(r.date.slice(5, 7));
        return m >= startMonth && m <= endMonth;
      });

      if (displayRows.length > 0) {
        // Main Trace (Live Data) - attenuated and dotted for Caudal
        const isCaudal = variable.includes("Caudal");
        traces.push({
          type: "scatter",
          mode: "lines",
          name: isCaudal ? `${y} (Diario)` : `${y}`,
          x: displayRows.map(r => doyFromISO(r.date)),
          y: displayRows.map(r => r.value),
          customdata: displayRows.map(r => r.date),
          line: { color: color, width: isCaudal ? 1 : 2, dash: isCaudal ? "dot" : "solid" },
          opacity: isCaudal ? 0.3 : 1,
          hovertemplate: `<b>%{customdata}</b><br>%{y:.2f} ${variable.includes("Cota") ? "msnm" : "m³/s"}<extra></extra>`
        });

        // Moving Average Trace (Only for Caudal)
        if (variable.includes("Caudal")) {
          const maTraceData = yearRows
            .filter(r => r.ma30 !== null)
            .map(r => ({ doy: doyFromISO(r.date), val: r.ma30 }));

          // Filter MA trace data for current month range
          const filteredMA = maTraceData.filter(item => {
            const row = yearRows.find(r => doyFromISO(r.date) === item.doy);
            const m = parseInt(row.date.slice(5, 7));
            return m >= startMonth && m <= endMonth;
          });

          if (filteredMA.length > 0) {
            traces.push({
              type: "scatter",
              mode: "lines",
              name: `${y} (Media 30d)`,
              x: filteredMA.map(d => d.doy),
              y: filteredMA.map(d => d.val),
              line: { color: color, width: 2, dash: "solid" },
              opacity: 1,
              showlegend: true,
              hovertemplate: `<b>%{y:.2f} m³/s</b> (MA30)<extra></extra>`
            });
          }
        }
      }
    });

    const layout = baseLayout(`Hidrología · ${targetSerie}`, variable, false);

    // Customize X-axis for generic date labels
    layout.xaxis.tickvals = TICK_VALS;
    layout.xaxis.ticktext = TICK_TEXT;

    // Fix Y-axis for Cota or Caudal
    if (variable.includes("Cota")) {
      layout.yaxis.range = [2100, 2155];
      layout.yaxis.dtick = 5; // Jumps of 5 in 5

      // Add solid reference line at 2115
      layout.shapes = [{
        type: 'line',
        x0: minDoy, x1: maxDoy,
        y0: 2115, y1: 2115,
        xref: 'x', yref: 'y',
        line: { color: 'rgba(30, 41, 59, 0.4)', width: 2, dash: 'solid' }
      }];
    } else if (variable.includes("Caudal")) {
      layout.yaxis.range = [0, 400];

      // Add solid reference line at 50
      layout.shapes = [{
        type: 'line',
        x0: minDoy, x1: maxDoy,
        y0: 50, y1: 50,
        xref: 'x', yref: 'y',
        line: { color: 'rgba(30, 41, 59, 0.4)', width: 2, dash: 'solid' }
      }];
    }

    Plotly.react(plotHidroMain, traces, layout, { responsive: true, displayModeBar: false });
  }

  function baseLayout(title, yTitle, isDateX) {
    return {
      title: {
        text: title,
        font: { family: 'Outfit, sans-serif', color: '#1e293b', size: 16 },
        x: 0,
        y: 0.98,
        pad: { t: 10 }
      },
      paper_bgcolor: "#ffffff",
      plot_bgcolor: "#ffffff",
      margin: { l: 60, r: 40, t: 100, b: 60 }, // Added top margin for legend
      showlegend: true,
      legend: {
        orientation: "h",
        y: 1.12,
        x: 0,
        font: { color: "#475569", size: 12 }
      },
      xaxis: {
        title: { text: isDateX ? "Fecha" : "Día del Año", font: { color: "#475569" } },
        type: isDateX ? "date" : "linear",
        gridcolor: "#f1f5f9",
        tickfont: { color: "#475569" },
        range: isDateX ? undefined : [1, 366]
      },
      yaxis: {
        title: { text: yTitle, font: { color: "#475569" } },
        gridcolor: "#f1f5f9",
        tickfont: { color: "#475569" },
        zeroline: false
      },
      font: { family: 'Outfit, sans-serif' }
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

      // Populate Hydrology (Remove Central populate as it's fixed now)
      clearSelect(selHidroYears);
      META.hidrologia.years.sort((a, b) => b - a).forEach(y => addOption(selHidroYears, y, y));
      if (selHidroYears.options.length >= 1) selHidroYears.options[0].selected = true;

      const [pData, hData] = await Promise.all([
        loadCSV(FILES.prod),
        loadCSV(FILES.hidro)
      ]);

      PROD_DATA = pData.map(r => {
        const val = parseNumber(r.value);
        return {
          date: (r.date || "").trim(),
          serie: (r.series || "").trim(),
          variable: (r.metric || "").trim(),
          value: val
        };
      }).filter(r => r.value > 0);

      HIDRO_DATA = hData.map(r => {
        const val = parseNumber(r.value);
        return {
          date: (r.date || "").trim(),
          serie: (r.series || "").trim(),
          variable: (r.metric || "").trim(),
          value: val
        };
      }).filter(r => r.value > 0);

      const allDates = [...PROD_DATA, ...HIDRO_DATA].map(r => r.date);
      if (allDates.length > 0) {
        const latest = allDates.sort().pop();
        const [y, m, d] = latest.split("-");
        const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
        metaStatus.textContent = `Última fecha: ${d}-${months[parseInt(m) - 1]}-${y}`;
      } else {
        metaStatus.textContent = "Datos listos";
      }

      console.log("PROD_DATA sample:", PROD_DATA.slice(0, 2));

      // Listeners
      selProdCentral.addEventListener("change", drawProduction);
      selProdYears.addEventListener("change", drawProduction);
      selProdStartMonth.addEventListener("change", drawProduction);
      selProdEndMonth.addEventListener("change", drawProduction);
      selHidroVariable.addEventListener("change", drawHidrology);
      selHidroYears.addEventListener("change", drawHidrology);
      selHidroStartMonth.addEventListener("change", drawHidrology);
      selHidroEndMonth.addEventListener("change", drawHidrology);

      btnResetProdPeriod.addEventListener("click", () => {
        selProdStartMonth.value = "1";
        selProdEndMonth.value = "12";
        drawProduction();
      });

      btnResetHidroPeriod.addEventListener("click", () => {
        selHidroStartMonth.value = "1";
        selHidroEndMonth.value = "12";
        drawHidrology();
      });

      drawProduction();
    } catch (e) {
      console.error(e);
      metaStatus.textContent = "Error al cargar datos";
    }
  }

  boot();
})();
