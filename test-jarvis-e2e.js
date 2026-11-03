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
 * Delapan belas skenario, termasuk yang menjaga keamanan: obrolan kantor tanpa "Hei MIRA" tidak pernah
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
      if (!window.__bicaraPertama) window.__bicaraPertama = performance.now();
      window.__log.push('bicara:' + String(u.text));// teks SESUDAH aturan pengucapan: tanda baca sudah dibuang ("Sama sama", bukan "Sama-sama")
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
      // Jawaban yang MENGALIR sepotong-sepotong dengan jeda (potongannya sengaja memotong angka di
      // tengah), seperti backend sungguhan. "lambat" memperpanjang jeda supaya sempat disela.
      if (/bertahap/.test(b.message)) {
        const jeda = /lambat/.test(b.message) ? 900 : 350;
        const potongan = ['Halo Pak Rifqi! Senang sekali bisa ngobrol lagi sore ini. ', 'Sales hari ini sudah **Rp17.8', '13.500** dari 8 invoice unik. ', 'Stok kabel masih aman, ',
          'ada 138 unit. Target bulan ini Rp83.539.062 ', 'dan baru tercapai 20%. Semoga penjualan makin ramai ya, Pak. ', 'Kabari kalau butuh rinciannya.'];
        window.__bicaraPertama = 0; window.__alirTutup = 0;
        return Promise.resolve(new Response(new ReadableStream({ async start(c) {
          for (const p of potongan) {
            c.enqueue(enc.encode('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: p }] } }] }) + '\\n\\n'));
            await new Promise((r) => setTimeout(r, jeda));
          }
          window.__alirTutup = performance.now();
          c.close();
        } }), { status: 200 }));
      }
      // Jawaban yang menyebut nama MIRA sendiri: bahan uji gema suara yang memuat kata panggil.
      const isi = /siapa kamu/.test(b.message)
        ? 'Saya MIRA, asisten cabang Makassar yang membantu memantau sales dan piutang setiap hari.'
        : 'Halo Pak Rifqi, selamat siang! Sales hari ini sudah Rp15.464.900 dari target Rp83.539.062. Semoga hari Bapak lancar ya.';
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
    await s.tungguSelesai(1);
    const dibacakan = (await s.log()).filter((l) => l.startsWith('bicara:')).join(' ');
    await s.jedaManusia();
    await s.ucapkan('terima kasih mira');                     // penutup pun harus menyebut nama
    await s.tungguState('siaga', 4000);
    await tunggu(150);
    const log = await s.log(); const urutan = await s.urutan();
    return {
      'urutan siaga>berpikir>berbicara>siaga (tanpa sesi menunggu)': berurutan(urutan, ['siaga', 'berpikir', 'berbicara', 'siaga']) && !urutan.includes('sesi'),
      'pertanyaan terkirim TANPA kata "MIRA" di dalamnya': log.some((l) => l.startsWith('chat:berapa sales hari ini|kode=TES')),
      'angka ikut dibacakan': /15464900/.test(dibacakan),
      'sapaan pembuka TIDAK dibacakan': !/halo|selamat siang/i.test(dibacakan),
      'doa penutup TIDAK dibacakan': !/semoga/i.test(dibacakan),
      'penutup dijawab "Sama-sama" dan kembali siaga': log.some((l) => /^bicara:Sama sama/.test(l)),
      'jawaban tampil di layar': /15\.464\.900/.test(await s.layar()),
      'riwayat mencatat ucapan yang diteruskan': /diteruskan/.test(await s.eval("document.getElementById('daftarDengar').textContent")),
    };
  },

  async 'jawaban-mengalir'(s) {
    // Inti keluhan "kurang responsif": MIRA harus mulai bicara SEBELUM jawaban selesai mengalir.
    await s.aktifkan();
    await s.ucapkan('MIRA, berapa sales hari ini bertahap');
    await s.tungguSelesai(1, 9000);
    const log = await s.log();
    const bicara = log.filter((l) => l.startsWith('bicara:')).map((l) => l.slice(7)).join(' ');
    const mulai = await s.eval('window.__bicaraPertama');
    const tutup = await s.eval('window.__alirTutup');
    const urutan = await s.urutan();
    return {
      'mulai bicara SEBELUM jawaban selesai mengalir': mulai > 0 && tutup > 0 && mulai < tutup - 400,
      'angka utuh dibacakan sekali (tidak terpotong di tengah)': (bicara.match(/17813500/g) || []).length === 1 && !/ Rp17 | 17 Rupiah/.test(bicara),
      'kalimat berisi dibacakan semua': /138/.test(bicara) && /83539062/.test(bicara) && /invoice unik/.test(bicara),
      'sapaan pembuka TIDAK dibacakan': !/Halo|Senang sekali/i.test(bicara),
      'doa dan ajakan penutup TIDAK dibacakan': !/Semoga|Kabari/i.test(bicara),
      'urutan siaga>berpikir>berbicara>siaga': berurutan(urutan, ['siaga', 'berpikir', 'berbicara', 'siaga']) && !urutan.includes('sesi'),
      'jawaban lengkap tampil di layar': /17\.813\.500/.test(await s.layar()) && /Kabari/.test(await s.layar()),
    };
  },

  async 'menyela-saat-mengalir'(s) {
    // MIRA sedang membacakan bagian awal, sisanya masih mengalir. "MIRA, berhenti" harus menghentikan
    // semuanya — bagian yang tiba sesudahnya tidak boleh diucapkan lagi.
    await s.aktifkan();
    await s.set('window.__lamaBicara = 300');
    await s.ucapkan('MIRA, berapa sales hari ini bertahap lambat');
    await s.tungguState('berbicara', 6000);
    await tunggu(100);
    await s.ucapkan('MIRA, berhenti');
    await s.tungguState('siaga', 3000);
    const sebelum = (await s.log()).filter((l) => l.startsWith('bicara:')).length;
    await tunggu(7000);                                       // sisa aliran tiba sesudah dihentikan
    const log = await s.log();
    return {
      'ucapan dipotong': log.includes('cancel'),
      'kembali siaga': (await s.state()) === 'siaga',
      'sisa jawaban yang tiba sesudahnya TIDAK diucapkan': log.filter((l) => l.startsWith('bicara:')).length === sebelum,
      'sisa jawaban tetap tampil di layar': /Kabari/.test(await s.layar()),
      '"berhenti" tidak dikirim sebagai pertanyaan': jumlah(log, 'chat:') === 1,
    };
  },

  async 'pertanyaan-baru-saat-mengalir'(s) {
    // Disela dengan PERTANYAAN BARU selagi jawaban lama masih mengalir: jawaban lama dilepas, yang
    // dibacakan hanyalah jawaban pertanyaan baru.
    await s.aktifkan();
    await s.set('window.__lamaBicara = 300');
    await s.ucapkan('MIRA, berapa sales hari ini bertahap lambat');
    await s.tungguState('berbicara', 6000);
    await tunggu(100);
    await s.ucapkan('MIRA, target hari ini');
    await s.tungguSelesai(2, 9000);
    await tunggu(6000);                                       // sisa aliran lama tiba
    const log = await s.log();
    const bicara = log.filter((l) => l.startsWith('bicara:')).map((l) => l.slice(7));
    const sesudahBatal = bicara.join(' ');
    return {
      'pertanyaan baru terkirim': log.some((l) => l.startsWith('chat:target hari ini|')),
      'jawaban pertanyaan baru dibacakan': /15464900/.test(sesudahBatal),
      'sisa jawaban LAMA tidak pernah diucapkan': !/138|Stok kabel/.test(sesudahBatal),
      'berakhir siaga': (await s.state()) === 'siaga',
    };
  },

  async 'nama-di-mana-saja'(s) {
    await s.aktifkan();
    const kalimat = ['Mira berapa sales hari ini', 'stok KSFO028 berapa mira', 'tolong mirah cek target hari ini'];
    for (const k of kalimat) {
      await s.ucapkan(k);
      await s.tungguSelesai(kalimat.indexOf(k) + 1);
      await s.jedaManusia();
    }
    const log = await s.log();
    return {
      '"Mira ..." tanpa sapaan dijawab': log.some((l) => l.startsWith('chat:berapa sales hari ini|')),
      '"... mira" di akhir dijawab, nama tidak ikut terkirim': log.some((l) => l.startsWith('chat:stok KSFO028 berapa|')),
      '"... mirah ..." di tengah dijawab, nama tidak ikut terkirim': log.some((l) => l.startsWith('chat:tolong cek target hari ini|')),
    };
  },

  async 'obrolan-setelah-jawaban'(s) {
    // Inti permintaan: sesudah MIRA menjawab, orang di sekitar terus ngobrol. Tak satu pun boleh terkirim.
    await s.aktifkan();
    await s.ucapkan('Hei MIRA, berapa sales hari ini');
    await s.tungguSelesai(1);
    await s.jedaManusia();
    const chatAwal = jumlah(await s.log(), 'chat:');
    for (const k of ['kalau kemarin', 'nanti sore jadi rapat ya', 'tolong siapkan laporan piutang', 'terima kasih', 'stok KSFO028 berapa']) {
      await s.ucapkan(k);
      await tunggu(100);
    }
    const log = await s.log();
    await s.ucapkan('stok KSFO028 berapa mira');
    await s.tungguSelesai(2);
    return {
      'obrolan sesudah jawaban TIDAK terkirim (walau berbau pertanyaan)': jumlah(log, 'chat:') === chatAwal,
      'MIRA tidak menyahut "terima kasih" yang tanpa nama': !log.some((l) => /^bicara:Sama sama/.test(l)),
      'tetap siaga': (await s.urutan()).slice(-1)[0] === 'siaga',
      'pertanyaan yang menyebut MIRA tetap terjawab': (await s.log()).some((l) => l.startsWith('chat:stok KSFO028 berapa|')),
    };
  },

  async 'gema-menyebut-nama'(s) {
    // Jawaban MIRA memuat namanya sendiri, dan speaker masuk lagi ke mikrofon. Gema itu bukan panggilan.
    await s.aktifkan();
    await s.set('window.__lamaBicara = 600');
    await s.ucapkan('MIRA siapa kamu');
    await s.tungguState('berbicara', 4000);
    const chatAwal = jumlah(await s.log(), 'chat:');
    const batalAwal = jumlah(await s.log(), 'cancel');
    const gema = 'saya mira asisten cabang makassar yang membantu memantau sales dan piutang setiap hari';
    await s.ucapkan('saya mira', false);                      // gema sementara selagi MIRA bicara
    await s.ucapkan(gema);                                    // gema final selagi MIRA bicara
    await tunggu(100);
    const selamaBicara = await s.log();
    const masihBicara = (await s.state()) === 'berbicara';
    await s.tungguState('siaga', 4000);
    await tunggu(900);                                        // lewat jendela abai keras (700 ms)
    await s.ucapkan(gema);                                    // gema yang datang terlambat
    await tunggu(100);
    const sesudah = await s.log();
    await s.ucapkan('mira berapa sales hari ini');            // pertanyaan sungguhan di jendela yang sama
    await s.tungguSelesai(2);
    const akhir = await s.log();
    return {
      'gema yang menyebut nama TIDAK memotong ucapan MIRA': jumlah(selamaBicara, 'cancel') === batalAwal && masihBicara,
      'gema selagi bicara TIDAK terkirim': jumlah(selamaBicara, 'chat:') === chatAwal,
      'gema terlambat yang menyebut nama TIDAK terkirim': jumlah(sesudah, 'chat:') === chatAwal,
      'pertanyaan sungguhan sesudahnya tetap terkirim': akhir.some((l) => l.startsWith('chat:berapa sales hari ini|')),
    };
  },

  async 'abaikan-obrolan-kantor'(s) {
    await s.aktifkan();
    // Termasuk nama-nama yang mirip tapi BUKAN MIRA: Mia, Mila, Samira, Miranda.
    for (const kalimat of ['berapa sales hari ini', 'Mia berapa sales hari ini', 'tolong siapkan laporan piutang', 'Mila sudah datang belum', 'Samira minta data piutang', 'hai semuanya selamat pagi', 'hai Miranda minta stok']) {
      await s.ucapkan(kalimat);
      await tunggu(80);
    }
    const log = await s.log(); const urutan = await s.urutan();
    return {
      'tidak satu pun obrolan dikirim ke MIRA': jumlah(log, 'chat:') === 0,
      'MIRA tidak berbicara': jumlah(log, 'bicara:') === 0,
      'tetap siaga sepanjang waktu': urutan.every((x) => x === 'siaga'),
      'ucapan yang diabaikan ditandai di layar': /diabaikan/.test(await s.dengar()),
      'riwayat pendengaran mencatat SEMUA ucapan beserta alasannya': (await s.eval("document.querySelectorAll('#daftarDengar .dengar-baris').length")) === 7 && /tidak ada kata MIRA/.test(await s.eval("document.getElementById('daftarDengar').textContent")),
    };
  },

  async 'hanya-dipanggil'(s) {
    await s.aktifkan();
    await s.ucapkan('Hei MIRA');
    await s.tungguState('sesi', 3000);
    const log1 = await s.log();
    // Ekor suara "Ya, saya dengar." sendiri tertangkap mikrofon: jangan dianggap pertanyaan.
    await s.ucapkan('ya saya dengar');
    await tunggu(80);
    const sesudahGema = jumlah(await s.log(), 'chat:');
    await s.jedaManusia();
    await s.ucapkan('target hari ini');                       // satu ucapan tepat sesudah dipanggil boleh tanpa nama
    await s.tungguSelesai(1);
    await s.jedaManusia();
    const chat1 = jumlah(await s.log(), 'chat:');
    await s.ucapkan('dan stok KSFO028 juga');                 // ucapan KEDUA tanpa nama: harus diabaikan
    await tunggu(150);
    const log2 = await s.log(); const urutan = await s.urutan();
    return {
      'dijawab "Ya, saya dengar." tanpa memanggil MIRA': log1.some((l) => /^bicara:Ya saya dengar/.test(l)) && jumlah(log1, 'chat:') === 0,
      'lalu menunggu pertanyaan (sesi)': berurutan(urutan, ['siaga', 'berbicara', 'sesi']),
      'gema suara sendiri tepat sesudahnya tidak dianggap pertanyaan': sesudahGema === 0,
      'satu ucapan sesudah dipanggil sendirian diterima tanpa nama': log2.some((l) => l.startsWith('chat:target hari ini|')),
      'ucapan kedua tanpa nama TIDAK diterima': jumlah(log2, 'chat:') === chat1 && !log2.some((l) => l.includes('KSFO028')),
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
    // Keadaan menyela terbuka, tetapi yang menyusul adalah obrolan tanpa nama: tidak boleh terkirim.
    const chatSebelumObrolan = jumlah(sesudah, 'chat:');
    await tunggu(900); // lewat jendela abai keras, supaya yang diuji penjaga nama, bukan jendela itu
    await s.ucapkan('nanti sore jadi rapat ya');
    await tunggu(100);
    const tanpaObrolan = jumlah(await s.log(), 'chat:') === chatSebelumObrolan;
    await s.ucapkan('Hei MIRA, stok KSFO028');
    await tunggu(300);
    const akhir = await s.log();
    return {
      'sempat berbicara': urutanSementara.includes('berbicara'),
      'ucapan dipotong begitu "Hei MIRA" terdengar (belum menunggu final)': sesudah.lastIndexOf('cancel') > sebelum.lastIndexOf('cancel'),
      'langsung masuk sesi (menyela), bukan menunggu ucapan selesai': (() => { const i = urutanSementara.lastIndexOf('berbicara'); return i >= 0 && urutanSementara[i + 1] === 'sesi'; })(),
      'obrolan tanpa nama sesudah menyela TIDAK terkirim': tanpaObrolan,
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
    await s.tungguSelesai(1);
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
    await s.tungguSelesai(1);
    await s.jedaManusia();
    await s.ucapkan('mira kalau kemarin');                    // tanpa topik: harus dilengkapi dari pertanyaan tadi
    await s.tungguSelesai(2);
    await s.jedaManusia();
    await s.ucapkan('mira piutang CFN');                      // punya topik sendiri: JANGAN dicampur
    await s.tungguSelesai(3);
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
    await s.tungguSelesai(1);
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
    await s.tungguSelesai(1);
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
      // Menunggu sampai `n` pertanyaan sudah terkirim, dijawab dengan suara, dan MIRA kembali siaga.
      tungguSelesai: async (n, batas = 5000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < batas) {
          const log = (await ev('window.__log')) || [];
          const idx = []; log.forEach((l, i) => { if (l.startsWith('chat:')) idx.push(i); });
          if (idx.length >= n && log.slice(idx[n - 1]).some((l) => l.startsWith('bicara:')) && (await ev('document.body.dataset.state')) === 'siaga') return true;
          await tunggu(40);
        }
        return false;
      },
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
