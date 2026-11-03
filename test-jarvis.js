#!/usr/bin/env node
/**
 * Penjaga untuk mode Jarvis (jarvis.html).
 *
 * Yang diuji: logika murni di dalam jarvis.html — pembaca kata panggil "Hei MIRA", perintah diam
 * dan penutup sesi, penyaring gema suara MIRA sendiri, peringkas jawaban untuk dibacakan, penyaji
 * markdown yang aman — dan bahwa aturan pengucapan salinan masih sama dengan index.html.
 *
 * YANG TIDAK BISA DIUJI DI SINI: pengenal suara sungguhan dan akurasinya pada logat dan ruangan
 * kantor. Itu diuji terpisah oleh test-jarvis-e2e.js dengan pengenal suara tiruan, yang memastikan
 * rangkaian keadaannya benar tetapi tidak mengukur seberapa baik Google mengenali suara.
 *
 * RUN:  node test-jarvis.js
 */
const fs = require('fs');
const path = require('path');
const { ambilBlok } = require('./sinkron-tts-jarvis.js');

const html = fs.readFileSync(path.join(__dirname, 'jarvis.html'), 'utf8');
const mulai = html.indexOf('// ==== JARVIS-LOGIKA-MULAI ====');
const selesai = html.indexOf('// ==== JARVIS-LOGIKA-SELESAI ====');
if (mulai < 0 || selesai < 0) { console.error('Penanda logika tidak ditemukan di jarvis.html.'); process.exit(1); }
const L = new Function(`${html.slice(mulai, selesai)}
  return { ambilPanggilan, ambilPanggilanDariAlternatif, rapikanUcapanDomain, lengkapiPertanyaanLanjutan, nilaiLevelMikrofon, apakahAkhiriSesi, apakahPerintahDiam, apakahGemaSuaraSendiri, ringkasUntukDibacakan, rencanaBicara, markdownKeHtml, escapeHtml };`)();

let lulus = 0;
let gagal = 0;
const t = (nama, fn) => {
  try {
    const pesan = fn();
    if (pesan) { gagal++; console.log(`  GAGAL  ${nama}\n         ${pesan}`); } else { lulus++; console.log(`  ok     ${nama}`); }
  } catch (e) { gagal++; console.log(`  ERROR  ${nama}\n         ${e.stack.split('\n').slice(0, 2).join(' | ')}`); }
};
const grup = (n) => console.log(`\n${n}`);

// ---------------------------------------------------------------------------------------------
grup('Kata panggil — "Hei MIRA"');
const uji = (s) => L.ambilPanggilan(s);
t('"Hei MIRA, berapa sales hari ini" dikenali dan pertanyaannya dipisah', () => {
  const r = uji('Hei MIRA, berapa sales hari ini');
  return r.dipanggil && r.pertanyaan === 'berapa sales hari ini' ? null : JSON.stringify(r);
});
t('sapaan lain yang wajar juga dikenali: hai, hey, halo, hi', () => {
  for (const s of ['Hai MIRA target hari ini', 'hey mira, target hari ini', 'Halo Mira target hari ini', 'hi mira target hari ini']) {
    const r = uji(s);
    if (!r.dipanggil || r.pertanyaan !== 'target hari ini') return `"${s}" -> ${JSON.stringify(r)}`;
  }
  return null;
});
t('varian ejaan dari pengenal suara dikenali: Mirah, Myra, Mila, dan sapaan yang menempel', () => {
  for (const s of ['hei mirah target hari ini', 'Hei Myra target hari ini', 'hai mila target hari ini', 'Heimira target hari ini', 'hei, mira. target hari ini']) {
    const r = uji(s);
    if (!r.dipanggil || r.pertanyaan !== 'target hari ini') return `"${s}" -> ${JSON.stringify(r)}`;
  }
  return null;
});
t('hanya dipanggil tanpa pertanyaan: dipanggil=true, pertanyaan kosong', () => {
  for (const s of ['Hei MIRA', 'hei mira.', 'Hai, Mira!']) {
    const r = uji(s);
    if (!r.dipanggil || r.pertanyaan !== '') return `"${s}" -> ${JSON.stringify(r)}`;
  }
  return null;
});
t('NAMA SAJA CUKUP: "MIRA" di awal ucapan memanggil tanpa perlu "Hei"', () => {
  for (const s of ['Mira berapa sales hari ini', 'MIRA, berapa sales hari ini', 'mirah berapa sales hari ini']) {
    const r = uji(s);
    if (!r.dipanggil || r.pertanyaan !== 'berapa sales hari ini') return `"${s}" -> ${JSON.stringify(r)}`;
  }
  return null;
});
t('NAMA DI MANA SAJA: di akhir atau di tengah ucapan juga memanggil, dan nama dibuang dari pertanyaan', () => {
  const cek = { 'berapa sales hari ini, MIRA': 'berapa sales hari ini', 'tolong mira cek stok KSFO028': 'tolong cek stok KSFO028', 'berapa piutang CFN mira?': 'berapa piutang CFN', 'kalau kemarin hei mira': 'kalau kemarin' };
  for (const [s, harus] of Object.entries(cek)) {
    const r = uji(s);
    if (!r.dipanggil || r.pertanyaan !== harus) return `"${s}" -> ${JSON.stringify(r)}`;
  }
  return null;
});
t('nama longgar (mia, mila, mera) TANPA sapaan tidak memanggil — itu nama orang biasa', () => {
  for (const s of ['Mia tolong kirim laporan', 'Mila sudah datang belum', 'kemarin bareng mera ke gudang', 'berapa sales hari ini mia']) {
    if (uji(s).dipanggil) return `"${s}" dianggap panggilan`;
  }
  return null;
});
t('nama longgar DENGAN sapaan di awal tetap memanggil (suara jauh)', () => {
  for (const s of ['hai mia target hari ini', 'hei mila target hari ini']) {
    const r = uji(s);
    if (!r.dipanggil || r.pertanyaan !== 'target hari ini') return `"${s}" -> ${JSON.stringify(r)}`;
  }
  return null;
});
t('nama yang menempel pada kata lain tidak memanggil: Samira, Amira, Mirabel', () => {
  for (const s of ['Samira minta data piutang', 'tolong kasih ke Amira', 'Mirabel belum bayar', 'berapa target Almira']) {
    if (uji(s).dipanggil) return `"${s}" dianggap panggilan`;
  }
  return null;
});
t('obrolan kantor biasa tidak dianggap panggilan', () => {
  for (const s of ['berapa sales hari ini', 'tolong siapkan laporan', 'Pak Rifqi minta data piutang', 'hai semuanya', 'halo selamat pagi', 'hei Mirza tolong stok']) {
    if (uji(s).dipanggil) return `"${s}" dianggap panggilan`;
  }
  return null;
});
t('kata yang hanya mirip nama tidak dianggap panggilan', () => {
  for (const s of ['hei Mirae asset berapa', 'hai Miranda minta stok', 'halo mirasantika berapa']) {
    if (uji(s).dipanggil) return `"${s}" dianggap panggilan`;
  }
  return null;
});
t('batas ambang gema dapat diatur: satu kata saja cukup membuktikan gema selagi MIRA bicara', () => {
  const bicara = 'Saya MIRA asisten cabang Makassar';
  if (L.apakahGemaSuaraSendiri('saya mira', bicara)) return 'ambang bawaan (4 kata) seharusnya belum menganggap gema';
  if (!L.apakahGemaSuaraSendiri('saya mira', bicara, 1)) return 'ambang 1 kata seharusnya gema';
  return L.apakahGemaSuaraSendiri('mira berhenti', bicara, 1) ? '"berhenti" tidak ada di jawaban, bukan gema' : null;
});

grup('Perintah diam dan penutup sesi');
t('"Hei MIRA, berhenti" dan sejenisnya dikenali sebagai perintah diam', () => {
  for (const s of ['berhenti', 'diam', 'stop', 'sudah', 'oke berhenti', 'tahan dulu', 'berhenti dulu ya']) {
    if (!L.apakahPerintahDiam(s)) return `"${s}" bukan perintah diam`;
  }
  return null;
});
t('pertanyaan yang memuat kata diam/berhenti BUKAN perintah diam', () => {
  for (const s of ['customer yang berhenti belanja siapa', 'berapa invoice yang sudah dikirim', 'stop kontak stok berapa', 'siapa yang diam diam menunggak']) {
    if (L.apakahPerintahDiam(s)) return `"${s}" salah dianggap perintah diam`;
  }
  return null;
});
t('ucapan penutup mengakhiri sesi', () => {
  for (const s of ['terima kasih', 'Terima kasih MIRA', 'makasih ya', 'sudah cukup', 'cukup', 'oke terima kasih banyak', 'selesai', 'Hai MIRA terima kasih']) {
    if (!L.apakahAkhiriSesi(s)) return `"${s}" tidak mengakhiri sesi`;
  }
  return null;
});
t('pertanyaan yang kebetulan memuat kata penutup TIDAK mengakhiri sesi', () => {
  for (const s of ['customer yang berhenti belanja siapa', 'sudah berapa piutang CFN', 'terima kasih tolong cek stok KSFO028 sekarang', 'berapa cukup stok untuk bulan ini', 'selesai dikirim berapa invoice']) {
    if (L.apakahAkhiriSesi(s)) return `"${s}" salah mengakhiri sesi`;
  }
  return null;
});

grup('Penyaring gema suara MIRA sendiri');
const DIBACAKAN = 'Sales hari ini sudah 15464900 Rupiah dari target 83539062 Rupiah. Revenue hari ini 15464900 Rupiah dari target 88176108 Rupiah.';
t('hasil pengenalan dari suara MIRA sendiri dikenali sebagai gema', () => {
  const gema = ['sales hari ini sudah dari target rupiah revenue hari ini dari target rupiah', 'Sales hari ini sudah 15464900 Rupiah dari target'];
  for (const g of gema) if (!L.apakahGemaSuaraSendiri(g, DIBACAKAN)) return `"${g}" tidak dikenali sebagai gema`;
  return null;
});
t('gema jawaban yang PENUH ANGKA tetap dikenali (angka ditulis beda oleh pengenal suara)', () => {
  // Kasus paling umum: jawaban MIRA berisi nominal. Pengenal suara menulis "15.464.900" atau
  // mengeja angkanya, tidak pernah persis seperti teks aslinya — angka tidak boleh menentukan.
  const spoken = 'Sales hari ini sudah 15464900 Rupiah dari target 83539062 Rupiah';
  for (const g of ['sales hari ini sudah 15.464.900 rupiah dari target 83.539.062 rupiah', 'sales hari ini sudah lima belas juta rupiah dari target delapan puluh tiga juta']) {
    if (!L.apakahGemaSuaraSendiri(g, spoken)) return `"${g}" tidak dikenali sebagai gema`;
  }
  return null;
});
t('ucapan yang isinya hampir hanya angka tidak dinilai sebagai gema', () => {
  return L.apakahGemaSuaraSendiri('15 464 900 dan 83 539 062 serta 88 176 108', 'Sales hari ini sudah 15464900 Rupiah') ? 'ucapan berisi angka dianggap gema' : null;
});
t('pertanyaan lanjutan yang memakai beberapa kata yang sama TIDAK dianggap gema', () => {
  // Pertanyaan lanjutan sungguhan sering memakai kata dari jawaban sebelumnya.
  for (const g of ['berapa revenue hari ini', 'bagaimana dengan invoice unik hari ini', 'kalau target bulanan berapa', 'siapa customer yang piutangnya terbesar']) {
    if (L.apakahGemaSuaraSendiri(g, DIBACAKAN)) return `"${g}" salah dianggap gema`;
  }
  return null;
});
t('ucapan yang terlalu pendek tidak dinilai sebagai gema', () => {
  return L.apakahGemaSuaraSendiri('hari ini', DIBACAKAN) ? 'ucapan pendek dianggap gema' : null;
});
t('tanpa teks yang dibacakan, tidak ada yang dianggap gema', () => {
  return L.apakahGemaSuaraSendiri('berapa sales hari ini kemarin', '') ? 'dianggap gema padahal tidak ada pembanding' : null;
});

grup('Ringkasan untuk dibacakan');
const JAWAB_ZONA = 'Halo Pak Rifqi, selamat siang! Senang sekali bisa ngobrol lagi dengan Bapak di hari Selasa ini. Semoga aktivitas dan suasana di kantor MKI Makassar hari ini menyenangkan, ya.\n\nUntuk pemetaan zona wilayah MKI Makassar sepanjang tahun berjalan ini, kita sudah mencakup total **122 wilayah** di berbagai kabupaten dan kota. Berikut sebaran zonanya:\n* 🟢 **Zona Hijau:** 18 wilayah\n* 🟡 **Zona Kuning:** 12 wilayah\n* 🔴 **Zona Merah:** 92 wilayah\n\nWilayah zona merah seperti Pare-Pare dan Morowali masih di bawah 20 invoice. Ada wilayah tertentu yang ingin kita bedah lebih detail, Pak Rifqi?\n\nSemoga hari Bapak menyenangkan dan lancar ya!';
const JAWAB_TARGET = 'Halo Pak Rifqi, selamat malam menjelang dini hari ya... Semoga istirahatnya tenang dan nyaman setelah seharian beraktivitas. Alhamdullilah, Mira senang sekali mendampingi Pak Rifqi malam ini.\n\nTerkait target harian resmi cabang kita untuk hari ini (Minggu, 16 Agustus 2026), berdasarkan papan KPI monitoring, rinciannya sebagai berikut:\n\n1. **Sales** — Realisasi **Rp15.464.900** dari target **Rp83.539.062** (❌ NOT ACHIEVE)\n2. **Revenue** — Realisasi **Rp15.464.900** dari target **Rp88.176.108** (❌ NOT ACHIEVE)\n3. **Invoice Unik** — Realisasi **6** invoice dari target **10** invoice (❌ NOT ACHIEVE)\n\nSemoga hari baru nanti membawa energi dan pencapaian yang jauh lebih baik untuk MKI Makassar ya, Pak. Istirahat yang cukup ya, Pak Rifqi, supaya besok segar lagi!';
t('sapaan pembuka dan doa penutup dibuang, isi dipertahankan', () => {
  const s = L.ringkasUntukDibacakan(JAWAB_ZONA);
  if (/selamat siang|Semoga aktivitas|menyenangkan dan lancar/i.test(s)) return `sapaan/penutup masih ada: ${s}`;
  return /122 wilayah/.test(s) ? null : `isi hilang: ${s}`;
});
t('kalimat berangka tidak pernah dibuang, termasuk yang diawali kata sapaan', () => {
  const s = L.ringkasUntukDibacakan(JAWAB_TARGET);
  for (const w of ['Rp15.464.900', 'Rp83.539.062']) if (!s.includes(w)) return `angka ${w} hilang: ${s}`;
  return /Semoga hari baru|Istirahat yang cukup|selamat malam/i.test(s) ? `sapaan/penutup masih ada: ${s}` : null;
});
t('kalimat berangka yang KEBETULAN berbunyi seperti sapaan tetap dipertahankan', () => {
  // Kalimat pertama diawali "Halo", kalimat kedua diawali "Senang sekali bisa" — keduanya pola
  // sapaan, tapi keduanya membawa angka sehingga tidak boleh dibuang.
  const s = L.ringkasUntukDibacakan('Halo Pak Rifqi, sales hari ini sudah Rp15.464.900.\n\nSenang sekali bisa menyampaikan target invoice tercapai 105 persen.\n\nSemoga hari Bapak lancar.');
  if (!s.includes('Rp15.464.900')) return `angka sales hilang: ${s}`;
  return s.includes('105 persen') ? null : `angka 105 persen hilang: ${s}`;
});
t('jawaban panjang dipotong dan diberi petunjuk bahwa selengkapnya ada di layar', () => {
  const panjang = 'Berikut rinciannya.\n' + Array.from({ length: 30 }, (_, i) => `${i + 1}. Wilayah ke-${i + 1} mencatat ${100 - i} invoice sepanjang tahun ini.`).join('\n');
  const s = L.ringkasUntukDibacakan(panjang);
  if (s.length > 520) return `terlalu panjang (${s.length} karakter)`;
  return /Selengkapnya ada di layar/.test(s) ? null : 'tidak ada petunjuk selengkapnya di layar';
});
t('blok grafik dan baris tabel tidak ikut dibacakan', () => {
  const s = L.ringkasUntukDibacakan('Penjualan naik 5 persen.\n\n```chart\n{"type":"line","labels":["Jan"],"datasets":[{"data":[1]}]}\n```\n\n| Bulan | Nilai |\n|---|---|\n| Jan | 100 |\n');
  return /chart|datasets|\||Bulan/.test(s) ? `bocor: ${s}` : (/5 persen/.test(s) ? null : `isi hilang: ${s}`);
});
t('blok grafik yang belum selesai (terpotong) juga dibuang', () => {
  const s = L.ringkasUntukDibacakan('Penjualan naik.\n```chart\n{"type":"line","lab');
  return /chart|labels|\{/.test(s) ? `bocor: ${s}` : null;
});
t('mode lengkap membacakan semuanya tanpa dipotong', () => {
  const s = L.ringkasUntukDibacakan(JAWAB_ZONA, { lengkap: true });
  return /selamat siang/.test(s) && /Semoga hari Bapak/.test(s) && !/Selengkapnya/.test(s) ? null : 'mode lengkap memotong atau menambah petunjuk';
});
t('jawaban yang seluruhnya sapaan tidak berubah jadi kosong', () => {
  const s = L.ringkasUntukDibacakan('Halo Pak Rifqi, selamat siang!');
  return s.length ? null : 'hasil kosong';
});

grup('Bicara bertahap — mulai bicara sebelum jawaban selesai mengalir');
const SAMPEL = [
  JAWAB_ZONA, JAWAB_TARGET,
  'Halo Pak Rifqi! Senang sekali rasanya bisa ngobrol lagi dengan Bapak sore ini. Untuk sales hari ini (Selasa, 3 November 2026), total pencapaian kita adalah **Rp17.813.500** dari total **8 invoice unik**. Semoga penjualan sore ini makin ramai ya, Pak. Kabari kalau butuh rinciannya.',
  'Stok **KSFO028** — Kabel Fiber Optik 1Core: - Stok MKI: 0 - Stok CFN: 138 - Total: **138** - Harga satuan: Rp985.000',
  ['Halo Pak Rifqi, selamat sore.', '', '1. Piutang total Rp1.464.257.455.', '2. Rasio AR 9,51%.', '3. Umur 0-30 hari Rp300.000.000.', '4. Umur 31-60 hari Rp200.000.000.',
    '5. Umur 61-90 hari Rp100.000.000.', '6. Lebih dari 90 hari Rp50.000.000.', '', 'Semoga membantu ya, Pak. Ada yang mau didalami?'].join(String.fromCharCode(10)),
];
t('hasil akhir bertahap SAMA PERSIS dengan ringkasan biasa (tak ada perilaku yang berubah)', () => {
  for (const [i, j] of SAMPEL.entries()) {
    const r = L.rencanaBicara(j, true);
    const gabung = r.kalimat.join(' ') + (r.terpotong ? ' Selengkapnya ada di layar.' : '');
    const biasa = L.ringkasUntukDibacakan(j);
    if (gabung !== biasa) return `sampel ${i}: bertahap="${gabung}" biasa="${biasa}"`;
  }
  return null;
});
t('AWALAN: pada setiap titik aliran, yang sudah boleh dibacakan adalah awalan dari hasil akhir', () => {
  // Inilah jaminan bahwa kalimat yang sudah terlanjur diucapkan tidak pernah salah. Aliran dipotong
  // di SETIAP posisi karakter, termasuk di tengah angka dan di tengah kata.
  for (const [i, j] of SAMPEL.entries()) {
    const akhir = L.rencanaBicara(j, true).kalimat;
    for (let n = 0; n <= j.length; n++) {
      const sebagian = L.rencanaBicara(j.slice(0, n), false).kalimat;
      if (sebagian.length > akhir.length || sebagian.some((k, x) => k !== akhir[x])) return `sampel ${i}, terpotong di ${n}: "${sebagian.join(' | ')}" bukan awalan dari "${akhir.join(' | ')}"`;
    }
  }
  return null;
});
t('angka yang baru separuh tiba tidak pernah dibacakan terpotong ("Rp17." dari "Rp17.813.500")', () => {
  const j = SAMPEL[2];
  const n = j.indexOf('Rp17.') + 5;
  const sebagian = L.rencanaBicara(j.slice(0, n), false).kalimat.join(' ');
  return /Rp17\.(?!813)/.test(sebagian) || /Rp17$/.test(sebagian) ? `kalimat separuh ikut: "${sebagian}"` : null;
});
t('mulai bicara lebih awal: kalimat berisi sudah keluar sebelum jawaban selesai', () => {
  const j = SAMPEL[2];
  const awal = L.rencanaBicara(j.slice(0, j.indexOf('Semoga')), false).kalimat;
  return awal.length >= 1 && /Rp17\.813\.500/.test(awal.join(' ')) ? null : JSON.stringify(awal);
});
t('sapaan di depan tidak pernah dibacakan, bahkan saat hanya sapaan yang sudah tiba', () => {
  const j = 'Halo Pak Rifqi! Senang sekali rasanya bisa ngobrol lagi dengan Bapak sore ini. ';
  return L.rencanaBicara(j, false).kalimat.length === 0 ? null : JSON.stringify(L.rencanaBicara(j, false));
});
t('kalimat penutup ditahan, tidak diucapkan sebelum jelas ia penutup', () => {
  const j = SAMPEL[2];
  const sampaiPenutup = j.slice(0, j.indexOf('Kabari') + 20); // "Semoga ..." sudah lengkap, "Kabari ..." belum
  const k = L.rencanaBicara(sampaiPenutup, false).kalimat.join(' ');
  return /Semoga|Kabari/.test(k) ? `penutup ikut diucapkan: "${k}"` : null;
});
t('blok kode/grafik yang belum utuh tidak dibacakan', () => {
  const j = 'Berikut grafiknya. ' + '`'.repeat(3) + 'chart' + String.fromCharCode(10) + '{"type":"bar","data":[1,2';
  return /chart|type|bar/.test(L.rencanaBicara(j, false).kalimat.join(' ')) ? 'isi blok ikut dibacakan' : null;
});

grup('Penyaji markdown — harus aman');
t('tag HTML dari jawaban di-escape, tidak dijalankan', () => {
  const h = L.markdownKeHtml('<script>alert(1)</script> <img src=x onerror=alert(2)> **tebal**');
  if (/<script|<img/i.test(h)) return `HTML mentah lolos: ${h}`;
  return /<strong>tebal<\/strong>/.test(h) ? null : `pemformatan hilang: ${h}`;
});
t('tautan dibuat aman (rel noopener) dan tidak bisa menyisipkan atribut', () => {
  const h = L.markdownKeHtml('lihat https://falcom-technology.com/produk dan "><svg onload=alert(1)>');
  if (/<svg/i.test(h)) return `elemen asing lolos: ${h}`;
  return /rel="noopener noreferrer"/.test(h) ? null : 'tautan tanpa rel noopener';
});
t('tabel markdown disederhanakan menjadi baris biasa', () => {
  const h = L.markdownKeHtml('| Bulan | Nilai |\n|---|---|\n| Jan | 100 |');
  return !/\|---/.test(h) && /Jan · 100/.test(h) ? null : h;
});

grup('Suara dari jauh — hipotesis ganda');
t('kata panggil yang salah dengar di hipotesis teratas ditemukan di hipotesis lain', () => {
  const r = L.ambilPanggilanDariAlternatif(['hai nira stok ksfo 028', 'hai mira stok ksfo 028']);
  return r.dipanggil && r.indeks === 1 && /ksfo/.test(r.pertanyaan) ? null : JSON.stringify(r);
});
t('hipotesis teratas yang sudah benar dipakai lebih dulu', () => {
  const r = L.ambilPanggilanDariAlternatif(['hei mira target hari ini', 'hei mila target hari ini']);
  return r.dipanggil && r.indeks === 0 && r.pertanyaan === 'target hari ini' ? null : JSON.stringify(r);
});
t('obrolan tanpa panggilan di hipotesis mana pun tetap TIDAK memanggil', () => {
  const r = L.ambilPanggilanDariAlternatif(['kita rapat jam tiga', 'kita rapat jam 3', 'kita rapat jam tiga ya']);
  return !r.dipanggil && r.indeks === 0 ? null : JSON.stringify(r);
});
t('daftar kosong tidak membuat galat', () => (L.ambilPanggilanDariAlternatif([]).dipanggil === false ? null : 'harus false'));

grup('Memahami istilah kantor yang salah tulis');
const AWALAN = new Set(['KSFO', 'OLT']);
const rapi = (s) => L.rapikanUcapanDomain(s, AWALAN);
t('kode barang yang dieja disatukan: "k s f o nol dua delapan" -> KSFO028', () => {
  for (const s of ['stok k s f o nol dua delapan', 'stok k s f o 0 2 8', 'stok k s f o 028']) {
    if (rapi(s) !== 'stok KSFO028') return `"${s}" -> "${rapi(s)}"`;
  }
  return null;
});
t('awalan dikenal + angka terpisah spasi disatukan: "ksfo 028" -> KSFO028', () => (rapi('stok ksfo 028') === 'stok KSFO028' ? null : rapi('stok ksfo 028')));
t('angka biasa TIDAK dirusak: "stok 028" dan "kode 100" tetap', () => {
  for (const s of ['stok 028', 'kode 100 ada berapa', 'sales 15 Agustus']) if (rapi(s) !== s) return `"${s}" -> "${rapi(s)}"`;
  return null;
});
t('istilah umum diperbaiki: "c f n", "invois", "revenu"', () => {
  const r = rapi('piutang c f n invois dan revenu');
  return r === 'piutang CFN invoice dan revenue' ? null : r;
});
t('huruf terpisah yang BUKAN istilah dikenal dibiarkan', () => (rapi('a b c ada berapa') === 'a b c ada berapa' ? null : rapi('a b c ada berapa')));

grup('Memahami pertanyaan lanjutan');
const lanj = (a, b) => L.lengkapiPertanyaanLanjutan(a, b);
t('"kalau kemarin" mengganti waktu pada pertanyaan sebelumnya', () => {
  const r = lanj('kalau kemarin', 'berapa sales hari ini');
  return r.dilengkapi && r.teks === 'berapa sales kemarin' ? null : JSON.stringify(r);
});
t('"kalau CFN" menambah company pada pertanyaan sebelumnya', () => {
  const r = lanj('kalau CFN', 'berapa sales hari ini');
  return r.dilengkapi && /sales hari ini untuk CFN/.test(r.teks) ? null : JSON.stringify(r);
});
t('tanpa pertanyaan sebelumnya, lanjutan dikirim apa adanya', () => {
  const r = lanj('kalau kemarin', '');
  return !r.dilengkapi && r.teks === 'kalau kemarin' ? null : JSON.stringify(r);
});
t('pertanyaan yang sudah punya topik sendiri TIDAK dilengkapi', () => {
  const r = lanj('piutang CFN', 'berapa sales hari ini');
  return !r.dilengkapi && r.teks === 'piutang CFN' ? null : JSON.stringify(r);
});
t('waktu tidak ditempelkan ke topik yang tak bermakna menurut waktu (stok)', () => {
  const r = lanj('kalau kemarin', 'stok KSFO028');
  return !r.dilengkapi && r.teks === 'kalau kemarin' ? null : JSON.stringify(r);
});

grup('Alat ukur suara masuk');
t('ambang: keras / baik / pelan / hampir tidak terdengar', () => {
  const s = (p) => L.nilaiLevelMikrofon(p).status;
  const hasil = [s(0.9), s(0.1), s(0.01), s(0.001), s(0)].join('|');
  return hasil === 'terlalu keras|baik|pelan|hampir tidak terdengar|hampir tidak terdengar' ? null : hasil;
});

grup('Salinan aturan pengucapan');
t('aturan pengucapan di jarvis.html masih sama dengan index.html', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const a = html.indexOf('// ==== TTS-SALINAN-MULAI');
  const b = html.indexOf('// ==== TTS-SALINAN-SELESAI ====');
  const salinan = html.slice(html.indexOf('\n', a) + 1, b).replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const asli = ambilBlok(index).replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return salinan === asli ? null : 'salinan tertinggal dari index.html — jalankan: node sinkron-tts-jarvis.js';
});
t('kode barang dan rupiah dilafalkan sama seperti di MIRA biasa', () => {
  const a = html.indexOf('// ==== TTS-SALINAN-MULAI');
  const b = html.indexOf('// ==== TTS-SALINAN-SELESAI ====');
  const blok = html.slice(html.indexOf('\n', a) + 1, b);
  const f = new Function('window', `${blok}\nreturn buildSpeechSegments;`)({});
  const ucap = f('Stok **KSFO028** ada 64 dan harganya Rp1.030.000 untuk FATUM BACHMID').map((s) => s.text).join(' ');
  if (!/K S F O 0 2 8/.test(ucap)) return `kode barang tidak dieja: ${ucap}`;
  if (!/1030000 Rupiah/.test(ucap)) return `rupiah tidak dilafalkan: ${ucap}`;
  return /Fatum Bachmid/.test(ucap) ? null : `nama customer tidak dibaca sebagai nama: ${ucap}`;
});

console.log(`\n${'='.repeat(52)}\nlulus: ${lulus}   gagal: ${gagal}`);
if (gagal) { console.log('ADA REGRESI — jangan di-push sebelum diperbaiki.'); process.exit(1); }
console.log('Logika mode Jarvis utuh.');
