#!/usr/bin/env node
// Guard for the chart styling in index.html. The charts MIRA draws are meant to be visually the
// same report cards as the branch dashboard, so this pins the palette, the dashed target line, the
// filled trend area and the Rupiah axis format. Runs the real code out of index.html rather than a
// copy, so it cannot drift.
//
// RUN:  node test-grafik.js
// Run the REAL chart code from index.html against a stub Chart.js + DOM and inspect the config it
// builds. No pixels, but it proves the colours, types, dashes and fills are what the dashboard uses.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const mulai = src.indexOf('  const PALET = {');
const akhir = src.indexOf('  function addUserBubble');
if (mulai < 0 || akhir < 0) throw new Error('blok grafik tidak ditemukan');
const kode = src.slice(mulai, akhir);

let tertangkap = null;
const el = () => ({
  className: '', style: {}, textContent: '', type: '',
  appendChild() {}, addEventListener() {}, remove() {},
  getContext: () => ({}),
  toBlob() {}, toDataURL: () => '',
});
const sandbox = {
  Chart: function (ctx, cfg) { tertangkap = cfg; },
  document: { createElement: el },
  navigator: {},
  Intl,
  File: function () {},
};
const jalan = new Function(...Object.keys(sandbox), kode + '\nreturn { renderChart };');
const { renderChart } = jalan(...Object.values(sandbox));

const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const nol12 = Array(12).fill(0);

const kasus = [
  ['Tren (satu garis, seperti kartu Tren Penjualan)', {
    type: 'line', title: 'Tren Penjualan per Periode', labels: BULAN,
    datasets: [{ label: 'Sales', peran: 'sales', data: nol12 }],
  }],
  ['Komparasi 2025 vs 2026 + target (bar + garis putus)', {
    type: 'bar', title: 'Komparasi Sales 2025 vs 2026 & Target Tahunan', labels: BULAN,
    datasets: [
      { label: 'Sales 2025', peran: 'tahunLalu', data: nol12 },
      { label: 'Sales 2026', peran: 'sales', data: nol12 },
      { label: 'Target', peran: 'target', type: 'line', data: nol12 },
    ],
  }],
  ['Komposisi (doughnut)', {
    type: 'doughnut', title: 'Komposisi Piutang', labels: ['A', 'B'],
    datasets: [{ label: 'Piutang', data: [1, 2] }],
  }],
];

let masalah = 0;
const cek = (nama, syarat, pesan) => { if (!syarat) { masalah++; console.log('    GAGAL: ' + pesan); } };

for (const [nama, spec] of kasus) {
  tertangkap = null;
  renderChart(el(), spec);
  console.log('\n' + nama);
  if (!tertangkap) { masalah++; console.log('    GAGAL: chart tidak terbentuk sama sekali'); continue; }
  const ds = tertangkap.data.datasets;
  ds.forEach((d) => {
    const warna = d.borderColor || (Array.isArray(d.backgroundColor) ? d.backgroundColor.join(',') : d.backgroundColor);
    console.log(`    ${(d.label || '(tanpa label)').padEnd(12)} type=${String(d.type).padEnd(8)} warna=${warna} ${d.borderDash ? 'putus-putus' : ''} ${d.fill ? 'berisian' : ''}`);
  });
  cek(nama, tertangkap.plugins && tertangkap.plugins.length === 1, 'latar belakang tidak dipasang (PNG akan transparan)');
  cek(nama, tertangkap.options.animation === false, 'animasi tidak dimatikan (PNG bisa setengah jadi)');
  if (spec.type === 'line') {
    cek(nama, ds[0].borderColor === '#c17a5a', 'warna sales bukan terakota dashboard');
    cek(nama, ds[0].fill === true, 'grafik tren tidak berisian');
    cek(nama, ds[0].tension === 0.35, 'lengkung garis tidak sama dengan dashboard');
  }
  if (spec.datasets.length === 3) {
    cek(nama, ds[0].backgroundColor === '#a3aebb', 'warna tahun lalu bukan abu-abu biru dashboard');
    cek(nama, ds[1].backgroundColor === '#c17a5a', 'warna tahun ini bukan terakota dashboard');
    cek(nama, ds[2].type === 'line' && Array.isArray(ds[2].borderDash), 'target bukan garis putus-putus');
    cek(nama, ds[2].borderColor === '#cf9b3f', 'warna target bukan kuning dashboard');
    cek(nama, ds[0].borderRadius === 4, 'batang tidak membulat seperti dashboard');
  }
  if (spec.type === 'doughnut') {
    cek(nama, tertangkap.type === 'doughnut', 'tipe doughnut tidak diteruskan');
    cek(nama, Array.isArray(ds[0].backgroundColor), 'doughnut tidak diberi warna per irisan');
  }
}

const sumbu = kasus[0][1];
tertangkap = null; renderChart(el(), sumbu);
const fmt = tertangkap.options.scales.y.ticks.callback;
console.log('\nFormat sumbu Y: 2500000000 -> "' + fmt(2500000000) + '", 500000000 -> "' + fmt(500000000) + '"');
cek('sumbu', fmt(2500000000) === '2.5 M' && fmt(500000000) === '500 Jt', 'format sumbu tidak sama dengan dashboard');

console.log(masalah ? `\n>>> ${masalah} MASALAH` : '\n>>> semua sesuai gaya dashboard');
process.exit(masalah ? 1 : 0);
