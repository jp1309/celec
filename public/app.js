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

    // Excluir el último día disponible: el dato del día más reciente
    // suele estar incompleto/preliminar y no debe graficarse.
    const maxDate = PROD_DATA.reduce((m, r) => r.date > m ? r.date : m, "");

    // Filter Rows
    const filteredProdData = PROD_DATA.filter(r => {
      if (r.date === maxDate) return false;
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

  // ====================================================================
  // CCS · Río Coca — Dashboard v2
  // ====================================================================

  // Categorías de eventos (con orden de severidad)
  const CCS_CATEGORIES = [
    { key: 'extrema',     label: 'Avenida extrema',     emoji: '🔴', color: '#dc2626', match: r => r.coca != null && r.coca > 600 },
    { key: 'alta',        label: 'Avenida alta',        emoji: '🟠', color: '#ea580c', match: r => r.coca != null && r.coca > 300 && r.coca <= 600 },
    { key: 'cierre',      label: 'Cierre CSS',          emoji: '🟡', color: '#ca8a04', match: r => r.css != null && r.css < 30 },
    { key: 'variabilidad',label: 'Alta variabilidad',   emoji: '⚪', color: '#6366f1', match: r => r.balance != null && r.balance > 5 },
  ];

  function ccsCategorize(r) {
    for (const c of CCS_CATEGORIES) if (c.match(r)) return c;
    return null;
  }

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

  // ── HERO: estado del sistema HOY ──────────────────────────────────────
  function ccsPercentile(arr, p) {
    const v = arr.filter(x => x != null && !isNaN(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const idx = (p / 100) * (v.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return v[lo];
    return v[lo] + (v[hi] - v[lo]) * (idx - lo);
  }

  function ccsHistoricalCocaForSemaforo(today) {
    if (!CCS_DATA) return [];
    const start = new Date('2025-01-01T00:00:00');
    return CCS_DATA
      .filter(r => r.date >= start && r.date < today)
      .map(r => r.coca)
      .filter(v => v != null);
  }

  function ccsRenderHero() {
    if (!CCS_DATA || !CCS_DATA.length) return;
    const last = CCS_DATA[CCS_DATA.length - 1];
    const histCoca = ccsHistoricalCocaForSemaforo(last.date);
    const p50 = ccsPercentile(histCoca, 50);
    const p90 = ccsPercentile(histCoca, 90);

    const cocaPctRel = (last.coca != null && p50 != null && p90 != null)
      ? (last.coca > p90 ? 'rojo' : (last.coca > p50 ? 'ambar' : 'verde'))
      : 'verde';
    const cssAbs = (last.css != null)
      ? (last.css < 30 ? 'rojo' : 'verde')
      : 'verde';
    const balAbs = (last.balance != null)
      ? (last.balance > 10 ? 'rojo' : (last.balance > 2 ? 'ambar' : 'verde'))
      : 'verde';
    const derivPct = (last.coca && last.css != null && last.coca > 0)
      ? (last.css / last.coca * 100)
      : null;
    const derivState = (derivPct != null)
      ? (derivPct < 50 ? 'ambar' : 'verde')
      : 'verde';

    // Estado global = peor de los sub-estados
    const states = [cocaPctRel, cssAbs, balAbs, derivState];
    const overall = states.includes('rojo') ? 'rojo' : (states.includes('ambar') ? 'ambar' : 'verde');

    const heroEl = $("ccsHero");
    heroEl.classList.remove('hero-verde', 'hero-ambar', 'hero-rojo');
    heroEl.classList.add(`hero-${overall}`);

    const lightMap = { verde: '🟢', ambar: '🟡', rojo: '🔴' };
    const labelMap = {
      verde: 'OPERACIÓN NORMAL',
      ambar: 'CONDICIÓN DE ATENCIÓN',
      rojo:  'EVENTO CRÍTICO',
    };
    const msgMap = {
      verde: 'Caudal y derivación dentro de rangos esperados.',
      ambar: 'Caudal o derivación fuera del rango óptimo. Monitorear.',
      rojo:  'Avenida extrema, captación cerrada o balance anómalo. Acción requerida.',
    };

    $("ccsHeroLight").textContent = lightMap[overall];
    $("ccsHeroLabel").textContent = labelMap[overall];
    $("ccsHeroDate").textContent = `· ${last.dateStr}`;
    $("ccsHeroMsg").textContent = msgMap[overall];

    $("ccsHeroCoca").innerHTML = `${ccsFmt(last.coca)} <span class="u">m³/s</span>`;
    $("ccsHeroCss").innerHTML = `${ccsFmt(last.css)} <span class="u">m³/s</span>`;
    $("ccsHeroCssPct").textContent = derivPct != null ? `${derivPct.toFixed(1)}% del Coca` : '— %';
    $("ccsHeroFrente").innerHTML = `${ccsFmt(last.frente)} <span class="u">m³/s</span>`;

    const subs = [
      { lbl: 'Caudal',     state: cocaPctRel, hint: p90 != null ? `vs P90 ${ccsFmt(p90)}` : '—' },
      { lbl: 'Derivación', state: derivState, hint: derivPct != null ? `${derivPct.toFixed(0)}%` : '—' },
      { lbl: 'CSS',        state: cssAbs,     hint: 'capt. abierta' },
      { lbl: 'Balance',    state: balAbs,     hint: `${ccsFmt(last.balance, 2)} m³/s` },
    ];
    $("ccsHeroSubstates").innerHTML = subs.map(s => `
      <div class="ccs-sub state-${s.state}">
        <span class="ccs-sub-dot"></span>
        <span class="ccs-sub-lbl">${s.lbl}</span>
        <span class="ccs-sub-hint">${s.hint}</span>
      </div>`).join('');
  }

  // ── HIDROGRAMA CON BANDAS ESTACIONALES ────────────────────────────────
  function ccsDayOfYear(d) {
    // Día 1..366 según fecha. Feb 29 → 60.
    const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return Math.floor((cur - start) / 86400000) + 1;
  }

  function ccsRenderBands() {
    if (!CCS_DATA || !CCS_DATA.length) return;
    const serie = $("ccsBandSerie").value;
    const last = CCS_DATA[CCS_DATA.length - 1];
    const currentYear = last.date.getUTCFullYear();

    // Agrupar valores históricos por día del año (años < currentYear)
    const byDoy = new Map();
    CCS_DATA.forEach(r => {
      if (r.date.getUTCFullYear() >= currentYear) return;
      const v = r[serie];
      if (v == null) return;
      const doy = ccsDayOfYear(r.date);
      if (!byDoy.has(doy)) byDoy.set(doy, []);
      byDoy.get(doy).push(v);
    });

    const doys = [];
    const minArr = [], maxArr = [], p25Arr = [], p75Arr = [];
    for (let d = 1; d <= 366; d++) {
      if (!byDoy.has(d)) continue;
      const vals = byDoy.get(d);
      doys.push(d);
      minArr.push(Math.min(...vals));
      maxArr.push(Math.max(...vals));
      p25Arr.push(ccsPercentile(vals, 25));
      p75Arr.push(ccsPercentile(vals, 75));
    }

    // Año actual
    const cur = CCS_DATA.filter(r => r.date.getUTCFullYear() === currentYear)
      .sort((a, b) => a.date - b.date);
    const curDoy = cur.map(r => ccsDayOfYear(r.date));
    const curVal = cur.map(r => r[serie]);

    const serieLabel = { coca: 'Río Coca', css: 'Derivado CSS', frente: 'Frente erosión' }[serie];
    const serieColor = CCS_COLORS[serie];

    const traces = [];
    if (doys.length) {
      // Banda min-max (más clara)
      traces.push({
        x: doys.concat([...doys].reverse()),
        y: maxArr.concat([...minArr].reverse()),
        fill: 'toself', fillcolor: 'rgba(148,163,184,0.18)',
        line: { color: 'transparent' }, hoverinfo: 'skip',
        name: 'Histórico min-max', type: 'scatter',
      });
      // Banda P25-P75 (más oscura)
      traces.push({
        x: doys.concat([...doys].reverse()),
        y: p75Arr.concat([...p25Arr].reverse()),
        fill: 'toself', fillcolor: 'rgba(100,116,139,0.32)',
        line: { color: 'transparent' }, hoverinfo: 'skip',
        name: 'Histórico P25-P75', type: 'scatter',
      });
    }
    // Año actual
    traces.push({
      x: curDoy, y: curVal, type: 'scatter', mode: 'lines',
      line: { color: serieColor, width: 2.5 },
      name: `${currentYear}`,
      customdata: cur.map(r => r.dateStr),
      hovertemplate: `<b>%{customdata}</b><br>%{y:.1f} m³/s<extra></extra>`,
    });
    // Punto "hoy"
    if (cur.length) {
      const lastCur = cur[cur.length - 1];
      traces.push({
        x: [ccsDayOfYear(lastCur.date)], y: [lastCur[serie]],
        type: 'scatter', mode: 'markers',
        marker: { color: serieColor, size: 11, line: { color: '#fff', width: 2 } },
        name: 'Hoy', hoverinfo: 'skip', showlegend: false,
      });
    }

    const tickVals = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
    const tickText = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

    const layout = ccsBaseLayout('m³/s');
    layout.xaxis = {
      gridcolor: '#f1f5f9', tickfont: { color: '#475569' },
      tickvals: tickVals, ticktext: tickText, range: [1, 366],
    };
    layout.title = { text: `${serieLabel} · ${currentYear} sobre histórico`, font: { color: '#1e293b', size: 14 }, x: 0 };

    Plotly.react("ccsPlotBands", traces, layout, { responsive: true, displayModeBar: false });
  }

  // ── TASA DE DERIVACIÓN (% CSS/Coca + Coca como área en eje secundario) ──
  function ccsRenderDeriv() {
    if (!CCS_DATA || !CCS_DATA.length) return;
    const dates = CCS_DATA.map(r => r.dateStr);
    const pct = CCS_DATA.map(r => (r.coca && r.css != null && r.coca > 0) ? (r.css / r.coca * 100) : null);
    const coca = CCS_DATA.map(r => r.coca);

    const traces = [
      {
        x: dates, y: coca, type: 'scatter', mode: 'lines',
        fill: 'tozeroy', fillcolor: 'rgba(239,68,68,0.10)',
        line: { color: 'rgba(239,68,68,0.35)', width: 1 },
        name: 'Coca (m³/s)', yaxis: 'y2',
        hovertemplate: '%{y:.1f} m³/s<extra>Coca</extra>',
      },
      {
        x: dates, y: pct, type: 'scatter', mode: 'lines',
        line: { color: CCS_COLORS.css, width: 2 },
        name: '% derivación', yaxis: 'y',
        hovertemplate: '%{y:.1f}%<extra>CSS/Coca</extra>',
      },
    ];

    const layout = ccsBaseLayout('% derivación');
    layout.xaxis.type = 'date';
    layout.yaxis = {
      title: { text: '% CSS/Coca', font: { color: '#475569' } },
      gridcolor: '#f1f5f9', tickfont: { color: '#475569' },
      range: [0, 110], zeroline: false,
    };
    layout.yaxis2 = {
      title: { text: 'Coca (m³/s)', font: { color: '#94a3b8' } },
      overlaying: 'y', side: 'right',
      tickfont: { color: '#94a3b8' }, showgrid: false,
    };
    layout.shapes = [
      { type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: 75, y1: 75,
        line: { color: '#10b981', width: 1.5, dash: 'dash' } },
      { type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: 100, y1: 100,
        line: { color: '#94a3b8', width: 1, dash: 'dot' } },
    ];
    layout.annotations = [
      { xref: 'paper', x: 0.99, yref: 'y', y: 75, text: 'óptimo 75%', showarrow: false, font: { color: '#10b981', size: 10 }, xanchor: 'right', yanchor: 'bottom' },
      { xref: 'paper', x: 0.99, yref: 'y', y: 100, text: 'máx 100%', showarrow: false, font: { color: '#94a3b8', size: 10 }, xanchor: 'right', yanchor: 'bottom' },
    ];
    layout.legend = { orientation: 'h', y: -0.22, font: { color: '#475569', size: 11 } };

    Plotly.react("ccsPlotDeriv", traces, layout, { responsive: true, displayModeBar: false });
  }

  // ── COMPARADOR INTERANUAL (spaghetti) ─────────────────────────────────
  function ccsRenderSpag() {
    if (!CCS_DATA || !CCS_DATA.length) return;
    const serie = $("ccsSpagSerie").value;
    const highlightYear = Number($("ccsSpagYear").value);

    const years = [...new Set(CCS_DATA.map(r => r.date.getUTCFullYear()))].sort();
    const traces = [];

    years.forEach(y => {
      const rows = CCS_DATA.filter(r => r.date.getUTCFullYear() === y && r[serie] != null)
        .sort((a, b) => a.date - b.date);
      if (!rows.length) return;
      const isHi = (y === highlightYear);
      traces.push({
        x: rows.map(r => ccsDayOfYear(r.date)),
        y: rows.map(r => r[serie]),
        customdata: rows.map(r => r.dateStr),
        type: 'scatter', mode: 'lines',
        name: String(y),
        line: { color: isHi ? CCS_COLORS[serie] : 'rgba(148,163,184,0.45)', width: isHi ? 2.5 : 1 },
        hovertemplate: isHi
          ? `<b>%{customdata}</b><br>%{y:.1f} m³/s<extra>${y}</extra>`
          : `<b>${y}</b> · %{y:.1f}<extra></extra>`,
      });
    });

    const tickVals = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
    const tickText = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const layout = ccsBaseLayout('m³/s');
    layout.xaxis = {
      gridcolor: '#f1f5f9', tickfont: { color: '#475569' },
      tickvals: tickVals, ticktext: tickText, range: [1, 366],
    };
    Plotly.react("ccsPlotSpag", traces, layout, { responsive: true, displayModeBar: false });
  }

  // ── TABLA DE EVENTOS CRÍTICOS (chips + top 10 por categoría + ver todos) ─
  let CCS_EVENT_FILTER = new Set(CCS_CATEGORIES.map(c => c.key));
  let CCS_EVENT_SHOW_ALL = false;

  function ccsBuildEvents() {
    if (!CCS_DATA) return [];
    const all = [];
    CCS_DATA.forEach(r => {
      const cat = ccsCategorize(r);
      if (!cat) return;
      // Severidad: para extrema/alta = coca; para cierre = -css (más bajo es peor); para variabilidad = balance
      let sev = 0;
      if (cat.key === 'extrema' || cat.key === 'alta') sev = r.coca;
      else if (cat.key === 'cierre') sev = -r.css;
      else if (cat.key === 'variabilidad') sev = r.balance;
      all.push({ ...r, _cat: cat, _sev: sev });
    });
    return all;
  }

  function ccsRenderEventChips() {
    const events = ccsBuildEvents();
    const counts = {};
    CCS_CATEGORIES.forEach(c => counts[c.key] = events.filter(e => e._cat.key === c.key).length);
    $("ccsEventChips").innerHTML = CCS_CATEGORIES.map(c => {
      const active = CCS_EVENT_FILTER.has(c.key);
      return `<button class="ccs-evchip ${active ? 'active' : ''}" data-cat="${c.key}" style="--cat-color:${c.color}">
        <span class="ccs-evchip-dot"></span>
        ${c.label}
        <span class="ccs-evchip-count">${counts[c.key]}</span>
      </button>`;
    }).join('');
    $("ccsEventChips").querySelectorAll('.ccs-evchip').forEach(btn => {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.cat;
        if (CCS_EVENT_FILTER.has(cat)) CCS_EVENT_FILTER.delete(cat);
        else CCS_EVENT_FILTER.add(cat);
        if (!CCS_EVENT_FILTER.size) CCS_CATEGORIES.forEach(c => CCS_EVENT_FILTER.add(c.key));
        ccsRenderEventChips();
        ccsRenderEventTable();
      });
    });
  }

  function ccsRenderEventTable() {
    const events = ccsBuildEvents();
    const filtered = events.filter(e => CCS_EVENT_FILTER.has(e._cat.key));

    // Top 10 por categoría (por severidad descendente), o todos si flag activo
    let toShow = [];
    if (CCS_EVENT_SHOW_ALL) {
      toShow = filtered.slice().sort((a, b) => b.date - a.date);
    } else {
      const byCat = {};
      filtered.forEach(e => {
        if (!byCat[e._cat.key]) byCat[e._cat.key] = [];
        byCat[e._cat.key].push(e);
      });
      Object.values(byCat).forEach(arr => {
        arr.sort((a, b) => b._sev - a._sev);
        toShow.push(...arr.slice(0, 10));
      });
      toShow.sort((a, b) => b.date - a.date);
    }

    $("ccsEventRows").innerHTML = toShow.length ? toShow.map(e => `
      <tr>
        <td>${e.dateStr}</td>
        <td><span class="ccs-cat-badge" style="--cat-color:${e._cat.color}">${e._cat.emoji} ${e._cat.label}</span></td>
        <td style="color:${CCS_COLORS.coca}">${ccsFmt(e.coca)}</td>
        <td style="color:${CCS_COLORS.css}">${ccsFmt(e.css)}</td>
        <td style="color:${CCS_COLORS.frente}">${ccsFmt(e.frente)}</td>
        <td>${ccsFmt(e.balance, 2)}</td>
        <td><span class="ccs-sev-bar" style="--sev:${Math.min(100, Math.abs(e._sev) / 10)}%; --cat-color:${e._cat.color}"></span></td>
      </tr>`).join('') : `<tr><td colspan="7" class="ccs-empty">Sin eventos en las categorías seleccionadas.</td></tr>`;

    $("ccsEventsMeta").textContent = CCS_EVENT_SHOW_ALL
      ? `Mostrando ${toShow.length} de ${filtered.length} eventos`
      : `Mostrando top 10 por categoría · ${filtered.length} eventos en total`;
    $("ccsShowAllBtn").textContent = CCS_EVENT_SHOW_ALL ? 'Ver solo top 10' : `Ver todos (${filtered.length})`;
  }

  function drawCCS() {
    if (!CCS_DATA) return;
    ccsRenderHero();
    ccsRenderBands();
    ccsRenderDeriv();
    ccsRenderSpag();
    ccsRenderEventChips();
    ccsRenderEventTable();
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

        const years = [...new Set(CCS_DATA.map(r => r.date.getUTCFullYear()))].sort((a, b) => b - a);
        const selSpagYear = $("ccsSpagYear");
        if (selSpagYear) {
          years.forEach(y => addOption(selSpagYear, String(y), String(y)));
          if (years.length) selSpagYear.value = String(years[0]); // año más reciente
          selSpagYear.addEventListener("change", ccsRenderSpag);
        }
        const selBandSerie = $("ccsBandSerie");
        if (selBandSerie) selBandSerie.addEventListener("change", ccsRenderBands);
        const selSpagSerie = $("ccsSpagSerie");
        if (selSpagSerie) selSpagSerie.addEventListener("change", ccsRenderSpag);

        const showAllBtn = $("ccsShowAllBtn");
        if (showAllBtn) showAllBtn.addEventListener("click", () => {
          CCS_EVENT_SHOW_ALL = !CCS_EVENT_SHOW_ALL;
          ccsRenderEventTable();
        });
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
