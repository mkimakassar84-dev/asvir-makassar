#!/usr/bin/env node
/**
 * Menyalin aturan PENGUCAPAN dari index.html ke jarvis.html.
 *
 * Kenapa disalin dan bukan dipakai bersama: index.html adalah MIRA di HP seluruh personel dan
 * sengaja tidak boleh disentuh oleh pekerjaan mode Jarvis. Jadi aturan pengucapan (kode barang
 * dieja, "Rp" jadi "Rupiah", nama customer dibaca sebagai nama, dst.) disalin SATU ARAH — dibaca
 * dari index.html, ditulis ke jarvis.html. index.html tidak pernah ditulis oleh skrip ini.
 *
 * RUN:  node sinkron-tts-jarvis.js
 * test-jarvis.js gagal bila salinan ini tertinggal dari index.html; jalankan skrip ini lagi.
 */
const fs = require('fs');
const path = require('path');

const AWAL = '  const SPEECH_WORD_OVERRIDES = [';
const AKHIR = '  function speak(text) {';
const TANDA_MULAI = '  // ==== TTS-SALINAN-MULAI';
const TANDA_SELESAI = '  // ==== TTS-SALINAN-SELESAI ====';

function ambilBlok(html) {
  const a = html.indexOf(AWAL);
  const b = html.indexOf(AKHIR);
  if (a < 0 || b < 0 || b < a) throw new Error('Batas blok pengucapan tidak ditemukan di index.html — tata letaknya berubah, perbarui skrip ini.');
  // Akhir baris diseragamkan ke LF: index.html berakhir CRLF di Windows (git autocrlf) sedangkan
  // jarvis.html LF. Isinya sama, jadi perbedaan itu tidak boleh dihitung sebagai "tertinggal".
  return html.slice(a, b).replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
}

if (require.main === module) {
  const index = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const jarvisPath = path.join(__dirname, 'jarvis.html');
  const jarvis = fs.readFileSync(jarvisPath, 'utf8');
  const blok = ambilBlok(index);
  const i = jarvis.indexOf(TANDA_MULAI);
  const j = jarvis.indexOf(TANDA_SELESAI);
  if (i < 0 || j < 0) throw new Error('Penanda salinan tidak ada di jarvis.html.');
  const akhirBarisMulai = jarvis.indexOf('\n', i) + 1;
  const baru = jarvis.slice(0, akhirBarisMulai) + blok + jarvis.slice(j);
  if (baru === jarvis) console.log('Sudah sinkron — tidak ada yang berubah.');
  else { fs.writeFileSync(jarvisPath, baru); console.log('jarvis.html diperbarui dari index.html (' + blok.split('\n').length + ' baris).'); }
}

module.exports = { ambilBlok, AWAL, AKHIR, TANDA_MULAI, TANDA_SELESAI };
