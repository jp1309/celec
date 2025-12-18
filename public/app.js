// ===============================
// CELEC – Dashboard Hidroeléctrico
// ===============================

const DATA_PROD = "produccion_diaria_larga.csv";
const DATA_HIDRO = "hidrologia_diaria_larga.csv";

const plotDiv = document.getElementById("plot");

// ---------- Utilidades ----------

function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map(l => {
    const vals = l.split(",");
    const obj = {};
    headers.forEach((h, i) => obj[h] = vals[i]);
    return obj;
  });
}

function dayKey(dateStr) {
  const d = new Date(dateStr);
  return `${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// ---------- Carga de datos ----------

async function loadData() {
  const [p, h] = await Promise.all([
    fetch(DATA_PROD).then(r => r.text()),
    fetch(DATA_HIDRO).then(r => r.text())
  ]);
  return {
    prod: parseCSV(p),
    hidro: parseCSV(h)
  };
}

// ---------- Dibujo ----------

function draw(data, module, central, years, fromMD, toMD) {

  const src = module === "Producción" ? data.prod : data.hidro;
  const valueCol = module === "Producción" ? "energia_mwh" : "caudal_m3s";

  const filtered = src.filter(r => {
    const y = new Date(r.fecha).getFullYear();
    const md = dayKey(r.fecha);
    return r.central === central &&
           years.includes(y) &&
           md >= fromMD && md <= toMD;
  });

  if (filtered.length === 0) {
    plotDiv.innerHTML = "<p style='color:#ccc'>No hay datos para la selección</p>";
    return;
  }

  const traces = [];

  years.forEach(y => {
    const rows = filtered.filter(r => new Date(r.fecha).getFullYear() === y);
    if (rows.length === 0) return;

    traces.push({
      x: rows.map(r => dayKey(r.fecha)),
      y: rows.map(r => +r[valueCol]),
      mode: "lines",
      name: y.toString(),
      line: {
        width: y === Math.max(...years) ? 4 : 1.5
      }
    });
  });

  Plotly.newPlot(plotDiv, traces, {
    margin: { t: 40 },
    xaxis: { title: "Mes–día" },
    yaxis: {
      title: module === "Producción"
        ? "Energía (MWh)"
        : "Caudal (m³/s)"
    },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#e5e7eb" }
  });
}

// ---------- Init ----------

(async function init() {
  const data = await loadData();

  draw(
    data,
    "Producción",
    "CSR (Mol+Maz+Sop+MSF)",
    [2023, 2024, 2025],
    "01-01",
    "12-31"
  );
})();