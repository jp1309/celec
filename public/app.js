/* =========================================================
   CELEC · Dashboard – app.js
   - X axis: day-of-year normalized to 365 (Feb 29 removed)
   - Each selected year becomes one line
   - Placeholder rows (is_placeholder=1) are ignored
   ========================================================= */

let produccion = [];
let hidrologia = [];
let meta = null;

const MONTH_NAMES_ES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];

function parseCSV(text){
  // Minimal CSV parser for our simple files (no quoted commas expected).
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map(h => h.trim());
  const rows = [];
  for (let i=1; i<lines.length; i++){
    const cols = lines[i].split(",");
    const obj = {};
    for (let j=0; j<headers.length; j++){
      obj[headers[j]] = (cols[j] ?? "").trim();
    }
    rows.push(obj);
  }
  return rows;
}

function doy365(date){
  // Remove Feb 29 by shifting days after Feb 28 in leap years.
  const d = new Date(date.getTime());
  const year = d.getFullYear();
  const start = new Date(year, 0, 1);
  const doy = Math.floor((d - start) / 86400000) + 1;

  const isLeap = (new Date(year, 1, 29).getMonth() === 1);
  const m = d.getMonth() + 1;
  const day = d.getDate();

  // Feb 29 -> map to 59 (Feb 28)
  if (m === 2 && day === 29) return 59;
  if (isLeap && m > 2) return doy - 1;
  return doy;
}

function mdLabelFromDoy(doy){
  // Use non-leap reference year 2001
  const ref = new Date(2001, 0, 1);
  ref.setDate(ref.getDate() + (doy - 1));
  const dd = String(ref.getDate()).padStart(2, "0");
  const mm = ref.getMonth(); // 0..11
  return `${dd}-${MONTH_NAMES_ES[mm]}`;
}

function buildMDOptions(){
  const startSel = document.getElementById("startMD");
  const endSel = document.getElementById("endMD");
  startSel.innerHTML = "";
  endSel.innerHTML = "";

  for (let doy=1; doy<=365; doy++){
    const label = mdLabelFromDoy(doy);
    const opt1 = document.createElement("option");
    opt1.value = String(doy);
    opt1.textContent = label;
    const opt2 = opt1.cloneNode(true);
    startSel.appendChild(opt1);
    endSel.appendChild(opt2);
  }

  // defaults: full year
  startSel.value = "1";
  endSel.value = "365";
}

function setQuickActive(rangeKey){
  document.querySelectorAll(".quick .btn").forEach(b => {
    b.classList.toggle("active", b.dataset.range === rangeKey);
  });
}

function applyQuickRange(rangeKey){
  const startSel = document.getElementById("startMD");
  const endSel = document.getElementById("endMD");

  const ranges = {
    full: [1, 365],
    q1: [1, 90],     // Jan 1 .. Mar 31 in 365-day scale
    q2: [91, 181],   // Apr 1 .. Jun 30
    q3: [182, 273],  // Jul 1 .. Sep 30
    q4: [274, 365],  // Oct 1 .. Dec 31
  };

  const [s, e] = ranges[rangeKey] || ranges.full;
  startSel.value = String(s);
  endSel.value = String(e);
  setQuickActive(rangeKey);
  render();
}

function selectedYears(){
  const sel = document.getElementById("yearSelect");
  return Array.from(sel.selectedOptions).map(o => parseInt(o.value, 10)).filter(Number.isFinite).sort((a,b)=>a-b);
}

function ensureSomeYearsSelected(){
  const sel = document.getElementById("yearSelect");
  if (sel.selectedOptions.length > 0) return;
  // Default: last 3 years available (or fewer)
  const opts = Array.from(sel.options).map(o => parseInt(o.value,10)).filter(Number.isFinite).sort((a,b)=>a-b);
  const last = opts.slice(-3);
  Array.from(sel.options).forEach(o => {
    o.selected = last.includes(parseInt(o.value,10));
  });
}

function uniqueSorted(arr){
  return Array.from(new Set(arr)).sort();
}

function humanCentral(c){
  const map = {
    csr: "CSR (Molino+Mazar+Sopladora+MSF)",
    molino: "Molino",
    mazar: "Mazar",
    sopladora: "Sopladora",
    msf: "Minas San Francisco",
    cuenca_paute: "Cuenca Paute",
  };
  return map[c] || c;
}

function yAxisTitle(module, kind){
  if (module === "produccion") return "Energía diaria (MWh)";
  return kind === "cota_msnm" ? "Cota (msnm)" : "Caudal (m³/s)";
}

function lineWidthForYear(y, maxYear){
  return (y === maxYear) ? 4 : 2;
}

function buildTraces(module, central, kind, years, startDoy, endDoy){
  const traces = [];
  const src = (module === "produccion") ? produccion : hidrologia;
  const maxYear = years.length ? Math.max(...years) : null;

  for (const y of years){
    const rows = src.filter(r => {
      if (parseInt(r.year,10) !== y) return false;
      if ((r.is_placeholder ?? "0") === "1") return false;
      if (r.central !== central) return false;
      if (module === "hidrologia" && r.kind !== kind) return false;
      return true;
    });

    // Build day-of-year series
    const points = [];
    for (const r of rows){
      const d = new Date(r.date);
      if (Number.isNaN(d.getTime())) continue;
      const doy = doy365(d);
      if (doy < startDoy || doy > endDoy) continue;

      let val = null;
      if (module === "produccion"){
        val = r.energia_mwh === "" ? null : parseFloat(r.energia_mwh);
      } else {
        val = r.value === "" ? null : parseFloat(r.value);
      }
      if (val === null || Number.isNaN(val)) continue;
      points.push([doy, val]);
    }

    points.sort((a,b)=>a[0]-b[0]);

    const x = points.map(p => p[0]);
    const yv = points.map(p => p[1]);

    traces.push({
      type: "scatter",
      mode: "lines",
      name: String(y),
      x,
      y: yv,
      line: {
        width: lineWidthForYear(y, maxYear),
      },
      hovertemplate: "%{text}<br>%{y:.2f}<extra>"+y+"</extra>",
      text: x.map(doy => mdLabelFromDoy(doy)),
    });
  }

  return traces;
}

function render(){
  const module = document.getElementById("moduleSelect").value;
  const central = document.getElementById("centralSelect").value;
  const kind = document.getElementById("kindSelect").value;
  ensureSomeYearsSelected();
  const years = selectedYears();

  const startDoy = parseInt(document.getElementById("startMD").value, 10);
  const endDoy = parseInt(document.getElementById("endMD").value, 10);

  // Guard: if user chose inverted range, swap
  const s = Math.min(startDoy, endDoy);
  const e = Math.max(startDoy, endDoy);

  const traces = buildTraces(module, central, kind, years, s, e);

  const tickStep = (e - s) <= 45 ? 7 : ((e - s) <= 120 ? 14 : 30);
  const tickvals = [];
  const ticktext = [];
  for (let v = s; v <= e; v += tickStep){
    tickvals.push(v);
    ticktext.push(mdLabelFromDoy(v));
  }

  const layout = {
    margin: {l: 60, r: 20, t: 20, b: 60},
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: {
      title: "Día del año (mes–día)",
      tickmode: "array",
      tickvals,
      ticktext,
      color: "#cbd5e1",
      gridcolor: "rgba(148,163,184,.15)",
      range: [s, e],
    },
    yaxis: {
      title: yAxisTitle(module, kind),
      color: "#cbd5e1",
      gridcolor: "rgba(148,163,184,.15)",
    },
    legend: {
      orientation: "h",
      x: 0,
      y: 1.1,
      font: {color: "#e5e7eb"},
    },
  };

  const config = {
    displayModeBar: true,
    responsive: true,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  };

  Plotly.newPlot("plot", traces, layout, config);

  const foot = document.getElementById("footnote");
  const centralTxt = humanCentral(central);
  const rangeTxt = `${mdLabelFromDoy(s)} → ${mdLabelFromDoy(e)}`;
  foot.textContent = `${module === "produccion" ? "Producción" : "Hidrología"} · ${centralTxt}${module === "hidrologia" ? " · " + (kind === "caudal_m3s" ? "Caudal" : "Cota") : ""} · Intervalo: ${rangeTxt}`;
}

function setOptions(){
  // module-dependent controls
  const module = document.getElementById("moduleSelect").value;
  document.getElementById("kindControl").style.display = (module === "hidrologia") ? "block" : "none";

  const src = (module === "produccion") ? produccion : hidrologia;

  // Central options
  const centralSel = document.getElementById("centralSelect");
  const centrals = uniqueSorted(src.map(r => r.central));
  centralSel.innerHTML = "";
  centrals.forEach(c => {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = humanCentral(c);
    centralSel.appendChild(o);
  });

  // Default central: csr for production, molino for hydro if exists
  if (module === "produccion" && centrals.includes("csr")) centralSel.value = "csr";
  if (module === "hidrologia" && centrals.includes("molino")) centralSel.value = "molino";
}

async function loadAll(){
  buildMDOptions();
  setQuickActive("full");

  // Load datasets produced by Python
  const [pTxt, hTxt, mTxt] = await Promise.all([
    fetch("data/produccion_diaria_larga.csv").then(r => r.text()),
    fetch("data/hidrologia_diaria_larga.csv").then(r => r.text()),
    fetch("data/meta.json").then(r => r.ok ? r.json() : null),
  ]);

  produccion = parseCSV(pTxt);
  hidrologia = parseCSV(hTxt);
  meta = mTxt;

  // Populate years from union of both datasets
  const years = uniqueSorted([...produccion.map(r => r.year), ...hidrologia.map(r => r.year)].filter(Boolean));
  const yearSel = document.getElementById("yearSelect");
  yearSel.innerHTML = "";
  years.forEach(y => {
    const o = document.createElement("option");
    o.value = y;
    o.textContent = y;
    yearSel.appendChild(o);
  });
  ensureSomeYearsSelected();

  setOptions();

  // Meta panel
  const metaDiv = document.getElementById("meta");
  if (meta && meta.generated_utc){
    metaDiv.textContent =
      `Última generación (UTC): ${meta.generated_utc}\n` +
      `Última fecha prod.: ${meta.last_date_produccion}\n` +
      `Última fecha hidro.: ${meta.last_date_hidrologia}`;
  } else {
    metaDiv.textContent = "meta.json no disponible";
  }

  render();
}

function wire(){
  document.getElementById("moduleSelect").addEventListener("change", () => {
    setOptions();
    render();
  });
  document.getElementById("centralSelect").addEventListener("change", render);
  document.getElementById("kindSelect").addEventListener("change", render);
  document.getElementById("yearSelect").addEventListener("change", render);
  document.getElementById("startMD").addEventListener("change", () => setQuickActive("custom") );
  document.getElementById("endMD").addEventListener("change", () => setQuickActive("custom") );

  document.querySelectorAll(".quick .btn").forEach(b => {
    b.addEventListener("click", () => applyQuickRange(b.dataset.range));
  });
}

wire();
loadAll().catch(err => {
  console.error(err);
  const foot = document.getElementById("footnote");
  foot.textContent = "Error cargando datasets. Verifica que existan en /data y que GitHub Pages esté sirviendo desde /public.";
});
