#!/usr/bin/env node
/**
 * Penjaga untuk mode Jarvis (jarvis.html).
 *
 * Yang diuji: logika murni di dalam jarvis.html — pendeteksi tepuk ganda, pembaca kalimat
 * "Hai MIRA", penutup sesi, peringkas jawaban untuk dibacakan, penyaji markdown yang aman — dan
 * bahwa aturan pengucapan salinan masih sama dengan index.html.
 *
 * YANG TIDAK BISA DIUJI DI SINI: mikrofon dan ruangan yang sebenarnya. Pendeteksi tepuk diuji
 * dengan sinyal SINTETIS (derau berpeluruhan untuk tepukan, nada berharmonik untuk ucapan, dst.).
 * Itu membuktikan logikanya benar dan membedakan jenis suara, tapi ambang yang cocok untuk satu
 * mikrofon di satu ruangan tetap harus disetel di tempat lewat meter dan pilihan kepekaan.
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
  return { hitungStatFrame, SENSITIVITAS_TEPUK, buatPendeteksiTepuk, ambilPertanyaan, apakahAkhiriSesi, ringkasUntukDibacakan, markdownKeHtml, escapeHtml };`)();

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
// Pembangkit sinyal sintetis
// ---------------------------------------------------------------------------------------------
const SR = 48000;
let benih = 12345;
const acak = () => { benih = (benih * 1664525 + 1013904223) >>> 0; return benih / 4294967296 * 2 - 1; };
const detik = (s) => Math.round(s * SR);

function senyap(dur, amp = 0.01) { const a = new Float32Array(detik(dur)); for (let i = 0; i < a.length; i++) a[i] = acak() * amp; return a; }
// Tepukan: derau berpeluruhan eksponensial. `tumpul` menurunkan ZCR seperti mikrofon/ruangan yang meredam nada tinggi.
function tepukan(amp = 0.6, tau = 0.015, tumpul = 0) {
  const n = detik(0.12); const a = new Float32Array(n); let y = 0;
  for (let i = 0; i < n; i++) {
    const x = amp * Math.exp(-i / (SR * tau)) * acak();
    y = tumpul ? y + tumpul * (x - y) : x;
    a[i] = y;
  }
  return a;
}
// Ucapan bersuara: nada dasar ~140 Hz dengan harmonik, naik-turun pada irama suku kata.
function ucapan(dur, amp = 0.25) {
  const n = detik(dur); const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR; let v = 0;
    for (let k = 1; k <= 8; k++) v += Math.sin(2 * Math.PI * 140 * k * t) / k;
    a[i] = amp * 0.45 * v * (0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * 2 * t)));
  }
  return a;
}
// Desis "s" / napas keras: derau lebar yang BERTAHAN.
function desis(dur, amp = 0.3) { const a = new Float32Array(detik(dur)); for (let i = 0; i < a.length; i++) a[i] = acak() * amp; return a; }
function ketikan(amp = 0.05) { return tepukan(amp, 0.003); }

function susun(potongan, total) {
  // potongan: [[waktuMulaiDetik, Float32Array], ...] ditumpuk di atas derau ruangan
  const out = senyap(total, 0.01);
  for (const [t0, p] of potongan) { const o = detik(t0); for (let i = 0; i < p.length && o + i < out.length; i++) out[o + i] += p[i]; }
  return out;
}
function jalankan(sinyal, sens = 'sedang', pengganda = 1) {
  const d = L.buatPendeteksiTepuk({ sensitivitas: sens });
  d.setPengganda(pengganda);
  const hop = detik(0.01); const hasil = [];
  for (let i = 0; i + hop <= sinyal.length; i += hop) {
    const s = L.hitungStatFrame(sinyal.subarray(i, i + hop));
    const r = d.proses(s, (i + hop) / SR);
    if (r) hasil.push(r);
  }
  return hasil;
}
const ganda = (h) => h.filter((x) => x === 2).length;

// ---------------------------------------------------------------------------------------------
grup('Pendeteksi tepuk — yang HARUS terdeteksi');
t('tepuk dua kali (selang 0,3 detik) terdeteksi sebagai tepuk ganda', () => {
  const h = jalankan(susun([[0.5, tepukan()], [0.8, tepukan()]], 2));
  return ganda(h) === 1 ? null : `hasil ${JSON.stringify(h)}`;
});
t('tepukan lebih tumpul (ZCR lebih rendah, mikrofon meredam nada tinggi) tetap terdeteksi', () => {
  const x = tepukan(0.6, 0.015, 0.35);
  const st = L.hitungStatFrame(x.subarray(0, detik(0.01)));
  const h = jalankan(susun([[0.5, tepukan(0.6, 0.015, 0.35)], [0.82, tepukan(0.6, 0.015, 0.35)]], 2));
  return ganda(h) === 1 ? null : `ZCR tepukan tumpul ${st.zcr.toFixed(2)}; hasil ${JSON.stringify(h)}`;
});
t('selang 0,17 dan 0,65 detik (batas bawah dan atas wajar) terdeteksi', () => {
  for (const s of [0.17, 0.65]) {
    const h = jalankan(susun([[0.5, tepukan()], [0.5 + s, tepukan()]], 2.5));
    if (ganda(h) !== 1) return `selang ${s}: hasil ${JSON.stringify(h)}`;
  }
  return null;
});
t('tepukan yang lebih pelan terdeteksi pada kepekaan tinggi', () => {
  const h = jalankan(susun([[0.5, tepukan(0.14)], [0.8, tepukan(0.14)]], 2), 'tinggi');
  return ganda(h) === 1 ? null : `hasil ${JSON.stringify(h)}`;
});
t('tepuk ganda terdeteksi di tengah percakapan pelan di latar', () => {
  const latar = ucapan(3, 0.04);
  const h = jalankan(susun([[0, latar], [1.0, tepukan(0.7)], [1.3, tepukan(0.7)]], 3));
  return ganda(h) === 1 ? null : `hasil ${JSON.stringify(h)}`;
});
t('dua pasang tepukan berjauhan masing-masing terdeteksi', () => {
  const h = jalankan(susun([[0.5, tepukan()], [0.8, tepukan()], [4.0, tepukan()], [4.3, tepukan()]], 6));
  return ganda(h) === 2 ? null : `terdeteksi ${ganda(h)} pasang, seharusnya 2`;
});

grup('Pendeteksi tepuk — yang TIDAK BOLEH terdeteksi');
t('satu tepukan saja tidak memicu', () => {
  const h = jalankan(susun([[0.5, tepukan()]], 2));
  return ganda(h) === 0 && h.includes(1) ? null : `hasil ${JSON.stringify(h)}`;
});
t('dua tepukan berjauhan (1,2 detik) tidak dihitung ganda', () => {
  const h = jalankan(susun([[0.5, tepukan()], [1.7, tepukan()]], 3));
  return ganda(h) === 0 ? null : `hasil ${JSON.stringify(h)}`;
});
t('selang terlalu pendek (0,06 detik, tumpang tindih) tidak dihitung ganda', () => {
  const h = jalankan(susun([[0.5, tepukan()], [0.56, tepukan(0.4)]], 2));
  return ganda(h) === 0 ? null : `hasil ${JSON.stringify(h)}`;
});
t('selang 0,12 detik (gema/pantulan tepukan yang sama) tidak dihitung ganda', () => {
  // Zona 0,10-0,15 detik: cukup jauh untuk dikenali sebagai tepukan terpisah, terlalu dekat untuk
  // tepukan manusia yang disengaja. Hanya zona ini yang menguji cabang penolak gema.
  const h = jalankan(susun([[0.5, tepukan()], [0.62, tepukan()]], 2));
  return ganda(h) === 0 ? null : `hasil ${JSON.stringify(h)}`;
});
t('dentuman bernada rendah (ketukan meja, pintu) tidak memicu walau mendadak dan cepat reda', () => {
  // Impulsif dan peluruhannya cepat, jadi lolos syarat puncak, onset, dan peredaman. Yang
  // membedakannya dari tepukan hanya ZCR: dentuman itu nada rendah, tepukan itu derau lebar.
  const dentum = (amp) => { const n = detik(0.12); const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = amp * Math.exp(-i / (SR * 0.02)) * Math.sin(2 * Math.PI * 110 * i / SR); return a; };
  const st = L.hitungStatFrame(dentum(0.7).subarray(0, detik(0.01)));
  const h = jalankan(susun([[0.5, dentum(0.7)], [0.8, dentum(0.7)]], 2));
  return h.length === 0 ? null : `dentuman dianggap tepukan (ZCR ${st.zcr.toFixed(3)}): ${JSON.stringify(h)}`;
});
t('ucapan manusia (nada berharmonik) tidak memicu', () => {
  const h = jalankan(susun([[0.3, ucapan(2.5, 0.3)]], 3.5));
  return h.length === 0 ? null : `ucapan dianggap tepukan: ${JSON.stringify(h)}`;
});
t('ucapan keras sekalipun tidak memicu, di semua tingkat kepekaan', () => {
  for (const s of ['rendah', 'sedang', 'tinggi']) {
    const h = jalankan(susun([[0.3, ucapan(2.5, 0.8)]], 3.5), s);
    if (h.length) return `kepekaan ${s}: ${JSON.stringify(h)}`;
  }
  return null;
});
t('desis atau napas keras yang bertahan (150 ms) tidak memicu, walau ZCR-nya setinggi tepukan', () => {
  const h = jalankan(susun([[0.5, desis(0.15)], [0.85, desis(0.15)]], 2));
  return h.length === 0 ? null : `desis dianggap tepukan: ${JSON.stringify(h)}`;
});
t('ketikan keyboard pelan tidak memicu pada kepekaan sedang', () => {
  const h = jalankan(susun([[0.5, ketikan()], [0.68, ketikan()], [0.86, ketikan()]], 2));
  return h.length === 0 ? null : `ketikan dianggap tepukan: ${JSON.stringify(h)}`;
});
t('ruangan sunyi sepanjang 10 detik tidak memicu apa pun', () => {
  const h = jalankan(senyap(10, 0.015));
  return h.length === 0 ? null : `derau ruangan dianggap tepukan: ${JSON.stringify(h)}`;
});

grup('Pendeteksi tepuk — saat MIRA sedang berbicara');
t('suara MIRA sendiri (ucapan lewat speaker) tidak memicu penyelaan', () => {
  const h = jalankan(susun([[0.2, ucapan(3, 0.35)]], 4), 'sedang', 1.8);
  return h.length === 0 ? null : `suara sendiri dianggap tepukan: ${JSON.stringify(h)}`;
});
t('tepuk ganda yang tegas tetap bisa menyela walau ambang dinaikkan', () => {
  const h = jalankan(susun([[0.2, ucapan(3, 0.2)], [1.0, tepukan(0.9)], [1.3, tepukan(0.9)]], 4), 'sedang', 1.8);
  return ganda(h) === 1 ? null : `hasil ${JSON.stringify(h)}`;
});

grup('Kalimat pemanggil — "Hai MIRA"');
const uji = (s) => L.ambilPertanyaan(s);
t('"Hai MIRA, berapa sales hari ini" dikenali dan pertanyaannya dipisah', () => {
  const r = uji('Hai MIRA, berapa sales hari ini');
  return r.dipanggil && r.pertanyaan === 'berapa sales hari ini' ? null : JSON.stringify(r);
});
t('varian ejaan dari pengenal suara dikenali: Mirah, Myra, Mila, hei, halo', () => {
  for (const s of ['hai mirah target hari ini', 'Hei Myra target hari ini', 'halo mila target hari ini', 'Mira target hari ini', 'hey mira, target hari ini']) {
    const r = uji(s);
    if (!r.dipanggil || r.pertanyaan !== 'target hari ini') return `"${s}" -> ${JSON.stringify(r)}`;
  }
  return null;
});
t('hanya dipanggil tanpa pertanyaan: dipanggil=true, pertanyaan kosong', () => {
  const r = uji('Hai MIRA');
  return r.dipanggil && r.pertanyaan === '' ? null : JSON.stringify(r);
});
t('ucapan tanpa memanggil MIRA tidak dianggap panggilan', () => {
  for (const s of ['berapa sales hari ini', 'tolong siapkan laporan', 'Pak Rifqi minta data piutang', 'hai semuanya']) {
    if (uji(s).dipanggil) return `"${s}" dianggap panggilan`;
  }
  return null;
});
t('kata yang hanya mirip nama tidak dianggap panggilan', () => {
  for (const s of ['Mirae asset berapa', 'Miranda minta stok', 'mirasantika berapa']) {
    if (uji(s).dipanggil) return `"${s}" dianggap panggilan`;
  }
  return null;
});
t('menyebut MIRA di tengah kalimat bukan panggilan', () => (uji('katanya MIRA bisa cek stok').dipanggil ? 'terbaca sebagai panggilan' : null));

grup('Penutup sesi');
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
