#!/usr/bin/env node
/**
 * Uji ujung-ke-ujung mode Jarvis di Chrome sungguhan.
 *
 * Yang SUNGGUHAN: halaman jarvis.html dengan seluruh mesin keadaan, DOM, penjadwalan ulang
 * pendengar, dan peringkas jawaban. Yang DIGANTI STUB: SpeechRecognition dan speechSynthesis
 * (butuh layanan Google dan speaker) serta /chat (supaya tidak memakai kuota dan tidak butuh kode
 * akses asli). Stub pengenal suara dikendalikan dari skenario: tiap "ucapan" disuntikkan sebagai
 * hasil pengenalan sementara atau final.
 *
 * YANG TIDAK DIUKUR: seberapa baik Google mengenali suara pada logat dan ruangan kantor. Tes ini
 * membuktikan bahwa GIVEN transkrip tertentu, MIRA bereaksi dengan benar — tidak lebih.
 *
 * Tiga belas skenario, termasuk yang menjaga keamanan: obrolan kantor tanpa "Hei MIRA" tidak pernah
 * sampai ke MIRA, suara MIRA sendiri tidak dianggap pertanyaan, dan setelah dimatikan pendengar
 * tidak menyala lagi.
 *
 * Butuh Google Chrome terpasang (atau atur CHROME_PATH).
 * RUN:  node test-jarvis-e2e.js            (semua skenario)
 *       node test-jarvis-e2e.js gema       (satu skenario)
 * HALAMAN=https://... node test-jarvis-e2e.js   (uji terhadap alamat sungguhan)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { pathToFileURL } = require('url');

const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && fs.existsSync(p));
const HALAMAN = process.env.HALAMAN || pathToFileURL(path.join(__dirname, 'jarvis.html')).href;
const PORT = 9333;
const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));

const STUB = `
  localStorage.setItem('miraAccessCode', 'TES');
  window.__log = [];
  window.__states = [];
  window.__lamaBicara = 40;
  window.__rec = null;
  window.__jumlahRec = 0;
  // Merekam SETIAP perpindahan keadaan di dalam halaman. Polling dari luar melewatkan keadaan yang
  // berlangsung sesaat (mis. "berpikir" saat balasan stub datang seketika).
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(() => window.__states.push(document.body.dataset.state))
      .observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
  });

  class FakeRec {
    start() { window.__rec = this; window.__jumlahRec++; window.__log.push('rec.start'); }
    stop() {}
    abort() { window.__log.push('rec.abort'); }
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeRec;

  // Pengendali yang dipanggil dari skenario.
  // alternatif: hipotesis tambahan dari pengenal suara (maxAlternatives), urutan terbaik dulu.
  window.__ucapkan = (teks, final, alternatif) => {
    const r = window.__rec;
    if (!r || !r.onresult) return false;
    const daftar = [{ transcript: teks, confidence: 0.8 }].concat((alternatif || []).map((t) => ({ transcript: t, confidence: 0.4 })));
    const item = Object.assign(daftar, { isFinal: final !== false });
    r.onresult({ resultIndex: 0, results: [item] });
    return true;
  };
  window.__akhiriRec = () => { const r = window.__rec; if (r && r.onend) r.onend(); };
  window.__galatRec = (k) => { const r = window.__rec; if (r && r.onerror) r.onerror({ error: k }); };

  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    getVoices() { return []; }, onvoiceschanged: null,
    cancel() { window.__log.push('cancel'); const u = window.__sedang; window.__sedang = null; if (u && u.onerror) setTimeout(() => u.onerror(), 0); },
    speak(u) {
      window.__log.push('bicara:' + String(u.text)); // teks SESUDAH aturan pengucapan: tanda baca sudah dibuang ("Sama sama", bukan "Sama-sama")
      window.__sedang = u;
      setTimeout(() => { if (window.__sedang === u) { window.__sedang = null; if (u.onend) u.onend(); } }, window.__lamaBicara);
    },
  } });
  window.SpeechSynthesisUtterance = function (t) { this.text = t; };

  const asli = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    if (String(url).endsWith('/chat')) {
      const b = JSON.parse(opts.body);
      window.__log.push('chat:' + b.message + '|kode=' + b.accessCode);
      const enc = new TextEncoder();
      const isi = 'Halo Pak Rifqi, selamat siang! Sales hari ini sudah Rp15.464.900 dari target Rp83.539.062. Semoga hari Bapak lancar ya.';
      const data = 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: isi }] } }] }) + '\\n\\n';
      return Promise.resolve(new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(data)); c.close(); } }), { status: 200 }));
    }
    return asli(url, opts);
  };
`;

// ---------------------------------------------------------------------------------------------
// Skenario. Tiap skenario menerima `s` (pembantu) dan mengembalikan { nama: boolean } untuk dinilai.
// ---------------------------------------------------------------------------------------------
const berurutan = (urutan, daftar) => { let i = 0; for (const x of urutan) if (x === daftar[i]) i++; return i === daftar.length; };
const jumlah = (log, awalan) => (log || []).filter((l) => l.startsWith(awalan)).length;

const SKENARIO = {
  async 'panggil-dan-tanya'(s) {
    await s.aktifkan();
    await s.ucapkan('hei mira', false);                       // sementara: terdengar dipanggil
    await s.ucapkan('Hei MIRA, berapa sales hari ini');       // final: sertakan pertanyaan
    await s.tungguState('sesi', 4000);
    const dibacakan = (await s.log()).filter((l) => l.startsWith('bicara:')).join(' ');
    await s.jedaManusia();
    await s.ucapkan('terima kasih');
    await s.tungguState('siaga', 4000);
    const log = await s.log(); const urutan = await s.urutan();
    return {
      'urutan siaga>berpikir>berbicara>sesi>berbicara>siaga': berurutan(urutan, ['siaga', 'berpikir', 'berbicara', 'sesi', 'berbicara', 'siaga']),
      'pertanyaan terkirim TANPA kata "Hei MIRA"': log.some((l) => l.startsWith('chat:berapa sales hari ini|kode=TES')),
      'angka ikut dibacakan': /15464900/.test(dibacakan),
      'sapaan pembuka TIDAK dibacakan': !/halo|selamat siang/i.test(dibacakan),
      'doa penutup TIDAK dibacakan': !/semoga/i.test(dibacakan),
      'penutup dijawab "Sama-sama" dan kembali siaga': log.some((l) => /^bicara:Sama sama/.test(l)),
      'jawaban tampil di layar': /15\.464\.900/.test(await s.layar()),
    };
  },

  async 'abaikan-obrolan-kantor'(s) {
    await s.aktifkan();
    for (const kalimat of ['berapa sales hari ini', 'Mira berapa sales hari ini', 'tolong siapkan laporan piutang', 'katanya hei mira bisa cek stok', 'hai semuanya selamat pagi']) {
      await s.ucapkan(kalimat);
      await tunggu(80);
    }
    const log = await s.log(); const urutan = await s.urutan();
    return {
      'tidak satu pun obrolan dikirim ke MIRA': jumlah(log, 'chat:') === 0,
      'MIRA tidak berbicara': jumlah(log, 'bicara:') === 0,
      'tetap siaga sepanjang waktu': urutan.every((x) => x === 'siaga'),
      'ucapan yang diabaikan ditandai di layar': /diabaikan/.test(await s.dengar()),
    };
  },

  async 'hanya-dipanggil'(s) {
    await s.aktifkan();
    await s.ucapkan('Hei MIRA');
    await s.tungguState('sesi', 3000);
    const log1 = await s.log();
    await s.jedaManusia();
    await s.ucapkan('target hari ini');
    await s.tungguState('sesi', 4000);
    const log2 = await s.log(); const urutan = await s.urutan();
    return {
      'dijawab "Ya, saya dengar." tanpa memanggil MIRA': log1.some((l) => /^bicara:Ya saya dengar/.test(l)) && jumlah(log1, 'chat:') === 0,
      'lalu menunggu pertanyaan (sesi)': berurutan(urutan, ['siaga', 'berbicara', 'sesi']),
      'pertanyaan di sesi terkirim tanpa perlu "Hei MIRA" lagi': log2.some((l) => l.startsWith('chat:target hari ini|')),
    };
  },

  async 'menyela-dengan-suara'(s) {
    await s.aktifkan();
    await s.set('window.__lamaBicara = 30000');               // MIRA "bicara" 30 detik kecuali diputus
    await s.ucapkan('Hei MIRA, berapa sales hari ini');
    await s.tungguState('berbicara', 4000);
    const sebelum = await s.log();
    await s.ucapkan('hei mira', false);                       // hasil SEMENTARA saja: harus langsung diam
    await tunggu(200);
    const sesudah = await s.log(); const urutanSementara = await s.urutan();
    await s.ucapkan('Hei MIRA, stok KSFO028');
    await tunggu(300);
    const akhir = await s.log();
    return {
      'sempat berbicara': urutanSementara.includes('berbicara'),
      'ucapan dipotong begitu "Hei MIRA" terdengar (belum menunggu final)': sesudah.lastIndexOf('cancel') > sebelum.lastIndexOf('cancel'),
      'langsung masuk sesi (menyela), bukan menunggu ucapan selesai': (() => { const i = urutanSementara.lastIndexOf('berbicara'); return i >= 0 && urutanSementara[i + 1] === 'sesi'; })(),
      'pertanyaan sesudah menyela terkirim': akhir.some((l) => l.startsWith('chat:stok KSFO028|')),
    };
  },

  async 'perintah-diam-saat-bicara'(s) {
    await s.aktifkan();
    await s.set('window.__lamaBicara = 30000');
    await s.ucapkan('Hei MIRA, berapa sales hari ini');
    await s.tungguState('berbicara', 4000);
    const chatSebelum = jumlah(await s.log(), 'chat:');
    await s.ucapkan('Hei MIRA, berhenti');
    await s.tungguState('siaga', 3000);
    const log = await s.log();
    return {
      'ucapan dipotong': log.includes('cancel'),
      'kembali siaga, bukan sesi': (await s.state()) === 'siaga',
      '"berhenti" TIDAK dikirim ke MIRA sebagai pertanyaan': jumlah(log, 'chat:') === chatSebelum,
      'MIRA diam (tidak menjawab "Sama-sama")': !log.some((l) => /^bicara:Sama sama/.test(l)),
    };
  },

  async 'gema-suara-sendiri'(s) {
    await s.aktifkan();
    await s.ucapkan('Hei MIRA, berapa sales hari ini');
    await s.tungguState('sesi', 4000);
    const chatAwal = jumlah(await s.log(), 'chat:');
    const gema = 'sales hari ini sudah 15464900 rupiah dari target 83539062 rupiah';
    // Gema 1: langsung setelah MIRA selesai — ditolak oleh jendela abai keras (700 ms).
    await s.ucapkan(gema);
    await tunggu(80);
    const setelahGema1 = jumlah(await s.log(), 'chat:');
    // Gema 2: SESUDAH jendela keras habis tetapi masih di jendela gema (3,5 detik). Di sini hanya
    // penyaring kemiripan yang bisa menolaknya — skenario ini ada karena gema 1 saja tidak
    // membuktikan penyaring itu bekerja (jendela keras sudah membuangnya lebih dulu).
    await tunggu(800);
    await s.ucapkan(gema);
    await tunggu(80);
    const setelahGema2 = jumlah(await s.log(), 'chat:');
    // Pertanyaan sungguhan di jendela yang sama, memakai beberapa kata yang sama dengan jawaban
    // ("hari ini", "target"), tidak boleh ikut terbuang.
    await s.ucapkan('berapa target revenue hari ini');
    await tunggu(300);
    const akhir = await s.log();
    return {
      'gema segera setelah MIRA selesai TIDAK dikirim (jendela abai keras)': setelahGema1 === chatAwal,
      'gema yang datang belakangan TIDAK dikirim (penyaring kemiripan)': setelahGema2 === chatAwal,
      'pertanyaan sungguhan sesudahnya tetap terkirim': akhir.some((l) => l.startsWith('chat:berapa target revenue hari ini|')),
    };
  },

  async 'pendengar-menyala-ulang'(s) {
    await s.aktifkan();
    const awal = await s.eval('window.__jumlahRec');
    // Chrome menutup pengenalan suara sendiri setelah hening — pendengar harus menyala lagi.
    await s.eval('window.__galatRec("no-speech"); window.__akhiriRec()');
    await tunggu(700);
    const stlNoSpeech = await s.eval('window.__jumlahRec');
    await s.eval('window.__akhiriRec()');
    await tunggu(700);
    const stlAkhir = await s.eval('window.__jumlahRec');
    // Izin ditolak: harus berhenti total dan memberi tahu, bukan terus mencoba.
    await s.eval('window.__galatRec("not-allowed")');
    await tunggu(300);
    const jumlahSetelahDitolak = await s.eval('window.__jumlahRec');
    await tunggu(1500);
    return {
      'menyala lagi setelah "no-speech"': stlNoSpeech > awal,
      'menyala lagi setelah Chrome menutup sendiri': stlAkhir > stlNoSpeech,
      'izin ditolak: mode mati dan pesan galat tampil': (await s.eval("document.body.dataset.aktif")) === '0' && /Izin mikrofon/.test(await s.eval("document.getElementById('galat').textContent")),
      'izin ditolak: tidak mencoba menyala lagi': (await s.eval('window.__jumlahRec')) === jumlahSetelahDitolak,
    };
  },

  async 'dimatikan-benar-benar-berhenti'(s) {
    await s.aktifkan();
    await s.ucapkan('Hei MIRA, berapa sales hari ini');
    await s.tungguState('sesi', 4000);
    await s.eval("document.getElementById('tombolUtama').click()");
    await tunggu(150);
    const jumlahSaatMati = await s.eval('window.__jumlahRec');
    const logMati = await s.log();
    await tunggu(1800);                                       // jauh melewati jeda nyala-ulang
    const akhirJumlah = await s.eval('window.__jumlahRec');
    const aktif = await s.eval('document.body.dataset.aktif');
    // Sesudah dimatikan, ucapan "Hei MIRA" tidak boleh lagi diproses.
    await s.eval('window.__ucapkan("Hei MIRA, berapa piutang kita")');
    await tunggu(300);
    const log = await s.log();
    return {
      'pendengar dihentikan (rec.abort dipanggil)': logMati.includes('rec.abort'),
      'tidak menyala lagi setelah dimatikan': akhirJumlah === jumlahSaatMati,
      'status kembali nonaktif': aktif === '0',
      'ucapan setelah dimatikan tidak diproses': !log.some((l) => l.includes('berapa piutang kita')),
    };
  },

  async 'konteks-lanjutan'(s) {
    await s.aktifkan();
    await s.ucapkan('Hei MIRA, berapa sales hari ini');
    await s.tungguState('sesi', 4000);
    await s.jedaManusia();
    await s.ucapkan('kalau kemarin');                         // tanpa topik: harus dilengkapi dari pertanyaan tadi
    await s.tungguState('sesi', 4000);
    await s.jedaManusia();
    await s.ucapkan('piutang CFN');                           // punya topik sendiri: JANGAN dicampur
    await s.tungguState('sesi', 4000);
    const log = await s.log();
    return {
      '"kalau kemarin" dikirim sebagai pertanyaan lengkap': log.some((l) => l.startsWith('chat:berapa sales kemarin|')),
      'ucapan asli tidak ikut dikirim mentah': !log.some((l) => l.startsWith('chat:kalau kemarin|')),
      'layar menunjukkan "dipahami dari" ucapan asli': /dipahami dari/.test(await s.layar()) && /kalau kemarin/.test(await s.layar()),
      'pertanyaan bertopik sendiri dikirim apa adanya': log.some((l) => l.startsWith('chat:piutang CFN|')),
    };
  },

  async 'jarak-jauh-alternatif'(s) {
    await s.aktifkan();
    // Dari jauh hipotesis teratas salah dengar kata panggil; hipotesis berikutnya benar.
    await s.ucapkan('hai nira stok ksfo 028', true, ['hai mira stok ksfo 028']);
    await s.tungguState('sesi', 4000);
    const log1 = await s.log();
    await s.jedaManusia();
    await s.eval("document.getElementById('tombolUtama').click()");
    await tunggu(100);
    await s.aktifkan();
    // Obrolan: tak satu pun hipotesis memuat panggilan -> tidak boleh terkirim.
    await s.ucapkan('kita rapat jam tiga', true, ['kita rapat jam 3', 'kita rapat jam tiga ya']);
    await tunggu(100);
    const log2 = await s.log();
    return {
      'panggilan dikenali dari hipotesis ke-2 dan pertanyaan terkirim': log1.some((l) => l.startsWith('chat:stok KSFO028|')),
      'obrolan walau punya banyak hipotesis tidak terkirim': !log2.some((l) => l.includes('rapat jam')),
    };
  },

  async 'koreksi-kode-ucapan'(s) {
    await s.aktifkan();
    await s.ucapkan('Hei MIRA, stok k s f o nol dua delapan');
    await s.tungguState('sesi', 4000);
    const log = await s.log();
    return {
      'kode yang dieja sampai ke backend sebagai KSFO028': log.some((l) => l.startsWith('chat:stok KSFO028|')),
    };
  },

  async 'meter-mikrofon'(s) {
    await s.aktifkan();
    await tunggu(700);
    const teks = await s.eval("document.getElementById('meterTeks').textContent");
    const tampil = await s.eval("getComputedStyle(document.getElementById('meter')).display");
    const lebar = await s.eval("document.getElementById('meterIsi').style.width");
    await s.eval("document.getElementById('tombolUtama').click()");
    await tunggu(300);
    return {
      'meter tampil saat mode aktif': tampil !== 'none',
      'meter menunjukkan angka dB dan artinya': /-?\d+ dB · (baik|pelan|terlalu keras|hampir tidak terdengar)/.test(teks || ''),
      'batang meter terisi': parseFloat(lebar) > 0,
      'meter disetel ulang saat dimatikan': (await s.eval("document.getElementById('meterTeks').textContent")) === '—',
    };
  },

  async 'tolak-mic'(s) {
    // Izin mikrofon ditolak saat mengukur: mode harus mati dan memberi tahu, bukan diam-diam menggantung.
    await s.eval("navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))");
    await s.aktifkan();
    await tunggu(400);
    return {
      'mode mati': (await s.eval('document.body.dataset.aktif')) === '0',
      'pesan izin mikrofon tampil': /Izin mikrofon/.test(await s.eval("document.getElementById('galat').textContent")),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Mesin uji: satu Chrome, halaman dimuat ulang tiap skenario supaya keadaan benar-benar bersih.
// ---------------------------------------------------------------------------------------------
async function jalankanSemua(daftar) {
  const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-e2e-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profil}`,
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', // alat ukur suara butuh aliran mikrofon (tiruan) '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  let gagalTotal = 0;
  try {
    let targets;
    for (let i = 0; i < 40; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.some((t) => t.type === 'page')) break; } catch { /* belum siap */ }
      await tunggu(250);
    }
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const tertunda = new Map(); let konsol = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && tertunda.has(d.id)) { tertunda.get(d.id)(d); tertunda.delete(d.id); }
      if (d.method === 'Runtime.exceptionThrown') konsol.push('EXC: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    };
    const kirim = (method, params = {}) => new Promise((r) => { const i = ++id; tertunda.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (ekspresi, gesture) => {
      const r = await kirim('Runtime.evaluate', { expression: ekspresi, returnByValue: true, awaitPromise: true, userGesture: !!gesture });
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    await kirim('Runtime.enable');
    await kirim('Page.enable');
    await kirim('Page.addScriptToEvaluateOnNewDocument', { source: STUB });

    const s = {
      eval: ev,
      set: (kode) => ev(kode),
      aktifkan: async () => { await ev("document.getElementById('tombolUtama').click()", true); await tunggu(150); },
      ucapkan: async (teks, final, alternatif) => { await ev(`window.__ucapkan(${JSON.stringify(teks)}, ${final === false ? 'false' : 'true'}, ${JSON.stringify(alternatif || [])})`); await tunggu(60); },
      log: async () => (await ev('window.__log')) || [],
      state: () => ev('document.body.dataset.state'),
      layar: () => ev("document.getElementById('log').innerText"),
      dengar: () => ev("document.getElementById('sedangDengar').textContent"),
      urutan: async () => { const d = (await ev('window.__states')) || []; const o = []; for (const x of d) if (o[o.length - 1] !== x) o.push(x); return o; },
      // Orang butuh waktu untuk menjawab sesudah MIRA diam. MIRA sengaja mengabaikan ucapan tanpa
      // "Hei MIRA" selama 700 ms sesudah selesai bicara (ekor suaranya sendiri), jadi skenario yang
      // meniru pengguna harus menunggu lebih lama dari itu.
      jedaManusia: () => tunggu(900),
      tungguState: async (nama, batas) => { const t0 = Date.now(); while (Date.now() - t0 < batas) { if ((await ev('document.body.dataset.state')) === nama) return true; await tunggu(40); } return false; },
    };

    for (const nama of daftar) {
      konsol = [];
      await kirim('Page.navigate', { url: HALAMAN });
      await tunggu(1200);
      if (!(await ev("!!document.getElementById('tombolUtama')"))) { console.log(`  GAGAL  [${nama}] halaman tidak termuat`); gagalTotal++; continue; }
      let hasil;
      try { hasil = await SKENARIO[nama](s); } catch (e) { hasil = { [`skenario berjalan tanpa galat (${e.message})`]: false }; }
      if (process.env.DEBUG) { console.log('           [log]', JSON.stringify(await s.log())); console.log('           [keadaan]', (await s.urutan()).join('>')); }
      hasil['tidak ada galat skrip di halaman'] = konsol.length === 0;
      const gagal = Object.entries(hasil).filter(([, v]) => !v);
      console.log(`  ${gagal.length ? 'GAGAL ' : 'ok    '} [${nama}]`);
      for (const [k, v] of Object.entries(hasil)) if (!v || process.env.RINCI) console.log(`           ${v ? 'ok  ' : 'GAGAL'}  ${k}`);
      if (gagal.length) { gagalTotal++; if (konsol.length) console.log('           galat konsol: ' + JSON.stringify(konsol.slice(0, 3))); }
    }
    ws.close();
  } finally {
    try { chrome.kill(); } catch { /* sudah mati */ }
    try { execSync('taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq about:blank*"', { stdio: 'ignore' }); } catch { /* tidak ada */ }
  }
  return gagalTotal;
}

(async () => {
  if (!CHROME) { console.log('Chrome tidak ditemukan. Atur CHROME_PATH ke chrome.exe.'); process.exit(1); }
  const pilih = process.argv[2];
  const daftar = pilih ? [pilih] : Object.keys(SKENARIO);
  if (pilih && !SKENARIO[pilih]) { console.log('Skenario tidak dikenal. Pilihan: ' + Object.keys(SKENARIO).join(', ')); process.exit(1); }
  const gagal = await jalankanSemua(daftar);
  console.log(`\n${'='.repeat(52)}\nskenario lulus: ${daftar.length - gagal}/${daftar.length}`);
  process.exit(gagal ? 1 : 0);
})();
