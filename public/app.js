let prodData = [];
let hidroData = [];
let chart;

async function loadData() {
  prodData = await fetch('data/produccion_diaria_larga.csv').then(r => r.text());
  hidroData = await fetch('data/hidrologia_diaria_larga.csv').then(r => r.text());
  init();
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  return lines.slice(1).map(l => {
    const obj = {};
    l.split(',').forEach((v, i) => obj[headers[i]] = v);
    return obj;
  });
}

function init() {
  prodData = parseCSV(prodData);
  hidroData = parseCSV(hidroData);

  const years = [...new Set(prodData.map(d => d.year))].sort();
  const yearSel = document.getElementById('yearSelect');
  years.forEach(y => {
    const o = document.createElement('option');
    o.value = y;
    o.textContent = y;
    yearSel.appendChild(o);
  });

  updateCentralOptions();
  drawChart();
}

function updateCentralOptions() {
  const module = document.getElementById('moduleSelect').value;
  const centralSel = document.getElementById('centralSelect');
  centralSel.innerHTML = '';

  const data = module === 'produccion' ? prodData : hidroData;
  const centrals = [...new Set(data.map(d => d.central))];

  centrals.forEach(c => {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    centralSel.appendChild(o);
  });

  document.getElementById('kindWrapper').style.display =
    module === 'hidrologia' ? 'flex' : 'none';
}

function drawChart() {
  const ctx = document.getElementById('chart').getContext('2d');
  if (chart) chart.destroy();

  chart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#e5e7eb' } }
      },
      scales: {
        x: { ticks: { color: '#cbd5f5' } },
        y: { ticks: { color: '#cbd5f5' } }
      }
    }
  });
}

document.getElementById('moduleSelect').addEventListener('change', () => {
  updateCentralOptions();
  drawChart();
});

loadData();
