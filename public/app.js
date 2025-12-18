/* CELEC · Hidroeléctrica
   app.js (robusto para GitHub Pages /celec/)
   - Lee meta.json, produccion_diaria_larga.csv, hidrologia_diaria_larga.csv desde la MISMA carpeta que index.html
   - Tolera CSV con separador coma o punto y coma
   - Tolera encabezados con mayúsculas / acentos (Fecha/FECHA, Central/CENTRAL, etc.)
*/
(() => {
  "use strict";

  // ---------- helpers ----------
  const BASE = new URL(".", window.location.href).href;

  const $ = (id) => document.getElementById(id);

  const stripAccents = (s) =>
    (s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  const normKey = (s) =>
    stripAccents(String(s || ""))
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^\w]/g, "");

  const pickFirst = (obj, keys) => {
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") return obj[k];
    }
    return undefined;
  };

  const parseNumber = (v) => {
    if (v === null || v === undefined) return NaN;
    const s = String(v).trim();
    if (!s) return NaN;
    // soporta "1.234,56" o "1234.56"
    const s2 = s.replace(/\./g, "").replace(",", ".");
    const n = Number(s2);
    return Number.isFinite(n) ? n : NaN;
  };

  const parseISODate = (v) => {
    if (!v) return null;
    const s = String(v).trim();
    // si viene YYYY-MM-DD, úsalo directo
    const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
    // si viene DD/MM/YYYY o DD-MM-YYYY
    const m2 = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
    if (m2) return `${m2[3]}-${m2[2]}-${m2[1]}`;
    // último recurso
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    }
    return null;
  };

  function detectDelimiter(text) {
    const head = text.split(/\r?\n/).slice(0, 5).join("\n");
    const commas = (head.match(/,/g) || []).length;
    const semis = (head.match(/;/g) || []).length;
    return semis > commas ? ";" : ",";
  }

  function parseCSV(text) {
    const delim = detectDelimiter(text);
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length < 2) return [];
    const rawHeaders = lines[0].split(delim).map((h) => h.trim());
    const headers = rawHeaders.map(normKey);

    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(delim);
      const row = {};
      for (let j = 0; j < headers.length; j++) row[headers[j]] = (parts[j] ?? "").trim();
      out.push(row);
    }
    return out;
  }

  async function fetchText(path) {
    const url = new URL(path, BASE).href;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
    return await r.text();
  }

  async function fetchJSON(path) {
    const url = new URL(path, BASE).href;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
    return await r.json();
  }

  // ---------- state ----------
  let meta = null;
  let prodRaw = [];
  let hidroRaw = [];

  // long-format normalized
  // { date: "YYYY-MM-DD", year: 2025, doy: 1..366, md: "MM-DD", central: "...", kind: "...", value: number }
  let prod = [];
  let hidro = [];

  // UI defaults
  const MONTHS = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  const mdOptions = (() => {
    const opts = [];
    for (let m = 1; m <= 12; m++) {
      const days = new Date(Date.UTC(2021, m, 0)).getUTCDate(); // año no bisiesto
      for (let d = 1; d <= days; d++) {
        const mm = String(m).padStart(2, "0");
        const dd = String(d).padStart(2, "0");
        opts.push({ value: `${mm}-${dd}`, label: `${dd}-${MONTHS[m-1].toLowerCase()}` });
      }
    }
    return opts;
  })();

  const humanCentral = {
    csr: "CSR (Mol+Maz+Sop+MSF)",
    molino: "Molino",
    mazar: "Mazar",
    sopladora: "Sopladora",
    msf: "Minas San Francisco",
  };

  function dateToMD(dateISO) {
    // dateISO YYYY-MM-DD
    return dateISO.slice(5, 10);
  }

  function mdToIndex(md) {
    // md "MM-DD" en año no bisiesto
    const [mm, dd] = md.split("-").map((x) => parseInt(x, 10));
    const d = new Date(Date.UTC(2021, mm - 1, dd));
    const start = new Date(Date.UTC(2021, 0, 1));
    const doy = Math.floor((d - start) / 86400000) + 1;
    return doy; // 1..365
  }

  function normalizeLong(rows, moduleName) {
    // intenta reconocer estructura long o wide
    // claves posibles
    const kDate = ["fecha", "date", "dia", "datetime", "fecha_utc"];
    const kCentral = ["central", "planta", "centralhidro", "central_hidro", "central_csr"];
    const kKind = ["metric", "metrica", "variable", "tipo", "kind", "medida"];
    const kValue = ["value", "valor", "mwh", "energia", "caudal", "cota", "dato"];

    const out = [];
    if (!rows.length) return out;

    const sample = rows[0];
    const keys = Object.keys(sample);

    const hasLong =
      keys.some((k) => kDate.includes(k)) &&
      keys.some((k) => kCentral.includes(k)) &&
      keys.some((k) => kValue.includes(k));

    if (hasLong) {
      for (const r of rows) {
        const dateISO = parseISODate(pickFirst(r, kDate));
        if (!dateISO) continue;

        let central = pickFirst(r, kCentral);
        central = central ? String(central).trim() : "";
        if (!central) continue;

        const kind = pickFirst(r, kKind);
        const value = parseNumber(pickFirst(r, kValue));
        if (!Number.isFinite(value)) continue;

        const year = parseInt(dateISO.slice(0, 4), 10);
        const md = dateToMD(dateISO);
        const doy = mdToIndex(md);

        out.push({
          date: dateISO,
          year,
          md,
          doy,
          central,
          kind: kind ? String(kind).trim() : (moduleName === "produccion" ? "Energía (MWh)" : "Caudal (m³/s)"),
          value,
        });
      }
      return out;
    }

    // wide: date + varias columnas numéricas (cada columna es una central o métrica)
    const dateKey = keys.find((k) => kDate.includes(k)) || keys.find((k) => k.includes("fecha")) || keys.find((k) => k.includes("date"));
    if (!dateKey) return out;

    // columnas numéricas candidatas
    const wideCols = keys.filter((k) => k !== dateKey);

    for (const r of rows) {
      const dateISO = parseISODate(r[dateKey]);
      if (!dateISO) continue;
      const year = parseInt(dateISO.slice(0, 4), 10);
      const md = dateToMD(dateISO);
      const doy = mdToIndex(md);

      for (const col of wideCols) {
        const v = parseNumber(r[col]);
        if (!Number.isFinite(v)) continue;
        out.push({
          date: dateISO,
          year,
          md,
          doy,
          central: col, // en wide no sabemos. ponemos el nombre de columna como "central/serie"
          kind: moduleName === "produccion" ? "Energía (MWh)" : "Valor",
          value: v,
        });
      }
    }
    return out;
  }

  function setMDOptions() {
    const startSel = $("startMD");
    const endSel = $("endMD");

    const mk = (sel) => {
      sel.innerHTML = "";
      for (const o of mdOptions) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        sel.appendChild(opt);
      }
    };

    mk(startSel);
    mk(endSel);

    startSel.value = "01-01";
    endSel.value = "12-31";
  }

  function setQuickActive(which) {
    const ids = ["btnFull","btnQ1","btnQ2","btnQ3","btnQ4"];
    for (const id of ids) $(""+id).classList.remove("active");
    if (which === "full") $("btnFull").classList.add("active");
    if (which === "q1") $("btnQ1").classList.add("active");
    if (which === "q2") $("btnQ2").classList.add("active");
    if (which === "q3") $("btnQ3").classList.add("active");
    if (which === "q4") $("btnQ4").classList.add("active");
  }

  function applyQuick(which) {
    const startSel = $("startMD");
    const endSel = $("endMD");
    if (which === "full") { startSel.value = "01-01"; endSel.value = "12-31"; }
    if (which === "q1") { startSel.value = "01-01"; endSel.value = "03-31"; }
    if (which === "q2") { startSel.value = "04-01"; endSel.value = "06-30"; }
    if (which === "q3") { startSel.value = "07-01"; endSel.value = "09-30"; }
    if (which === "q4") { startSel.value = "10-01"; endSel.value = "12-31"; }
    setQuickActive(which);
    render();
  }

  function selectedYears() {
    const sel = $("yearSelect");
    return Array.from(sel.selectedOptions).map((o) => parseInt(o.value, 10)).filter((n) => Number.isFinite(n));
  }

  function ensureSomeYearsSelected() {
    const ys = selectedYears();
    if (ys.length) return;
    const sel = $("yearSelect");
    const last = sel.options[sel.options.length - 1];
    if (last) last.selected = true;
  }

  function getCurrentData() {
    const module = $("moduleSelect").value;
    return module === "hidrologia" ? hidro : prod;
  }

  function setOptions() {
    const module = $("moduleSelect").value;
    const src = module === "hidrologia" ? hidro : prod;

    // Central options
    const centralSel = $("centralSelect");
    const prevCentral = centralSel.value;

    const centrals = Array.from(new Set(src.map((r) => r.central).filter((c) => c !== undefined && c !== null && String(c).trim() !== "")));
    centralSel.innerHTML = "";

    for (const c of centrals) {
      const opt = document.createElement("option");
      opt.value = c;
      const key = normKey(c);
      opt.textContent = humanCentral[key] || c;
      centralSel.appendChild(opt);
    }

    if (prevCentral && centrals.includes(prevCentral)) centralSel.value = prevCentral;

    // Kind options (métrica)
    const kindSel = $("kindSelect");
    const prevKind = kindSel.value;
    const kinds = Array.from(new Set(src.map((r) => r.kind).filter((k) => k !== undefined && k !== null && String(k).trim() !== "")));

    kindSel.innerHTML = "";
    for (const k of kinds) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = k;
      kindSel.appendChild(opt);
    }
    if (prevKind && kinds.includes(prevKind)) kindSel.value = prevKind;

    // Years options (global)
    const yearSel = $("yearSelect");
    const prevYears = new Set(selectedYears());
    const years = Array.from(new Set(src.map((r) => r.year))).sort((a,b)=>a-b);
    yearSel.innerHTML = "";
    for (const y of years) {
      const opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = String(y);
      if (prevYears.has(y)) opt.selected = true;
      yearSel.appendChild(opt);
    }
    ensureSomeYearsSelected();
  }

  function withinMDRange(md, startMD, endMD) {
    const a = mdToIndex(startMD);
    const b = mdToIndex(endMD);
    const x = mdToIndex(md);
    if (a <= b) return x >= a && x <= b;
    // wrap (poco probable aquí, pero por robustez)
    return x >= a || x <= b;
  }

  function render() {
    const module = $("moduleSelect").value; // produccion/hidrologia
    const src = getCurrentData();
    const years = selectedYears();

    const central = $("centralSelect").value;
    const kind = $("kindSelect").value;

    const startMD = $("startMD").value;
    const endMD = $("endMD").value;

    const filtered = src.filter((r) =>
      years.includes(r.year) &&
      r.central === central &&
      (kind ? r.kind === kind : true) &&
      withinMDRange(r.md, startMD, endMD)
    );

    // chart title
    const title = module === "produccion"
      ? `Producción · ${kind || "Energía"}`
      : `Hidrología · ${kind || "Variable"}`;

    // group by year for "día del año"
    const byYear = new Map();
    for (const r of filtered) {
      if (!byYear.has(r.year)) byYear.set(r.year, []);
      byYear.get(r.year).push(r);
    }

    const traces = [];
    for (const y of Array.from(byYear.keys()).sort((a,b)=>a-b)) {
      const rows = byYear.get(y).sort((a,b)=>a.doy-b.doy);
      const x = rows.map((r) => r.doy);
      const yv = rows.map((r) => r.value);
      traces.push({
        x,
        y: yv,
        mode: "lines",
        name: String(y),
        line: { width: 2 },
        hovertemplate: `%{y:.2f}<extra>${y}</extra>`,
      });
    }

    // x-axis ticks as month starts
    const monthStarts = [];
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, "0");
      monthStarts.push({ doy: mdToIndex(`${mm}-01`), label: MONTHS[m-1] });
    }

    const unit = (module === "produccion")
      ? "MWh"
      : (kind && kind.toLowerCase().includes("cota") ? "msnm" : "m³/s");

    const layout = {
      title: { text: title, x: 0 },
      margin: { l: 60, r: 20, t: 50, b: 45 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      xaxis: {
        title: "Día del año",
        tickmode: "array",
        tickvals: monthStarts.map((d) => d.doy),
        ticktext: monthStarts.map((d) => d.label),
        showgrid: true,
        zeroline: false,
      },
      yaxis: {
        title: unit,
        showgrid: true,
        zeroline: false,
      },
      legend: { orientation: "h", x: 0, y: 1.08 },
    };

    const config = { responsive: true, displaylogo: false };

    if (!traces.length) {
      Plotly.react("chart", [], {
        ...layout,
        title: { text: `${title}. Sin datos para los filtros actuales`, x: 0 },
      }, config);
      return;
    }

    Plotly.react("chart", traces, layout, config);
  }

  function wire() {
    $("moduleSelect").addEventListener("change", () => {
      setOptions();
      render();
    });
    $("centralSelect").addEventListener("change", render);
    $("kindSelect").addEventListener("change", render);
    $("yearSelect").addEventListener("change", render);

    $("startMD").addEventListener("change", () => setQuickActive("custom"));
    $("endMD").addEventListener("change", () => setQuickActive("custom"));

    $("btnFull").addEventListener("click", () => applyQuick("full"));
    $("btnQ1").addEventListener("click", () => applyQuick("q1"));
    $("btnQ2").addEventListener("click", () => applyQuick("q2"));
    $("btnQ3").addEventListener("click", () => applyQuick("q3"));
    $("btnQ4").addEventListener("click", () => applyQuick("q4"));
  }

  async function init() {
    setMDOptions();
    wire();

    // load data
    try {
      meta = await fetchJSON("meta.json");
    } catch (e) {
      meta = null;
    }

    const metaDiv = $("meta");
    if (meta) {
      const gen = meta.generated_at_utc || meta.generated_utc || meta.generated_at || null;
      if (gen) metaDiv.textContent = `Última generación (UTC): ${gen}`;
      else metaDiv.textContent = "meta.json cargado";
    } else {
      metaDiv.textContent = "meta.json no disponible";
    }

    // CSVs
    try {
      const t1 = await fetchText("produccion_diaria_larga.csv");
      prodRaw = parseCSV(t1);
    } catch (e) {
      prodRaw = [];
      console.error("No pude cargar produccion_diaria_larga.csv", e);
    }

    try {
      const t2 = await fetchText("hidrologia_diaria_larga.csv");
      hidroRaw = parseCSV(t2);
    } catch (e) {
      hidroRaw = [];
      console.error("No pude cargar hidrologia_diaria_larga.csv", e);
    }

    prod = normalizeLong(prodRaw, "produccion");
    hidro = normalizeLong(hidroRaw, "hidrologia");

    // fallbacks if kind not present
    if (prod.length && !prod.some((r) => r.kind)) prod.forEach((r) => (r.kind = "Energía (MWh)"));
    if (hidro.length && !hidro.some((r) => r.kind)) hidro.forEach((r) => (r.kind = "Caudal (m³/s)"));

    setOptions();
    render();
  }

  window.addEventListener("DOMContentLoaded", init);
})();
