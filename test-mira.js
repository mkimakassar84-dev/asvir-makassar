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
];
const YOY = {
  months: [
    { monthIdx: 0, label: 'Januari', targetSalesRevenue: 1000, sales2025: 100, sales2026: 120, rev2025: 90, rev2026: 100 },
    { monthIdx: 6, label: 'Juli', targetSalesRevenue: 2000, sales2025: 500, sales2026: 300, rev2025: 400, rev2026: 250 },
    { monthIdx: 11, label: 'Desember', targetSalesRevenue: 3000, sales2025: 700, sales2026: 0, rev2025: 600, rev2026: 0 },
  ],
  totalSales2025: 1300, totalSales2026: 420, totalRev2025: 1090, totalRev2026: 350, totalTarget: 6000,
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

console.log(`\n${'='.repeat(52)}`);
console.log(`lulus: ${lulus}   gagal: ${gagal}`);
if (gagal) { console.log('ADA REGRESI — jangan deploy sebelum diperbaiki.'); process.exit(1); }
console.log('Semua perilaku inti MIRA masih utuh.');
