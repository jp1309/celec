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
    ccs: DATA_BASE + "ccs_caudales_diarios.csv",
  };

  const CCS_COLORS = {
    coca: "#ef4444",
    css: "#3b82f6",
    frente: "#10b981",
    balance: "#f59e0b",
    accent: "#6366f1",
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
  let CCS_DATA = null;
  let CCS_GAPS = null;
  let CCS_MONTHLY = null;
  let CCS_YEAR_FILTER = null;
  let CCS_Y_SCALE = "linear";

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
      else if (tabId === "hidro") drawHidrology();
      else if (tabId === "ccs") drawCCS();
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
    const yearSet = new Set(years);

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

    // Adapt X-axis range
    layout.xaxis.range = [minDoy, maxDoy];

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

  // ---- CCS (Río Coca) ----
  function ccsBaseLayout(yTitle) {
    return {
      paper_bgcolor: "#ffffff",
      plot_bgcolor: "#ffffff",
      font: { family: 'Outfit, sans-serif', color: '#1e293b', size: 12 },
      margin: { l: 60, r: 30, t: 30, b: 50 },
      xaxis: { type: 'date', gridcolor: '#f1f5f9', tickfont: { color: '#475569' } },
      yaxis: { title: { text: yTitle, font: { color: '#475569' } }, gridcolor: '#f1f5f9', tickfont: { color: '#475569' }, zeroline: false },
      legend: { orientation: 'h', y: -0.18, font: { color: '#475569', size: 11 } },
      hovermode: 'x unified',
    };
  }

  function ccsAvg(arr) {
    const v = arr.filter(x => x != null && !isNaN(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }

  function ccsFmt(n, d = 1) {
    if (n == null || isNaN(n)) return '—';
    return n.toLocaleString('es-EC', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function ccsPrepare(raw) {
    const rows = raw.map(r => {
      const dateStr = (r.date || "").trim();
      if (!dateStr) return null;
      const date = new Date(dateStr + "T00:00:00");
      if (isNaN(date)) return null;
      const coca = parseNumber(r.coca);
      const css = parseNumber(r.css);
      const frente = parseNumber(r.frente);
      const balance = parseNumber(r.balance);
      return {
        dateStr, date,
        coca: isNaN(coca) ? null : coca,
        css: isNaN(css) ? null : css,
        frente: isNaN(frente) ? null : frente,
        balance: isNaN(balance) ? null : balance,
        status: (r.status || "").trim(),
      };
    }).filter(Boolean).sort((a, b) => a.date - b.date);

    const gaps = [];
    for (let i = 1; i < rows.length; i++) {
      const diff = Math.round((rows[i].date - rows[i - 1].date) / 86400000);
      if (diff > 1) {
        gaps.push({
          from: new Date(rows[i - 1].date.getTime() + 86400000),
          to: new Date(rows[i].date.getTime() - 86400000),
          days: diff - 1,
        });
      }
    }

    const monthly = {};
    rows.forEach(r => {
      const key = `${r.date.getFullYear()}-${String(r.date.getMonth() + 1).padStart(2, '0')}`;
      if (!monthly[key]) monthly[key] = { coca: [], css: [], frente: [], balance: [] };
      if (r.coca != null) monthly[key].coca.push(r.coca);
      if (r.css != null) monthly[key].css.push(r.css);
      if (r.frente != null) monthly[key].frente.push(r.frente);
      if (r.balance != null) monthly[key].balance.push(r.balance);
    });
    const monthlyRows = Object.entries(monthly).sort().map(([k, v]) => ({
      key: k,
      coca: ccsAvg(v.coca),
      css: ccsAvg(v.css),
      frente: ccsAvg(v.frente),
      balance: ccsAvg(v.balance),
    }));

    return { rows, gaps, monthlyRows };
  }

  function ccsFilteredRows() {
    if (!CCS_DATA) return [];
    if (!CCS_YEAR_FILTER) return CCS_DATA;
    return CCS_DATA.filter(r => r.date.getFullYear() === CCS_YEAR_FILTER);
  }

  function ccsRenderKPIs() {
    const rows = CCS_DATA || [];
    if (!rows.length) return;
    const last = rows[rows.length - 1];
    const first = rows[0];
    const totalDays = Math.round((last.date - first.date) / 86400000) + 1;
    const avgCoca = ccsAvg(rows.map(r => r.coca));
    const avgCSS = ccsAvg(rows.map(r => r.css));
    const avgFrente = ccsAvg(rows.map(r => r.frente));
    const highBal = rows.filter(r => r.balance != null && r.balance > 5).length;
    const gapDays = (CCS_GAPS || []).reduce((s, g) => s + g.days, 0);

    const kpis = [
      { color: '#6366f1', val: rows.length, lbl: 'Días registrados', sub: `de ${totalDays} posibles` },
      { color: CCS_COLORS.coca, val: ccsFmt(avgCoca), lbl: 'Prom. Río Coca', sub: 'm³/s histórico' },
      { color: CCS_COLORS.css, val: ccsFmt(avgCSS), lbl: 'Prom. Derivado CCS', sub: 'm³/s histórico' },
      { color: CCS_COLORS.frente, val: ccsFmt(avgFrente), lbl: 'Prom. Frente', sub: 'm³/s histórico' },
      { color: CCS_COLORS.balance, val: highBal, lbl: 'Eventos avenida', sub: 'balance > 5 m³/s' },
      { color: '#a855f7', val: gapDays, lbl: 'Días sin datos', sub: `${(CCS_GAPS || []).length} hueco(s)` },
    ];

    $("ccsKpis").innerHTML = kpis.map(k => `
      <div class="ccs-kpi" style="--kpi-accent:${k.color}">
        <div class="ccs-kpi-val">${k.val}</div>
        <div class="ccs-kpi-lbl">${k.lbl}</div>
        <div class="ccs-kpi-sub">${k.sub}</div>
      </div>`).join('');

    $("ccsInfoUltimo").textContent = `${last.dateStr} · Coca ${ccsFmt(last.coca)} m³/s`;
    $("ccsInfoDias").textContent = rows.length;
  }

  function ccsRenderMain() {
    const rows = ccsFilteredRows();
    if (!rows.length) return;
    const dates = rows.map(r => r.dateStr);
    const traces = [
      { name: 'Río Coca', y: rows.map(r => r.coca), line: { color: CCS_COLORS.coca, width: 2 } },
      { name: 'Derivado CSS', y: rows.map(r => r.css), line: { color: CCS_COLORS.css, width: 2 } },
      { name: 'Frente erosión', y: rows.map(r => r.frente), line: { color: CCS_COLORS.frente, width: 2 } },
    ].map(t => ({
      ...t, x: dates, type: 'scatter', mode: 'lines', connectgaps: false,
      hovertemplate: `%{y:.1f} m³/s<extra>${t.name}</extra>`,
    }));

    const layout = ccsBaseLayout('m³/s');
    layout.yaxis.type = CCS_Y_SCALE;
    Plotly.react("ccsPlotMain", traces, layout, { responsive: true, displayModeBar: false });
  }

  function ccsRenderRecent() {
    if (!CCS_DATA || !CCS_DATA.length) return;
    const cutoff = new Date(CCS_DATA[CCS_DATA.length - 1].date);
    cutoff.setDate(cutoff.getDate() - 90);
    const rows = CCS_DATA.filter(r => r.date >= cutoff);
    const dates = rows.map(r => r.dateStr);
    const traces = [
      { name: 'Río Coca', y: rows.map(r => r.coca), line: { color: CCS_COLORS.coca, width: 2 } },
      { name: 'Derivado CSS', y: rows.map(r => r.css), line: { color: CCS_COLORS.css, width: 2 } },
      { name: 'Frente erosión', y: rows.map(r => r.frente), line: { color: CCS_COLORS.frente, width: 2 } },
    ].map(t => ({
      ...t, x: dates, type: 'scatter', mode: 'lines', connectgaps: false,
      hovertemplate: `%{y:.1f} m³/s<extra>${t.name}</extra>`,
    }));
    const layout = ccsBaseLayout('m³/s');
    layout.title = { text: 'Últimos 90 días', font: { color: '#1e293b', size: 14 }, x: 0 };
    Plotly.react("ccsPlotRecent", traces, layout, { responsive: true, displayModeBar: false });
  }

  function ccsRenderBox() {
    if (!CCS_DATA) return;
    const rows = CCS_DATA;
    const traces = [
      { name: 'Río Coca', y: rows.map(r => r.coca).filter(v => v != null), marker: { color: CCS_COLORS.coca } },
      { name: 'Derivado CSS', y: rows.map(r => r.css).filter(v => v != null), marker: { color: CCS_COLORS.css } },
      { name: 'Frente erosión', y: rows.map(r => r.frente).filter(v => v != null), marker: { color: CCS_COLORS.frente } },
    ].map(t => ({ ...t, type: 'box', boxmean: 'sd' }));
    const layout = ccsBaseLayout('m³/s');
    layout.xaxis = { gridcolor: '#f1f5f9', tickfont: { color: '#475569' } };
    layout.title = { text: 'Distribución histórica', font: { color: '#1e293b', size: 14 }, x: 0 };
    layout.showlegend = false;
    Plotly.react("ccsPlotBox", traces, layout, { responsive: true, displayModeBar: false });
  }

  function ccsRenderMonthly() {
    if (!CCS_MONTHLY) return;
    const keys = CCS_MONTHLY.map(r => r.key);
    const traces = [
      { name: 'Río Coca', y: CCS_MONTHLY.map(r => r.coca), marker: { color: CCS_COLORS.coca } },
      { name: 'Derivado CSS', y: CCS_MONTHLY.map(r => r.css), marker: { color: CCS_COLORS.css } },
      { name: 'Frente erosión', y: CCS_MONTHLY.map(r => r.frente), marker: { color: CCS_COLORS.frente } },
    ].map(t => ({ ...t, x: keys, type: 'bar', hovertemplate: `%{y:.1f} m³/s<extra>${t.name}</extra>` }));
    const layout = ccsBaseLayout('m³/s');
    layout.barmode = 'group';
    layout.xaxis = { gridcolor: '#f1f5f9', tickfont: { color: '#475569' }, tickangle: -40 };
    layout.title = { text: 'Promedio mensual', font: { color: '#1e293b', size: 14 }, x: 0 };
    Plotly.react("ccsPlotMonthly", traces, layout, { responsive: true, displayModeBar: false });
  }

  function ccsRenderBalance() {
    const rows = ccsFilteredRows();
    const dates = rows.map(r => r.dateStr);
    const vals = rows.map(r => r.balance);
    const colors = vals.map(v => v == null ? 'transparent' : (v > 5 ? '#ef4444' : (v > 1 ? '#f59e0b' : '#10b981')));
    const layout = ccsBaseLayout('Balance |Coca − CSS − Frente| m³/s');
    layout.title = { text: 'Balance diario', font: { color: '#1e293b', size: 14 }, x: 0 };
    layout.showlegend = false;
    Plotly.react("ccsPlotBalance", [{
      x: dates, y: vals, type: 'bar',
      marker: { color: colors },
      hovertemplate: '%{y:.2f} m³/s<extra>Balance</extra>',
    }], layout, { responsive: true, displayModeBar: false });
  }

  function ccsRenderHighTable() {
    if (!CCS_DATA) return;
    const rows = CCS_DATA.filter(r => r.balance != null && r.balance > 5)
      .sort((a, b) => b.balance - a.balance);
    $("ccsHighCount").textContent = rows.length;
    const cond = (r) => {
      if (r.css != null && r.css < 30) return 'CSS cerrada (sedimentos)';
      if (r.coca != null && r.coca > 600) return 'Avenida extrema';
      if (r.coca != null && r.coca > 300) return 'Avenida alta';
      return 'Alta variabilidad';
    };
    $("ccsHighRows").innerHTML = rows.length
      ? rows.map(r => `
        <tr>
          <td>${r.dateStr}</td>
          <td style="color:${CCS_COLORS.coca}">${ccsFmt(r.coca)}</td>
          <td style="color:${CCS_COLORS.css}">${ccsFmt(r.css)}</td>
          <td style="color:${CCS_COLORS.frente}">${ccsFmt(r.frente)}</td>
          <td><span class="ccs-tag hi">${ccsFmt(r.balance, 2)}</span></td>
          <td><span class="ccs-tag">${cond(r)}</span></td>
        </tr>`).join('')
      : `<tr><td colspan="6" class="ccs-empty">Sin eventos.</td></tr>`;
  }

  function ccsRenderGaps() {
    const gaps = CCS_GAPS || [];
    $("ccsGapCount").textContent = gaps.length;
    const sd = (d) => d.toISOString().slice(0, 10);
    $("ccsGapRows").innerHTML = gaps.length
      ? gaps.map(g => `
        <tr>
          <td>${sd(g.from)}</td>
          <td>${sd(g.to)}</td>
          <td><span class="ccs-tag gap">${g.days} día${g.days > 1 ? 's' : ''}</span></td>
        </tr>`).join('')
      : `<tr><td colspan="3" class="ccs-empty">Sin huecos.</td></tr>`;
  }

  function drawCCS() {
    if (!CCS_DATA) return;
    ccsRenderKPIs();
    ccsRenderMain();
    ccsRenderRecent();
    ccsRenderBox();
    ccsRenderMonthly();
    ccsRenderBalance();
    ccsRenderHighTable();
    ccsRenderGaps();
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

      const [pData, hData, cData] = await Promise.all([
        loadCSV(FILES.prod),
        loadCSV(FILES.hidro),
        loadCSV(FILES.ccs).catch(() => []),
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

      // CCS
      if (cData && cData.length) {
        const prep = ccsPrepare(cData);
        CCS_DATA = prep.rows;
        CCS_GAPS = prep.gaps;
        CCS_MONTHLY = prep.monthlyRows;

        const years = [...new Set(CCS_DATA.map(r => r.date.getFullYear()))].sort((a, b) => b - a);
        const selCCSYear = $("ccsYear");
        if (selCCSYear) {
          years.forEach(y => addOption(selCCSYear, String(y), String(y)));
          selCCSYear.addEventListener("change", () => {
            CCS_YEAR_FILTER = selCCSYear.value ? Number(selCCSYear.value) : null;
            ccsRenderMain();
            ccsRenderBalance();
          });
        }
        const selCCSScale = $("ccsScale");
        if (selCCSScale) {
          selCCSScale.addEventListener("change", () => {
            CCS_Y_SCALE = selCCSScale.value;
            ccsRenderMain();
          });
        }
      }

      const allDates = [...PROD_DATA, ...HIDRO_DATA].map(r => r.date).filter(Boolean);
      if (allDates.length > 0) {
        const latest = allDates.sort().pop();
        if (latest && latest.includes("-")) {
          const [y, m, d] = latest.split("-");
          const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
          metaStatus.textContent = `Última fecha: ${d}-${months[parseInt(m, 10) - 1]}-${y}`;
        } else {
          metaStatus.textContent = "Datos listos";
        }
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
