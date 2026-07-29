# MIRA (Makassar Intelligent Response Assistant)

PWA chat AI (Gemini) untuk cabang Makassar — performa cabang, piutang, KPI personel, dan stok produk. 100% gratis (Cloudflare Workers + KV free tier, hosting statis gratis).

> **Status: Backend sudah live** — `https://asvir-makassar.mkimakassar84.workers.dev` (KV, secrets, dan sync sudah dikonfigurasi). `index.html` sudah menunjuk ke URL ini. Yang tersisa: deploy frontend (langkah 2 di bawah).

## Struktur File
- `worker.js` — Backend Cloudflare Worker (`/chat`, `/sync`, `/status`)
- `wrangler.toml` — Konfigurasi Worker
- `index.html` — Frontend chat UI (Tailwind CDN + vanilla JS, streaming SSE)
- `manifest.json`, `sw.js`, `icon-192.svg`, `icon-512.svg` — PWA

## 1. Deploy Backend (Cloudflare Worker) — Gratis

```bash
npm install -g wrangler
wrangler login
```

Buat KV namespace, lalu tempel `id` yang muncul ke `wrangler.toml` (ganti `REPLACE_WITH_KV_NAMESPACE_ID`):
```bash
wrangler kv namespace create SHEET_CACHE
```

Set 2 secret (jangan pernah ditulis langsung di kode):
```bash
wrangler secret put GEMINI_API_KEY
wrangler secret put SYNC_TOKEN
```
- `GEMINI_API_KEY`: ambil gratis di https://aistudio.google.com/apikey
- `SYNC_TOKEN`: bikin sendiri, string acak apa saja (mis. `hasil dari` `openssl rand -hex 16`), dipakai untuk mengunci endpoint `/sync` agar tidak bisa dipicu orang lain.

Deploy:
```bash
wrangler deploy
```
Catat URL yang muncul, contoh: `https://asvir-makassar.NAMA-ANDA.workers.dev`

Jalankan sync pertama kali (isi KV dengan data sheet):
```
https://asvir-makassar.NAMA-ANDA.workers.dev/sync?token=ISI_SYNC_TOKEN_ANDA
```
Buka URL itu di browser — kalau berhasil akan muncul JSON ringkasan data yang tersimpan.

**Jadwalkan sync otomatis (opsional tapi disarankan):** tambahkan Cron Trigger di dashboard Cloudflare (Workers → asvir-makassar → Triggers → Cron Triggers) yang memanggil worker secara berkala, atau pakai layanan ping gratis (mis. cron-job.org) untuk hit URL `/sync?token=...` tiap beberapa jam.

## 2. Deploy Frontend (GitHub Pages — Gratis)

1. Buka [index.html](index.html), ganti baris:
   ```js
   const API_BASE = 'https://asvir-makassar.<SUBDOMAIN-ANDA>.workers.dev';
   ```
   dengan URL Worker asli dari langkah 1.
2. Push folder ini ke repo GitHub baru (atau upload lewat GitHub web "Add file → Upload files").
3. Repo → Settings → Pages → Source: `Deploy from branch`, branch `main`, folder `/root` → Save.
4. Tunggu ~1 menit, situs akan live di `https://USERNAME.github.io/NAMA-REPO/`.

**Alternatif Vercel:** import repo di vercel.com, tanpa build command (proyek ini statis), deploy otomatis.

## 3. Hubungkan CORS

Setelah frontend online, set `ALLOWED_ORIGIN` di `wrangler.toml` ke domain frontend Anda (mis. `https://username.github.io`), lalu `wrangler deploy` ulang. Selama masih tahap testing, `"*"` (default) aman dipakai.

## Catatan Model Gemini

Default dipakai `gemini-3.5-flash-lite` (terbukti stabil di free tier, 250K token/menit). Jika ingin ganti model, edit `GEMINI_MODEL` di `wrangler.toml`.

## Sumber Data

- Performa cabang, piutang, stok: Google Sheet publik "Sistem Integrasi Makassar 2026" (dibaca via CSV export, tanpa API key).
- KPI Personel: Apps Script Web App yang sudah ada dan terbukti jalan (dipakai bersama dengan aplikasi "Daeng Falcom").

Jika struktur kolom sheet berubah di kemudian hari, sesuaikan bagian `handleSync()` di `worker.js`.
