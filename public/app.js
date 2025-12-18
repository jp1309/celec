/* CELEC · Hidroeléctrica dashboard (static, GitHub Pages)
   - Expects files in: public/data/
     - produccion_diaria_larga.csv  (date, serie, energia_mwh)
     - hidrologia_diaria_larga.csv  (date, serie, variable, valor)
     - meta.json
*/

(function () {
  "use strict";

  const DATA_BASE = "data/"; // relative to index.html (served from /celec/)
  const FILES = {
    meta: DATA_BASE + "meta.json",
    prod: DATA_BASE + "produccion_diaria_larga.csv",
    hidro: DATA_BASE + "hidrologia_diaria_larga.csv",
  };

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);

  const selModule = $("selModule");
  const selCentral = $("selCentral");
  const selYears = $("selYears");
  const selFrom = $("selFrom");
  const selTo = $("selTo");
  const plotDiv = $("plot");
  const metaStatus = $("metaStatus");

  const btnFull = $("btnFull");
  const btnQ1 = $("btnQ1");
  const btnQ2 = $("btnQ2");
  const btnQ3 = $("btnQ3");
  const btnQ4 = $("btnQ4");

  // ---- State ----
  let META = null;
  let PROD = null;   // array of {date, serie, energia_mwh}
  let HIDRO = null;  // array of {date, serie, variable, valor}

  // ---- Helpers ----
  function pad2(n) { return String(n).padStart(2, "0"); }

  function mmddFromISO(iso) {
    // iso: YYYY-MM-DD
    return iso.slice(5, 10); // MM-DD
  }

  function doyFromISO(iso) {
    // returns 1..366
    const d = new Date(iso + "T00:00:00Z");
    const year = d.getUTCFullYear();
    const start = new Date(Date.UTC(year, 0, 1));
    const diff = d - start;
    return Math.floor(diff / 86400000) + 1;
  }

  function inRangeMMDD(mmdd, fromMMDD, toMMDD) {
    // Inclusive bounds. Handles wrap (e.g., 11-01..03-31)
    if (!fromMMDD || !toMMDD) return true;
    if (fromMMDD <= toMMDD) return (mmdd >= fromMMDD && mmdd <= toMMDD);
    // wrap across year end
    return (mmdd >= fromMMDD || mmdd <= toMMDD);
  }

  function uniq(arr) {
    return Array.from(new Set(arr));
  }

  function setMetaText(msg) {
    if (!metaStatus) return;
    metaStatus.textContent = msg || "";
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

  function setSelectedMulti(sel, valuesSet) {
    for (const opt of sel.options) {
      opt.selected = valuesSet.has(Number(opt.value)) || valuesSet.has(opt.value);
    }
  }

  function getSelectedYears() {
    const yrs = [];
    for (const opt of selYears.options) {
      if (opt.selected) yrs.push(Number(opt.value));
    }
    return yrs;
  }

  function buildMonthDayOptions() {
    // Values are MM-DD. Labels are "DD-mmm" in Spanish short.
    const months = [
      ["ene", 31], ["feb", 29], ["mar", 31], ["abr", 30], ["may", 31], ["jun", 30],
      ["jul", 31], ["ago", 31], ["sep", 30], ["oct", 31], ["nov", 30], ["dic", 31]
    ];

    clearSelect(selFrom);
    clearSelect(selTo);

    for (let m = 1; m <= 12; m++) {
      const [abbr, days] = months[m - 1];
      for (let d = 1; d <= days; d++) {
        const mmdd = `${pad2(m)}-${pad2(d)}`;
        const lbl = `${pad2(d)}-${abbr}`;
        addOption(selFrom, mmdd, lbl);
        addOption(selTo, mmdd, lbl);
      }
    }

    // default: full year
    selFrom.value = "01-01";
    selTo.value = "12-31";
  }

  function setQuickRange(from, to) {
    selFrom.value = from;
    selTo.value = to;
    scheduleRedraw();
  }

  function parseNumber(x) {
    if (x === null || x === undefined) return NaN;
    const s = String(x).trim().replace(",", ".");
    const v = Number(s);
    return Number.isFinite(v) ? v : NaN;
  }

  // ---- Data load ----
  function loadJSON(url) {
    return fetch(url, { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return r.json();
    });
  }

  function loadCSV(url) {
    // Use Plotly's bundled d3 for robust CSV parsing
    return new Promise((resolve, reject) => {
      if (!window.Plotly || !Plotly.d3 || !Plotly.d3.csv) {
        reject(new Error("Plotly.d3.csv no disponible"));
        return;
      }
      Plotly.d3.csv(url, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  // ---- UI init ----
  function initSelectors() {
    // Module options
    clearSelect(selModule);
    addOption(selModule, "produccion", "Producción");
    addOption(selModule, "hidrologia", "Hidrología");
    selModule.value = "produccion";

    buildMonthDayOptions();

    // Quick buttons
    btnFull && btnFull.addEventListener("click", () => setQuickRange("01-01", "12-31"));
    btnQ1 && btnQ1.addEventListener("click", () => setQuickRange("01-01", "03-31"));
    btnQ2 && btnQ2.addEventListener("click", () => setQuickRange("04-01", "06-30"));
    btnQ3 && btnQ3.addEventListener("click", () => setQuickRange("07-01", "09-30"));
    btnQ4 && btnQ4.addEventListener("click", () => setQuickRange("10-01", "12-31"));

    // Change listeners
    selModule.addEventListener("change", () => { refreshOptionsForModule(); scheduleRedraw(); });
    selCentral.addEventListener("change", scheduleRedraw);
    selYears.addEventListener("change", scheduleRedraw);
    selFrom.addEventListener("change", scheduleRedraw);
    selTo.addEventListener("change", scheduleRedraw);
  }

  function refreshOptionsForModule() {
    const mod = selModule.value;

    // Years
    clearSelect(selYears);
    const years = (mod === "produccion" ? META.produccion.years : META.hidrologia.years) || [];
    years.forEach((y) => addOption(selYears, String(y), String(y)));

    // Default select: last 2 years (or all if <=2)
    const sorted = [...years].sort((a, b) => a - b);
    const last = sorted.slice(Math.max(0, sorted.length - 2));
    setSelectedMulti(selYears, new Set(last));

    // Central (serie)
    clearSelect(selCentral);
    const series = (mod === "produccion" ? META.produccion.series : META.hidrologia.series) || [];
    series.forEach((s) => addOption(selCentral, s, s));
    selCentral.value = series[0] || "";

    // Show/hide CSR note based on selection exists in HTML already, leave as is.
  }

  // ---- Plot ----
  let redrawTimer = null;
  function scheduleRedraw() {
    if (redrawTimer) window.clearTimeout(redrawTimer);
    redrawTimer = window.setTimeout(draw, 50);
  }

  function draw() {
    if (!PROD || !HIDRO || !META) return;

    const mod = selModule.value;
    const serie = selCentral.value;
    const years = getSelectedYears();
    const from = selFrom.value; // MM-DD
    const to = selTo.value;

    if (!serie || years.length === 0) {
      Plotly.react(plotDiv, [], {
        title: { text: "Seleccione una central y al menos un año" },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)"
      }, { displayModeBar: true, responsive: true });
      return;
    }

    if (mod === "produccion") {
      const rows = PROD.filter(r => r.serie === serie);
      const traces = buildYearTraces(rows, years, from, to, "energia_mwh", "Energía (MWh)", null);
      const yTitle = "Energía (MWh)";
      const layout = baseLayout(`Producción. ${serie}`, yTitle);
      Plotly.react(plotDiv, traces, layout, { displayModeBar: true, responsive: true });
    } else {
      const rows = HIDRO.filter(r => r.serie === serie);
      // We'll plot Caudal on y, Cota on y2 if present
      const caudalVar = "Caudal (m³/s)";
      const cotaVar = "Cota (msnm)";

      const rowsC = rows.filter(r => r.variable === caudalVar);
      const rowsH = rows.filter(r => r.variable === cotaVar);

      const traces = [];
      traces.push(...buildYearTraces(rowsC, years, from, to, "valor", caudalVar, null));

      if (rowsH.length > 0) {
        const t2 = buildYearTraces(rowsH, years, from, to, "valor", cotaVar, "y2");
        // make y2 lines dashed so they visually separate
        for (const t of t2) t.line = Object.assign({}, t.line || {}, { dash: "dot" });
        traces.push(...t2);
      }

      const layout = baseLayout(`Hidrología. ${serie}`, caudalVar);
      if (rowsH.length > 0) {
        layout.yaxis2 = {
          title: cotaVar,
          overlaying: "y",
          side: "right",
          showgrid: false,
          zeroline: false,
          tickfont: { color: "#9fb0c0" },
          titlefont: { color: "#9fb0c0" }
        };
      }
      Plotly.react(plotDiv, traces, layout, { displayModeBar: true, responsive: true });
    }
  }

  function buildYearTraces(rows, years, from, to, valueCol, labelPrefix, yaxisName) {
    // rows: objects that include date (YYYY-MM-DD) and valueCol
    const yearSet = new Set(years.map(Number));
    const maxYear = Math.max.apply(null, years.map(Number));

    // group by year
    const byYear = new Map();
    for (const r of rows) {
      const date = r.date;
      if (!date || date.length < 10) continue;
      const y = Number(date.slice(0, 4));
      if (!yearSet.has(y)) continue;

      const mmdd = mmddFromISO(date);
      if (!inRangeMMDD(mmdd, from, to)) continue;

      const v = parseNumber(r[valueCol]);
      if (!Number.isFinite(v)) continue;

      const doy = doyFromISO(date);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push({ doy, v, date });
    }

    // build traces, sorted by year
    const traces = [];
    const yearsSorted = Array.from(byYear.keys()).sort((a, b) => a - b);

    for (const y of yearsSorted) {
      const pts = byYear.get(y).sort((a, b) => a.doy - b.doy);
      const x = pts.map(p => p.doy);
      const yv = pts.map(p => p.v);
      const text = pts.map(p => p.date);

      traces.push({
        type: "scatter",
        mode: "lines",
        name: String(y),
        x,
        y: yv,
        text,
        hovertemplate: "%{text}<br>DOY %{x}<br>%{y:.2f}<extra>" + String(y) + "</extra>",
        line: {
          width: (y === maxYear ? 4 : 2)
        },
        yaxis: yaxisName || "y"
      });
    }

    return traces;
  }

  function baseLayout(title, yTitle) {
    return {
      title: { text: title, font: { color: "#e9f0f7" } },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      margin: { l: 70, r: 70, t: 60, b: 55 },
      xaxis: {
        title: "Día del año",
        gridcolor: "rgba(255,255,255,0.08)",
        zeroline: false,
        tickfont: { color: "#cfd9e2" },
        titlefont: { color: "#cfd9e2" }
      },
      yaxis: {
        title: yTitle,
        gridcolor: "rgba(255,255,255,0.08)",
        zeroline: false,
        tickfont: { color: "#cfd9e2" },
        titlefont: { color: "#cfd9e2" }
      },
      legend: {
        orientation: "h",
        x: 0,
        y: 1.12,
        font: { color: "#cfd9e2" }
      }
    };
  }

  // ---- Boot ----
  async function boot() {
    initSelectors();
    setMetaText("cargando...");

    try {
      META = await loadJSON(FILES.meta);
      setMetaText(`meta.json OK · ${META.generated_at_utc || ""}`.trim());
    } catch (e) {
      console.error("meta.json error:", e);
      setMetaText("meta.json no disponible");
      META = null;
      return;
    }

    try {
      const prodRows = await loadCSV(FILES.prod);
      PROD = prodRows.map(r => ({
        date: r.date,
        serie: r.serie,
        energia_mwh: r.energia_mwh
      }));
    } catch (e) {
      console.error("produccion_diaria_larga.csv error:", e);
      PROD = [];
    }

    try {
      const hidroRows = await loadCSV(FILES.hidro);
      HIDRO = hidroRows.map(r => ({
        date: r.date,
        serie: r.serie,
        variable: r.variable,
        valor: r.valor
      }));
    } catch (e) {
      console.error("hidrologia_diaria_larga.csv error:", e);
      HIDRO = [];
    }

    refreshOptionsForModule();
    scheduleRedraw();
  }

  // Wait for Plotly
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
