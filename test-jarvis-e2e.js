#!/usr/bin/env node
/**
 * Uji ujung-ke-ujung mode Jarvis di Chrome sungguhan.
 *
 * Yang SUNGGUHAN: AudioWorklet, getUserMedia, pendeteksi tepuk, mesin keadaan, dan DOM. Mikrofon
 * diganti berkas WAV tiruan (derau ruangan + tepukan) yang diputar berulang oleh Chrome.
 * Yang DIGANTI STUB: SpeechRecognition dan speechSynthesis (butuh layanan Google dan speaker) serta
 * /chat (supaya tidak memakai kuota dan tidak butuh kode akses asli).
 *
 * Enam skenario, termasuk dua yang menjaga privasi: tanpa tepuk ganda, pengenal suara TIDAK PERNAH
 * dinyalakan, dan ucapan tanpa "Hai MIRA" TIDAK PERNAH sampai ke MIRA.
 *
 * Butuh Google Chrome terpasang (atau atur CHROME_PATH).
 * RUN:  node test-jarvis-e2e.js            (semua skenario)
 *       node test-jarvis-e2e.js menyela    (satu skenario)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execSync } = require('child_process');
const { pathToFileURL } = require('url');

const D = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-e2e-'));
const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && fs.existsSync(p));
// HALAMAN bisa diarahkan ke alamat sungguhan (mis. GitHub Pages) untuk menguji jalur https/blob:.
const HALAMAN = process.env.HALAMAN || pathToFileURL(path.join(__dirname, 'jarvis.html')).href;
const PORT = 9333;
const SEMUA = ['tepuk', 'tanpa-tepuk', 'satu-tepuk', 'tanpa-panggil', 'hanya-dipanggil', 'menyela'];
const MODE = process.argv[2] || 'semua';

// Tanpa argumen: jalankan semua skenario berurutan, satu proses Chrome tiap skenario.
if (MODE === 'semua') {
  if (!CHROME) { console.log('Chrome tidak ditemukan. Atur CHROME_PATH ke chrome.exe.'); process.exit(1); }
  let gagal = 0;
  for (const m of SEMUA) {
    const r = spawnSync(process.execPath, [__filename, m], { encoding: 'utf8', timeout: 120000 });
    const ringkas = (r.stdout || '').split('\n').filter((l) => /LULUS|GAGAL|galat harness/.test(l) && /^\[/.test(l)).join(' | ');
    console.log(r.status === 0 ? '  ok     ' + (ringkas || m) : '  GAGAL  ' + (ringkas || m + ' (tanpa keluaran — jalankan: node test-jarvis-e2e.js ' + m + ')'));
    if (r.status !== 0) gagal++;
  }
  console.log('\n' + '='.repeat(52) + '\nskenario lulus: ' + (SEMUA.length - gagal) + '/' + SEMUA.length);
  process.exit(gagal ? 1 : 0);
}

// ---- bangun WAV 16-bit mono 48 kHz ----
const SR = 48000;
let benih = 99;
const acak = () => { benih = (benih * 1664525 + 1013904223) >>> 0; return benih / 4294967296 * 2 - 1; };
function bangunWav(klik) {
  const total = Math.round(SR * 5);
  const x = new Float32Array(total);
  for (let i = 0; i < total; i++) x[i] = acak() * 0.01;
  for (const t0 of klik) {
    const o = Math.round(t0 * SR);
    for (let i = 0; i < SR * 0.12 && o + i < total; i++) x[o + i] += 0.6 * Math.exp(-i / (SR * 0.015)) * acak();
  }
  const buf = Buffer.alloc(44 + total * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + total * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(total * 2, 40);
  for (let i = 0; i < total; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  return buf;
}
const klik = ['tepuk', 'tanpa-panggil', 'hanya-dipanggil', 'menyela'].includes(MODE) ? [1.5, 1.8] : MODE === 'satu-tepuk' ? [1.5] : [];
const TRANSKRIP = { 'tanpa-panggil': 'berapa sales hari ini', 'hanya-dipanggil': 'Hai MIRA' }[MODE] || 'Hai MIRA, berapa sales hari ini';
const wav = path.join(D, `mic-${MODE}.wav`);
fs.writeFileSync(wav, bangunWav(klik));

const STUB = `
  localStorage.setItem('miraAccessCode', 'TES');
  window.__log = [];
  window.__states = [];
  // Merekam SETIAP perpindahan keadaan di dalam halaman. Polling dari luar melewatkan keadaan yang
  // berlangsung sesaat (mis. "berpikir" saat balasan stub datang seketika).
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(() => window.__states.push(document.body.dataset.state))
      .observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
  });
  window.__recCall = 0;
  class FakeRec {
    start() {
      window.__log.push('rec.start');
      const self = this; const n = ++window.__recCall;
      setTimeout(() => {
        if (n === 1 && self.onresult) self.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: ${JSON.stringify(TRANSKRIP)} }], { isFinal: true })] });
        if (self.onend) self.onend();
      }, 300);
    }
    stop() {} abort() {}
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = FakeRec;
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    cancel() { window.__log.push('cancel'); const u = window.__sedang; window.__sedang = null; if (u && u.onerror) setTimeout(() => u.onerror(), 0); }, getVoices() { return []; }, onvoiceschanged: null,
    speak(u) { window.__log.push('bicara:' + String(u.text).slice(0, 40)); window.__sedang = u; setTimeout(() => { if (window.__sedang === u) { window.__sedang = null; if (u.onend) u.onend(); } }, ${MODE === 'menyela' ? 30000 : 40}); },
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

const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profil = path.join(D, 'profil-chrome-' + MODE);
  fs.rmSync(profil, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profil}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`,
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  let hasil = 1;
  try {
    let targets;
    for (let i = 0; i < 40; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.some((t) => t.type === 'page')) break; } catch { /* belum siap */ }
      await tunggu(250);
    }
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const tertunda = new Map(); const konsol = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && tertunda.has(d.id)) { tertunda.get(d.id)(d); tertunda.delete(d.id); }
      if (d.method === 'Runtime.exceptionThrown') konsol.push('EXC: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') konsol.push('ERR: ' + d.params.args.map((a) => a.value || a.description).join(' '));
    };
    const kirim = (method, params = {}) => new Promise((r) => { const i = ++id; tertunda.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (ekspresi, gesture) => {
      const r = await kirim('Runtime.evaluate', { expression: ekspresi, returnByValue: true, awaitPromise: true, userGesture: !!gesture });
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    await kirim('Runtime.enable');
    await kirim('Page.enable');
    await kirim('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
    await kirim('Page.navigate', { url: HALAMAN });
    await tunggu(1500);

    const ada = await evalJs("!!document.getElementById('tombolUtama')");
    if (!ada) { console.log('halaman tidak termuat'); return; }
    console.log(`[${MODE}] klik "Aktifkan mode Jarvis"…`);
    await evalJs("document.getElementById('tombolUtama').click()", true);

    const urutan = []; let terakhir = '';
    const mulai = Date.now();
    while (Date.now() - mulai < 14000) {
      const s = await evalJs("document.body.dataset.state + '|' + document.getElementById('statusRinci').textContent + '|' + (document.getElementById('galat').textContent||'')");
      const state = (s || '').split('|')[0];
      if (state && state !== terakhir) { urutan.push(state); terakhir = state; console.log(`  +${((Date.now() - mulai) / 1000).toFixed(1)}s  ${s}`); }
      await tunggu(60);
    }
    const diag = await evalJs("JSON.stringify({perluLogin: document.body.dataset.perluLogin, galat: document.getElementById('galat').textContent, kode: localStorage.getItem('miraAccessCode'), mediaDevices: typeof navigator.mediaDevices, worklet: typeof AudioWorkletNode, aman: window.isSecureContext, tombol: document.getElementById('tombolUtama').textContent, disabled: document.getElementById('tombolUtama').disabled})");
    console.log('[diag] ' + diag);
    const log = await evalJs('window.__log');
    const aktif = await evalJs("document.body.dataset.aktif");
    const logHalaman = await evalJs("document.getElementById('log').innerText");
    // Urutan keadaan yang sebenarnya, direkam di dalam halaman (bukan hasil polling).
    const direkam = (await evalJs('window.__states')) || [];
    urutan.length = 0;
    for (const s of direkam) if (urutan[urutan.length - 1] !== s) urutan.push(s);
    console.log(`[${MODE}] urutan keadaan: ${urutan.join(' -> ')}`);
    console.log(`[${MODE}] log stub: ${JSON.stringify(log)}`);
    if (logHalaman) console.log(`[${MODE}] percakapan di layar:\n${logHalaman.split('\n').map((l) => '     ' + l).join('\n')}`);
    if (konsol.length) console.log(`[${MODE}] galat konsol: ${JSON.stringify(konsol.slice(0, 5))}`);

    const dilewati = (s) => urutan.includes(s);
    // Urutan harus muncul BERURUTAN (boleh diselingi), bukan sekadar semuanya pernah muncul.
    const berurutan = (daftar) => { let i = 0; for (const s of urutan) if (s === daftar[i]) i++; return i === daftar.length; };
    if (MODE === 'tepuk') {
      const dibacakan = (log || []).filter((l) => l.startsWith('bicara:')).join(' ');
      const cek = {
        'urutan siaga>mendengar>berpikir>berbicara>sesi>siaga': berurutan(['siaga', 'mendengar', 'berpikir', 'berbicara', 'sesi', 'siaga']),
        'pertanyaan terkirim tanpa kata "Hai MIRA"': (log || []).some((l) => l.startsWith('chat:berapa sales hari ini|kode=')),
        'angka ikut dibacakan': /15464900/.test(dibacakan),
        'sapaan pembuka TIDAK dibacakan': !/halo|selamat siang/i.test(dibacakan),
        'doa penutup TIDAK dibacakan': !/semoga/i.test(dibacakan),
        'tidak ada galat skrip': konsol.length === 0,
      };
      for (const [k, v] of Object.entries(cek)) console.log(`     ${v ? 'ok    ' : 'GAGAL '} ${k}`);
      const ok = Object.values(cek).every(Boolean);
      console.log(ok ? `[${MODE}] LULUS — tepuk ganda -> Hai MIRA -> jawaban ringkas -> sesi lanjutan -> kembali siaga` : `[${MODE}] GAGAL`);
      hasil = ok ? 0 : 1;
    } else if (MODE === 'tanpa-panggil') {
      // Tepuk ganda membuka telinga, tapi ucapan tanpa "Hai MIRA" tidak boleh sampai ke MIRA.
      const cek = {
        'masuk keadaan mendengar setelah tepuk ganda': dilewati('mendengar'),
        'ucapan tanpa "Hai MIRA" TIDAK dikirim ke MIRA': !(log || []).some((l) => l.startsWith('chat:')),
        'tidak pernah masuk berpikir/berbicara': !dilewati('berpikir') && !dilewati('berbicara'),
        'kembali siaga': urutan[urutan.length - 1] === 'siaga' || berurutan(['mendengar', 'siaga']),
        'tidak ada galat skrip': konsol.length === 0,
      };
      for (const [k, v] of Object.entries(cek)) console.log(`     ${v ? 'ok    ' : 'GAGAL '} ${k}`);
      const ok = Object.values(cek).every(Boolean);
      console.log(ok ? `[${MODE}] LULUS — ucapan yang tidak memanggil MIRA diabaikan` : `[${MODE}] GAGAL`);
      hasil = ok ? 0 : 1;
    } else if (MODE === 'hanya-dipanggil') {
      const cek = {
        'dijawab "Ya, saya dengar." tanpa memanggil MIRA/Gemini': (log || []).some((l) => /^bicara:Ya saya dengar/i.test(l)) && !(log || []).some((l) => l.startsWith('chat:')),
        'lalu mendengarkan lagi untuk pertanyaannya': berurutan(['mendengar', 'berbicara', 'sesi']),
        'tidak ada galat skrip': konsol.length === 0,
      };
      for (const [k, v] of Object.entries(cek)) console.log(`     ${v ? 'ok    ' : 'GAGAL '} ${k}`);
      const ok = Object.values(cek).every(Boolean);
      console.log(ok ? `[${MODE}] LULUS — dipanggil saja dijawab, lalu menunggu pertanyaan` : `[${MODE}] GAGAL`);
      hasil = ok ? 0 : 1;
    } else if (MODE === 'menyela') {
      // MIRA "berbicara" selama 30 detik; tepuk ganda berikutnya (putaran rekaman ke-2) harus
      // memotongnya dan langsung mendengarkan, tanpa perlu menyebut "Hai MIRA" lagi.
      const rincianMenyela = await evalJs("(window.__states || []).join('>')");
      const cek = {
        'sempat berbicara': dilewati('berbicara'),
        'ucapan dipotong (speechSynthesis.cancel dipanggil setelah mulai bicara)': (log || []).lastIndexOf('cancel') > (log || []).findIndex((l) => l.startsWith('bicara:')),
        'setelah berbicara langsung mendengarkan (menyela), bukan sesi lanjutan biasa': (() => { const i = urutan.indexOf('berbicara'); return i >= 0 && urutan[i + 1] === 'mendengar'; })(),
        'rec dinyalakan lagi tanpa harus menyebut "Hai MIRA"': (log || []).filter((l) => l === 'rec.start').length >= 2,
        'tidak ada galat skrip': konsol.length === 0,
      };
      console.log(`     (keadaan terekam: ${rincianMenyela})`);
      for (const [k, v] of Object.entries(cek)) console.log(`     ${v ? 'ok    ' : 'GAGAL '} ${k}`);
      const ok = Object.values(cek).every(Boolean);
      console.log(ok ? `[${MODE}] LULUS — tepuk ganda saat MIRA bicara memotongnya dan langsung mendengarkan` : `[${MODE}] GAGAL`);
      hasil = ok ? 0 : 1;
    } else {
      const ok = dilewati('siaga') && !dilewati('mendengar') && !(log || []).some((l) => l.startsWith('rec.start'));
      console.log(ok ? `[${MODE}] LULUS — tetap siaga, pengenal suara tidak pernah dinyalakan` : `[${MODE}] GAGAL`);
      hasil = ok ? 0 : 1;
    }
    ws.close();
  } catch (e) {
    console.log('galat harness:', e.message);
  } finally {
    try { chrome.kill(); } catch { /* sudah mati */ }
    try { execSync('taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq about:blank*"', { stdio: 'ignore' }); } catch { /* tidak ada */ }
    process.exit(hasil);
  }
})();
