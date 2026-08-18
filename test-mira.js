#!/usr/bin/env node
/**
 * Regression guard for MIRA's retrieval layer.
 *
 * WHY THIS EXISTS
 * Every capability here was built to fix a real, reported wrong answer. Several were then broken
 * again by a later change and had to be re-fixed — the family greeting, the retur rules, the
 * piutang company split, the multi-code product lookup. This file pins those behaviours down so a
 * regression shows up here instead of in front of the branch team.
 *
 * WHAT IT DOES NOT COVER
 * Only the retrieval layer — the deterministic part that decides WHICH data reaches Gemini. It
 * cannot check how Gemini words an answer; that is guided by the system prompt and is not
 * mechanically testable. If retrieval is right and the wording is wrong, the fix belongs in the
 * prompt, not here.
 *
 * RUN:  node test-mira.js
 * Exits non-zero when anything fails, so it can gate a deploy.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- load worker.js as a module (it ships as an ES module for Cloudflare) ----
const workerPath = path.join(__dirname, 'worker.js');
let src = fs.readFileSync(workerPath, 'utf8');
const cut = src.indexOf('export default {');
if (cut < 0) {
  console.error('worker.js: "export default {" not found — file layout changed, update this loader.');
  process.exit(1);
}
src = src.slice(0, cut) + `
module.exports = {
  extractRentangBulan, extractMonthMention, extractAnyDateMention,
  findPerformaPeriode, findPerbandinganTahun, findPencapaianRingkasan, findSisaTarget,
  findCompanyPeriodBreakdown, findInvoiceDetail, findCustomerAktifPeriode, findStockMatches,
  findProductSalesBreakdown, findPiutangByCompany, findPiutangByCustomer, findDuplikasi,
  findPiutangLampau, findReturTransactions, findTransactionMatches, findOnuCredentials,
  findTopPiutangCustomers, findStockValueSummary, findPaymentsByCustomer, findTopProdukByMonth,
  findKabelByCoreCategory, findZonaWilayahMatches, selaraskanYoyBulanBerjalan,
  resolveAccessCode, piutangCompanyOf, normText, normCode, nowMakassar,
};`;
const tmp = path.join(os.tmpdir(), `mira-test-${process.pid}.cjs`);
fs.writeFileSync(tmp, src);
const M = require(tmp);
process.on('exit', () => { try { fs.unlinkSync(tmp); } catch {} });

// ---- fixtures: small, hand-built, independent of live data so results never drift ----
const TAHUN = M.nowMakassar().getFullYear();
const BULAN_INI = M.nowMakassar().getMonth() + 1;
const bln = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const tgl = (d, m, y = TAHUN) => `${d}-${bln[m]}-${y}`;

const TX = [
  { tanggal: tgl(5, 1), invoice: 'INV/MKS/2026/I/001', customer: 'BUDI', kode: 'KSFO028', qty: 10, amount: 1000000, isRetur: false, company: 'MKI', ekspedisi: 'HAND CARRY', lokasi: 'MAKASSAR', stage: 'Complete', status: 'Same Day', tglTerkirim: tgl(5, 1) },
  { tanggal: tgl(5, 1), invoice: 'INV/MKS/2026/I/001', customer: 'BUDI', kode: 'KSFO113', qty: 5, amount: 500000, isRetur: false, company: 'MKI', ekspedisi: 'HAND CARRY', lokasi: 'MAKASSAR', stage: 'Complete', status: 'Same Day', tglTerkirim: tgl(5, 1) },
  { tanggal: tgl(10, 2), invoice: 'R-MKS/2026/II/001', customer: 'BUDI', kode: 'KSFO028', qty: -2, amount: -200000, isRetur: true, company: 'MKI', ekspedisi: 'HAND CARRY', lokasi: 'MAKASSAR', stage: 'Complete', status: 'Same Day', tglTerkirim: tgl(10, 2) },
  { tanggal: tgl(12, 3), invoice: 'INV-CFN/2026/III/007', customer: 'SITI', kode: 'KSFO113', qty: 4, amount: 800000, isRetur: false, company: 'CFN', ekspedisi: 'JNE', lokasi: 'BONE', stage: 'Complete', status: 'Cut Off', tglTerkirim: tgl(13, 3) },
];
const BAYAR = [
  { tanggal: tgl(20, 1), noFaktur: 'INV/MKS/2026/I/001', customer: 'BUDI', amount: 1500000, company: 'MKI' },
  { tanggal: tgl(15, 3), noFaktur: 'INV-CFN/2026/III/007', customer: 'SITI', amount: 300000, company: 'CFN' },
];
const PIUTANG = [
  { tanggal: tgl(12, 3), noFaktur: 'INV-CFN/2026/III/007', customer: 'SITI', nilaiSisa: 500000, agingHari: 40, kategori: '30-45 Hari', company: 'CFN' },
  // Numbered CFN but the Company column says MKI — the real case that made the company split wrong.
  { tanggal: tgl(1, 4), noFaktur: 'INV-CFN/2026/IV/078', customer: 'UMAR', nilaiSisa: 1475000, agingHari: 20, kategori: '0-30 Hari', company: 'MKI' },
];
const STOK = [
  { kode: 'KSFO028', nama: 'Kabel Fiber Optik 1Core Premium', harga: 1030000, stokMKI: 0, stokCFN: 64, stokTotal: 64 },
  { kode: 'KSFO020', nama: 'Kabel Fiber Optik 6 Core', harga: 15670000, stokMKI: 1, stokCFN: 0, stokTotal: 1 },
  { kode: 'KSFO113', nama: 'Kabel Fiber Optik 1Core Cablelink', harga: 940000, stokMKI: 10, stokCFN: 0, stokTotal: 10 },
  // Produk nyata yang namanya memuat kata sehari-hari — inilah yang dulu tersambar oleh kata
  // "kita" dalam kalimat "Kekurangan cabang kita apa saat ini?".
  { kode: 'SFT002', nama: 'Software BASEMAP Kota Makassar', harga: 8000000, stokMKI: 0, stokCFN: 0, stokTotal: 0 },
];
const NAMA_BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
// Includes whichever month is running right now, so "sisa target bulan ini" has something to find
// no matter when the suite is run — an earlier fixture omitted it and the test failed every
// August for a reason that had nothing to do with the code.
const YOY = {
  months: [
    { monthIdx: 0, label: 'Januari', targetSalesRevenue: 1000, sales2025: 100, sales2026: 120, rev2025: 90, rev2026: 100 },
    { monthIdx: 6, label: 'Juli', targetSalesRevenue: 2000, sales2025: 500, sales2026: 300, rev2025: 400, rev2026: 250 },
    { monthIdx: 11, label: 'Desember', targetSalesRevenue: 3000, sales2025: 700, sales2026: 0, rev2025: 600, rev2026: 0 },
  ].concat(
    [0, 6, 11].includes(BULAN_INI - 1)
      ? []
      : [{ monthIdx: BULAN_INI - 1, label: NAMA_BULAN[BULAN_INI - 1], targetSalesRevenue: 5000, sales2025: 800, sales2026: 400, rev2025: 750, rev2026: 350 }]
  ),
  totalSales2025: 1300, totalSales2026: 420, totalRev2025: 1090, totalRev2026: 350, totalTarget: 6000,
};

const ZONA = {
  wilayah: [
    { nama: 'MAKASSAR', total: 120, zone: 'hijau' },
    { nama: 'BONE', total: 35, zone: 'kuning' },
    { nama: 'PALU', total: 8, zone: 'merah' },
    { nama: 'BERAU', total: 1, zone: 'merah' },
    { nama: 'AMBON', total: 0, zone: 'merah' },
  ],
  tanpaPembelanjaan: ['AMBON'],
  provinsi: [],
};

// ---- runner ----
let lulus = 0;
let gagal = 0;
const t = (nama, fn) => {
  try {
    const pesan = fn();
    if (pesan) { gagal++; console.log(`  GAGAL  ${nama}\n         ${pesan}`); }
    else { lulus++; console.log(`  ok     ${nama}`); }
  } catch (e) {
    gagal++;
    console.log(`  ERROR  ${nama}\n         ${e.message}`);
  }
};
const grup = (nama) => console.log(`\n${nama}`);

grup('Kode akses');
t('kode sah dikenali, huruf kecil & spasi ditoleransi', () => {
  const a = M.resolveAccessCode(' rifqi84 ');
  return a && a.nama === 'Rifqi' ? null : `dapat ${JSON.stringify(a)}`;
});
t('kode tidak sah ditolak', () => (M.resolveAccessCode('TEBAKAN99') === null ? null : 'kode asing diterima'));
t('kode kosong ditolak', () => (M.resolveAccessCode('') === null ? null : 'kode kosong diterima'));
t('10 orang terdaftar termasuk Pak Ricky', () => {
  const perlu = ['RIFQI84', 'ASTRID84', 'ADI84', 'REZA84', 'PUTRI84', 'BURHAMIN84', 'ZUL84', 'ASPAR84', 'TAUFIK84', 'MAKASSAR84'];
  const hilang = perlu.filter((k) => !M.resolveAccessCode(k));
  return hilang.length ? `hilang: ${hilang.join(',')}` : null;
});

grup('Stok — kode harus persis, tanpa toleransi typo');
t('KSFO028 mengembalikan tepat KSFO028', () => {
  const r = M.findStockMatches('stok KSFO028', STOK, []);
  return r.items.length === 1 && r.items[0].kode === 'KSFO028' ? null : `dapat ${r.items.map((x) => x.kode).join(',')}`;
});
t('KSFO028 tidak menarik KSFO020 (beda 1 digit = produk lain)', () => {
  const r = M.findStockMatches('stok KSFO028', STOK, []);
  return r.items.some((x) => x.kode === 'KSFO020') ? 'produk lain ikut terbawa' : null;
});
t('stok per company mengembalikan ringkasan', () => {
  const r = M.findStockMatches('stok CFN', STOK, []);
  return r.items.length ? null : 'ringkasan company kosong';
});

grup('Produk — beberapa kode sekaligus');
t('dua kode diminta, dua-duanya dikembalikan', () => {
  const r = M.findProductSalesBreakdown('penjualan KSFO113 dan KSFO028', TX);
  return r && r.perKode && r.perKode.length === 2 ? null : `dapat ${r ? r.perKode.length : 'null'} kode`;
});
t('bulan tanpa penjualan tetap muncul sebagai 0, bukan hilang', () => {
  const r = M.findProductSalesBreakdown('penjualan KSFO028', TX);
  const p = r.perKode[0].perBulan;
  return p.length >= BULAN_INI ? null : `hanya ${p.length} bulan, seharusnya ${BULAN_INI}`;
});

grup('Invoice');
t('nomor sebagian menemukan invoice penuh', () => {
  const r = M.findInvoiceDetail('CFN/2026/III/007', TX, BAYAR, PIUTANG, STOK);
  return r && r.noInvoice === 'INV-CFN/2026/III/007' ? null : `dapat ${r && r.noInvoice}`;
});
t('nomor tidak ada -> ditemukan:false, bukan mengarang', () => {
  const r = M.findInvoiceDetail('invoice INV/MKS/2026/XII/999', TX, BAYAR, PIUTANG, STOK);
  return r && r.ditemukan === false ? null : `dapat ${JSON.stringify(r && r.ditemukan)}`;
});
t('rincian barang ikut disertakan', () => {
  const r = M.findInvoiceDetail('INV/MKS/2026/I/001', TX, BAYAR, PIUTANG, STOK);
  return r && r.barang && r.barang.length === 2 ? null : `barang: ${r && r.barang && r.barang.length}`;
});
t('MKI diterjemahkan ke MKS saat mencari', () => {
  const r = M.findInvoiceDetail('MKI/2026/I/001', TX, BAYAR, PIUTANG, STOK);
  return r && (r.noInvoice === 'INV/MKS/2026/I/001' || r.modeDaftar) ? null : `dapat ${JSON.stringify(r && r.noInvoice)}`;
});

grup('Piutang per company');
t('company dibaca dari kolom asli, bukan ditebak dari nomor faktur', () => {
  const r = M.findPiutangByCompany('piutang MKI', PIUTANG);
  // INV-CFN/2026/IV/078 is numbered CFN but belongs to MKI.
  return r && r.totalPiutang === 1475000 ? null : `MKI dapat ${r && r.totalPiutang}, seharusnya 1475000`;
});
t('CFN tidak ikut kebagian invoice milik MKI', () => {
  const r = M.findPiutangByCompany('piutang CFN', PIUTANG);
  return r && r.totalPiutang === 500000 ? null : `CFN dapat ${r && r.totalPiutang}, seharusnya 500000`;
});

grup('Retur');
t('retur dikenali dari prefix R-', () => {
  const r = M.findReturTransactions('retur bulan ini', TX);
  return r && r.jumlahBarisRetur >= 1 ? null : 'retur tidak terdeteksi';
});
t('invoice unik tidak menghitung retur', () => {
  const r = M.findTransactionMatches(`transaksi tanggal ${10}/${2}/${TAHUN}`, TX);
  const rs = r.ringkasanTanggal;
  return !rs || rs.jumlahInvoiceUnik === 0 ? null : `retur ikut terhitung: ${rs && rs.jumlahInvoiceUnik}`;
});

grup('Periode & perbandingan');
t('"Mei-Juli" dibaca sebagai satu rentang', () => {
  const r = M.extractRentangBulan('performa Mei-Juli');
  return r && r.mode === 'rentang' && r.periode[0].dari === 5 && r.periode[0].sampai === 7 ? null : JSON.stringify(r);
});
t('"Maret dan Juni" dibaca sebagai dua bulan terpisah', () => {
  const r = M.extractRentangBulan('perbandingan Maret dan Juni');
  return r && r.mode === 'perbandingan' && r.periode.length === 2 ? null : JSON.stringify(r);
});
t('tahun yang ditulis ikut terbaca (Juli 2025 bukan Juli tahun ini)', () => {
  const r = M.extractRentangBulan('bandingkan Juli 2025 dan Juli 2026');
  return r && r.periode[0].tahun === 2025 && r.periode[1].tahun === 2026 ? null : JSON.stringify(r);
});
t('pertanyaan tanpa bulan tidak dianggap punya periode', () => (M.extractRentangBulan('berapa sales hari ini') === null ? null : 'terdeteksi periode padahal tidak ada'));
t('performa tahun lampau ditolak (data mentah hanya tahun berjalan)', () => (M.findPerformaPeriode('performa Juli 2025', TX, BAYAR, STOK) === null ? null : 'dijawab dengan data tahun berjalan'));
t('perbandingan tahun memakai periode setara, bukan setahun penuh', () => {
  const r = M.findPerbandinganTahun('perbandingan sales tahun lalu dan tahun ini', YOY);
  if (!r || r.lingkup !== 'tahun') return `lingkup ${r && r.lingkup}`;
  // Desember has no 2026 figures, so it must be excluded from the like-for-like window.
  return r.periodeSetara.bulanDibandingkan.includes('Desember') ? 'bulan tanpa data ikut dibandingkan' : null;
});
t('perbandingan satu bulan antar tahun', () => {
  const r = M.findPerbandinganTahun('bandingkan Juli 2025 dan Juli 2026', YOY);
  return r && r.lingkup === 'bulan' && r.sales.tahunLalu === 500 && r.sales.tahunIni === 300 ? null : JSON.stringify(r && r.sales);
});

grup('Per company, periode bebas');
t('sales MKI terpisah dari CFN', () => {
  const r = M.findCompanyPeriodBreakdown('sales MKI tahun ini', TX, BAYAR);
  return r && r.company === 'MKI' && r.sales === 1300000 ? null : `dapat ${r && r.sales}, seharusnya 1300000`;
});
t('piutang per company tidak dibajak fungsi ini', () => (M.findCompanyPeriodBreakdown('piutang CFN', TX, BAYAR) === null ? null : 'ikut terpicu, seharusnya lewat piutangPerCompany'));

grup('Duplikasi');
t('nomor sama tanggal beda tetap dilaporkan sebagai duplikasi', () => {
  const p = [
    { tanggal: tgl(1, 5), noFaktur: 'INV/MKS/2026/V/001', customer: 'A', nilaiSisa: 100, agingHari: 5, kategori: '0-30 Hari', company: 'MKI' },
    { tanggal: tgl(20, 5), noFaktur: 'INV/MKS/2026/V/001', customer: 'A', nilaiSisa: 100, agingHari: 5, kategori: '0-30 Hari', company: 'MKI' },
  ];
  const r = M.findDuplikasi('cek duplikasi piutang', TX, BAYAR, p);
  const d = r && r.piutangFakturGanda;
  if (!d || d.totalKasusDuplikasi !== 1) return `kasus: ${d && d.totalKasusDuplikasi}`;
  return d.jumlahNomorSamaTanggalBeda === 1 && d.jumlahTagihGanda === 0 ? null : 'salah kategori';
});
t('tanggal sama + nilai sama = tagih ganda', () => {
  const p = [
    { tanggal: tgl(1, 5), noFaktur: 'INV/MKS/2026/V/002', customer: 'B', nilaiSisa: 100, agingHari: 5, kategori: '0-30 Hari', company: 'MKI' },
    { tanggal: tgl(1, 5), noFaktur: 'INV/MKS/2026/V/002', customer: 'B', nilaiSisa: 100, agingHari: 5, kategori: '0-30 Hari', company: 'MKI' },
  ];
  const r = M.findDuplikasi('cek duplikasi piutang', TX, BAYAR, p);
  const d = r && r.piutangFakturGanda;
  return d && d.jumlahTagihGanda === 1 ? null : `tagih ganda: ${d && d.jumlahTagihGanda}`;
});

grup('Piutang lampau 2015-2025');
t('"piutang terlama" membaca arsip lama, bukan AR tahun berjalan', () => {
  const r = M.findPiutangLampau('siapa piutang terlama?');
  return r && r.tahunPalingLama === 2015 ? null : `tahun terlama ${r && r.tahunPalingLama}`;
});
t('pertanyaan tahun tertentu menyaring arsip', () => {
  const r = M.findPiutangLampau('piutang tahun 2017');
  return r && r.mode === 'perTahun' && r.tahun === 2017 ? null : JSON.stringify(r && r.mode);
});

grup('Kredensial ONU');
t('kode ONU dikenal mengembalikan kredensial', () => {
  const r = M.findOnuCredentials('password ONU FL327D');
  return r && r.daftar && r.daftar.length ? null : 'kredensial tidak ditemukan';
});
t('pertanyaan stok ONU tidak membocorkan kredensial', () => (M.findOnuCredentials('stok ONUA023 berapa') === null ? null : 'kredensial ikut terkirim tanpa diminta'));

// ---------------------------------------------------------------------------
// Phrasing variations.
//
// This section exists because the suite once passed while a capability was
// visibly broken: piutang lampau was checked with one wording only, so a year
// RANGE ("2015 sampai 2025") returning just the first year, and a follow-up
// that dropped the topic word ("kalau tahun 2017") returning nothing, both went
// unnoticed. People do not ask the same question the same way twice, so every
// wording below must reach data — that is what stops "right today, wrong next
// week".
// ---------------------------------------------------------------------------
grup('Variasi kalimat — semua bentuk harus terjawab');
const variasi = (judul, fn, kalimat) => {
  t(judul, () => {
    const gagal = kalimat.filter((k) => !fn(k));
    return gagal.length ? `tidak terjawab: ${gagal.map((x) => `"${x}"`).join(', ')}` : null;
  });
};

variasi('stok per kode', (k) => M.findStockMatches(k, STOK, []).items.length, [
  'stok KSFO028', 'stock KSFO028', 'KSFO028 ada berapa', 'sisa stok KSFO028', 'cek stok KSFO028',
]);
variasi('piutang per company', (k) => M.findPiutangByCompany(k, PIUTANG), [
  'piutang CFN', 'piutang CFN berapa', 'berapa piutang CFN', 'sisa saldo piutang CFN', 'total piutang CFN',
]);
variasi('penjualan per kode', (k) => M.findProductSalesBreakdown(k, TX), [
  'penjualan KSFO028', 'sales KSFO028', 'KSFO028 terjual berapa', 'qty KSFO028',
]);
variasi('performa periode', (k) => M.findPerformaPeriode(k, TX, BAYAR, STOK), [
  'performa Mei-Juli', 'kinerja Mei-Juli', 'bagaimana performa Mei-Juli', 'tren penjualan Mei-Juli',
]);
variasi('perbandingan tahun', (k) => M.findPerbandinganTahun(k, YOY), [
  'perbandingan sales tahun lalu dan tahun ini', 'sales 2025 vs 2026',
  'bandingkan penjualan 2025 dengan 2026', 'pertumbuhan dibanding tahun lalu',
]);
variasi('sisa target', (k) => M.findSisaTarget(k, YOY, []), [
  'sisa target bulan ini', 'kekurangan target bulan ini', 'kurang berapa lagi target bulan ini',
]);
variasi('per company + periode', (k) => M.findCompanyPeriodBreakdown(k, TX, BAYAR), [
  'sales MKI bulan ini', 'penjualan MKI bulan ini', 'omzet MKI bulan ini', 'revenue MKI hari ini',
]);
variasi('customer aktif periode', (k) => M.findCustomerAktifPeriode(k, TX), [
  'persentase customer aktif sejak Mei', 'berapa persen customer aktif sejak Mei', 'customer aktif sejak Mei',
]);
variasi('piutang lampau', (k) => M.findPiutangLampau(k, []), [
  'piutang lampau', 'list piutang 2015 sampai 2025', 'piutang tahun 2017',
  'piutang terlama', 'arsip piutang lama',
]);
variasi('retur', (k) => M.findReturTransactions(k, TX), [
  'retur bulan ini', 'return bulan ini', 'ada retur bulan ini', 'pengembalian barang bulan ini',
]);

grup('Variasi kalimat — kemampuan lainnya');
variasi('detail invoice', (k) => M.findInvoiceDetail(k, TX, BAYAR, PIUTANG, STOK), [
  'INV/MKS/2026/I/001', 'detail invoice INV/MKS/2026/I/001', 'isi invoice MKS/2026/I/001',
  'faktur MKS/2026/I/001 isinya apa', 'invoice MKS/2026/I/001 sudah lunas?',
]);
variasi('siapa belanja pada tanggal', (k) => M.findTransactionMatches(k, TX).items.length, [
  `siapa belanja tanggal 5/1/${TAHUN}`, `siapa yang berbelanja 5/1/${TAHUN}`,
  `transaksi tanggal 5/1/${TAHUN}`, `penjualan tanggal 5/1/${TAHUN}`,
]);
variasi('piutang per customer', (k) => M.findPiutangByCustomer(k, PIUTANG), [
  'piutang SITI', 'piutang SITI berapa', 'berapa tagihan SITI', 'sisa piutang SITI',
]);
variasi('customer piutang tertinggi', (k) => M.findTopPiutangCustomers(k, PIUTANG), [
  'customer piutang tertinggi', 'siapa piutang terbesar', 'piutang paling tinggi siapa',
]);
variasi('nilai stok', (k) => M.findStockValueSummary(k, STOK), [
  'nilai stok gudang', 'berapa nilai stok', 'total nilai stok gudang',
]);
variasi('pembayaran per customer', (k) => M.findPaymentsByCustomer(k, BAYAR, PIUTANG), [
  'kapan BUDI terakhir bayar', 'riwayat pembayaran BUDI', 'pelunasan BUDI',
]);
variasi('produk terlaris per bulan', (k) => M.findTopProdukByMonth(k, TX, STOK), [
  'produk terlaris Januari', 'produk paling laku bulan Januari', 'ranking produk Januari',
]);
variasi('kredensial ONU', (k) => M.findOnuCredentials(k), [
  'password ONU FL327D', 'username ONU FL327D', 'login ONU FL327D apa', 'kredensial ONU FL327D',
]);
variasi('kategori kabel core', (k) => M.findKabelByCoreCategory(k, STOK, TX), [
  'kabel 1 core', 'kabel 1 core apa saja', 'stok kabel 1 core',
]);
variasi('duplikasi', (k) => M.findDuplikasi(k, TX, BAYAR, PIUTANG), [
  'cek duplikasi', 'cek duplikasi piutang', 'ada duplikasi invoice?', 'periksa duplikasi',
]);
variasi('zona wilayah', (k) => M.findZonaWilayahMatches(k, ZONA), [
  'zona wilayah', 'zona wilayah kita bagaimana', 'wilayah zona merah', 'wilayah tanpa pembelanjaan',
]);

t('"wilayah paling lemah" tidak diambil dari ekor daftar teratas', () => {
  const r = M.findZonaWilayahMatches('wilayah mana yang paling lemah', ZONA);
  if (!r || r.tipe !== 'ringkasan') return 'pertanyaan terlemah tidak terjawab';
  if (!Array.isArray(r.wilayahTerlemah) || !r.wilayahTerlemah.length) return 'tidak ada field wilayahTerlemah';
  if (r.wilayahTerlemah[0].nama !== 'BERAU') return `terlemah dilaporkan ${r.wilayahTerlemah[0].nama}, seharusnya BERAU (1 invoice)`;
  if (r.wilayahTerlemah.some((w) => w.total === 0)) return 'wilayah tanpa pembelanjaan ikut masuk daftar terlemah';
  if (r.wilayahTeratas[0].nama !== 'MAKASSAR') return 'urutan teratas ikut rusak';
  return null;
});

grup('Satu bulan = satu angka (sheet vs buku transaksi)');
// Reported live: MIRA answered Rp606.839.800 for August sales while its own ledger said
// Rp597.119.800 — the Sales SUM sheet's YoY column had not refreshed, and BOTH numbers were in
// context at once, so the same question answered differently depending on which field was read.
// Closed months must stay untouched; only the running month follows the ledger.
t('bulan berjalan mengikuti buku transaksi, bukan kolom rekap sheet', () => {
  const kunci = `${TAHUN}-${String(BULAN_INI).padStart(2, '0')}`;
  const perf = { performance: [{ bulan: kunci, sales: 597119800, transaksi: 144 }] };
  const rev = { monthly: [{ bulan: kunci, revenue: 532201150 }] };
  const yoy = {
    months: [{ monthIdx: BULAN_INI - 1, label: NAMA_BULAN[BULAN_INI - 1], targetSalesRevenue: 1766666667, sales2025: 1, sales2026: 606839800, rev2025: 1, rev2026: 999 }],
    totalSales2025: 1, totalRev2025: 1, totalTarget: 1766666667, totalSales2026: 606839800, totalRev2026: 999,
  };
  const h = M.selaraskanYoyBulanBerjalan(yoy, perf, rev);
  const b = h.months[0];
  if (b.sales2026 !== 597119800) return `sales bulan berjalan masih ${b.sales2026}`;
  if (b.rev2026 !== 532201150) return `revenue bulan berjalan masih ${b.rev2026}`;
  if (h.totalSales2026 !== 597119800) return 'total tahunan tidak ikut dihitung ulang';
  if (!h.catatanPenyelarasan) return 'tidak ada catatan penyelarasan untuk Gemini';
  return null;
});
t('bulan yang sudah tutup TIDAK ikut diubah', () => {
  const lain = BULAN_INI === 1 ? 1 : 0; // pastikan bukan bulan berjalan
  const yoy = {
    months: [{ monthIdx: lain, label: NAMA_BULAN[lain], targetSalesRevenue: 100, sales2025: 1, sales2026: 2157219279, rev2025: 1, rev2026: 500 }],
    totalSales2025: 1, totalRev2025: 1, totalTarget: 100, totalSales2026: 2157219279, totalRev2026: 500,
  };
  const perf = { performance: [{ bulan: `${TAHUN}-${String(lain + 1).padStart(2, '0')}`, sales: 999, transaksi: 1 }] };
  const h = M.selaraskanYoyBulanBerjalan(yoy, perf, null);
  return h.months[0].sales2026 === 2157219279 ? null : 'bulan tutup ikut tertimpa';
});
t('tanpa buku transaksi pembanding, angka bulanan tidak disentuh', () => {
  const yoy = { months: [{ monthIdx: BULAN_INI - 1, label: 'X', sales2025: 4, sales2026: 5, rev2025: 4, rev2026: 5 }], totalSales2025: 4, totalRev2025: 4 };
  const h = M.selaraskanYoyBulanBerjalan(yoy, null, null);
  return h.months[0].sales2026 === 5 && h.months[0].rev2026 === 5 ? null : 'angka bulanan ikut berubah padahal tak ada pembanding';
});
// Reported live: asked what the branch's biggest problem was, MIRA answered with a -33,7%
// contraction. That number divides a part-year 2026 by a full-year 2025. The same eight months
// side by side are +1,9%. Growth must always mean like-for-like months.
t('pertumbuhan tahunan memakai periode setara, bukan tahun penuh vs sebagian', () => {
  const months = [
    { monthIdx: 0, label: 'Januari', sales2025: 100, sales2026: 110, rev2025: 100, rev2026: 110 },
    { monthIdx: 1, label: 'Februari', sales2025: 100, sales2026: 0, rev2025: 100, rev2026: 0 },
    { monthIdx: 2, label: 'Maret', sales2025: 100, sales2026: 0, rev2025: 100, rev2026: 0 },
  ];
  const yoy = { months, totalSales2025: 300, totalRev2025: 300, totalSales2026: 110, totalRev2026: 110, totalTarget: 0 };
  const h = M.selaraskanYoyBulanBerjalan(yoy, null, null);
  if (Math.round(h.growthSalesPersen) !== 10) return `growthSalesPersen ${h.growthSalesPersen} — seharusnya +10% (Januari saja)`;
  if (Math.round(h.growthRevPersen) !== 10) return `growthRevPersen ${h.growthRevPersen} — seharusnya +10%`;
  if (!h.pertumbuhanPeriodeSetara || h.pertumbuhanPeriodeSetara.bulanDibandingkan.join() !== 'Januari') return 'daftar bulan setara salah';
  const tak = h.pertumbuhanTidakSetaraJanganDipakai;
  if (!tak || Math.round(tak.sales) !== -63) return 'angka tidak setara hilang atau salah label';
  return null;
});

grup('Rentang tahun & pertanyaan lanjutan (dua bug nyata)');
t('rentang tahun mengembalikan SELURUH rentang, bukan tahun pertama saja', () => {
  const r = M.findPiutangLampau('list piutang 2015 sampai 2025', []);
  if (!r || r.mode !== 'rentangTahun') return `mode ${r && r.mode}, seharusnya rentangTahun`;
  return r.jumlahPelanggan === 30 ? null : `${r.jumlahPelanggan} pelanggan, seharusnya 30 (seluruh arsip)`;
});
t('tahun tanpa data tidak membuat arsip lain ikut hilang', () => {
  const r = M.findPiutangLampau('piutang tahun 2017', []);
  return r && r.mode === 'perTahun' && r.jumlahPelanggan === 6 ? null : `dapat ${r && r.jumlahPelanggan} pelanggan, seharusnya 6`;
});
t('lanjutan tanpa kata "piutang" tetap terjawab', () => {
  const h = [{ role: 'user', text: 'list piutang lampau 2015 sampai 2025' }, { role: 'model', text: 'arsip piutang lampau 2015-2025' }];
  const r = M.findPiutangLampau('kalau tahun 2017', h);
  return r && r.mode === 'perTahun' && r.tahun === 2017 ? null : 'follow-up tidak terjawab';
});

grup('Kata sehari-hari tidak boleh tersambar jadi produk');
// Dilaporkan live: ditanya "Kekurangan cabang kita apa saat ini?", MIRA menyebut Software BASEMAP
// Kota Makassar sebagai kekurangan cabang. Produknya nyata dan memang ada di sheet, tapi sama
// sekali tidak relevan — kata "kita" tercocok ke "Kota" lewat toleransi typo pada nama produk.
// Dari sisi pembaca itu terlihat seperti mengarang.
[
  'Kekurangan cabang kita apa saat ini?',
  'apa masalah kita sekarang',
  'piutang kita berapa',
  'target kita bulan ini',
  'bagaimana kinerja kita',
  'rencana kerja kita ke depan',
].forEach((kalimat) => {
  t(`"${kalimat}" tidak menarik produk apa pun`, () => {
    const dapat = (M.findStockMatches(kalimat, STOK, []) || {}).items || [];
    return dapat.length ? `menarik ${dapat.map((x) => x.kode).join(',')} padahal bukan pertanyaan produk` : null;
  });
});
t('pencarian produk sungguhan tetap jalan', () => {
  for (const [kalimat, harus] of [['stok KSFO028', 'KSFO028'], ['KSFO113', 'KSFO113'], ['stok BASEMAP', 'SFT002']]) {
    const dapat = ((M.findStockMatches(kalimat, STOK, []) || {}).items || []).map((x) => x.kode);
    if (!dapat.includes(harus)) return `"${kalimat}" kehilangan ${harus} (dapat: ${dapat.join(',') || 'kosong'})`;
  }
  return null;
});
t('typo pada nama produk tetap dimaafkan kalau pertanyaannya pendek', () => {
  const dapat = (M.findStockMatches('kabell', STOK, []) || {}).items || [];
  return dapat.length ? null : 'typo pendek tidak lagi ditoleransi — terlalu ketat';
});

console.log(`\n${'='.repeat(52)}`);
console.log(`lulus: ${lulus}   gagal: ${gagal}`);
if (gagal) { console.log('ADA REGRESI — jangan deploy sebelum diperbaiki.'); process.exit(1); }
console.log('Semua perilaku inti MIRA masih utuh.');
