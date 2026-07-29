/**
 * Asvir Makassar — Cloudflare Worker backend
 * Routes:
 *   GET  /sync   -> refresh Cloudflare KV cache from Google Sheets (protected by ?token=)
 *   POST /chat   -> stream a Gemini answer (SSE) grounded on the KV cache + query-aware retrieval
 *   GET  /status -> lightweight JSON for the frontend "data status" indicator
 *
 * Required bindings/vars (see wrangler.toml + README.md):
 *   KV binding:      SHEET_CACHE
 *   Secrets:         GEMINI_API_KEY, SYNC_TOKEN
 *   Vars (optional): ALLOWED_ORIGIN, GEMINI_MODEL
 */

// ---- Known public data sources (verified working against the live "Sistem Integrasi Makassar 2026"
// and "KPI Personel Cabang MKS" spreadsheets — see README.md if these ever need to change) ----
const PERFORMANCE_SHEET_ID = '1_uou6JDGV-Tm80oALMrduuj9ZIVWM1r9ppuQsYq7_qo';
const GIDS = {
  grandData: '1703817529', // Grand Data 2026 — line-item transactions
  stock: '507949843',      // Stock GD MKS — product/stock by SKU
  ar: '1407414424',        // AR 2026 — piutang / aging
};
const KPI_WEBAPP_URL =
  'https://script.google.com/macros/s/AKfycbyZjdcOqCzQZ3i54Y2pAZVfbnMfuaEHmPFOaMhlpPqBgD958CWKTN5iujN4lPOkvJ43/exec';

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

// Curated Falcom Technology product-page / tutorial references. Small and hand-maintained on
// purpose — matching the whole live catalog would need on-demand scraping (adds latency and
// fragility); extend this list over time with more {keywords, judul, links} entries.
const REFERENCE_LINKS = [
  {
    keywords: ['dropcore', 'drop core', '1 core', '1core', 'kabel 1 core', 'satu core', 'kabel satu core'],
    judul: 'Kabel Fiber Optik Dropcore 1 Core (Falcom Technology)',
    links: [
      'https://falcom-technology.com/products/kabel-fiber-optik-gjyxch-1f-super-premium-dropcore-12-mm/',
      'https://falcom-technology.com/products/kabel-fiber-optik-gjyxch-1f-high-quality-dropcore-1-core-1-messenger/',
    ],
  },
  {
    keywords: ['olt 3 pon', 'olt3pon', 'olt 3pon', 'tutorial olt', 'olt pon', 'cara setting olt'],
    judul: 'Tutorial OLT 3 PON (Falcom Technology Official)',
    links: ['https://youtu.be/pEZHy1OrByU?si=UfkKyfpM1n4Mfeob'],
  },
];

function csvExportUrl(sheetId, gid) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
}

// ---- Minimal RFC4180-ish CSV parser (handles quoted fields with commas/newlines) ----
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (c === '\r') {
      // skip, \n handles the row break
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function rowsToObjects(rows, headerRowIndex = 0) {
  const header = rows[headerRowIndex].map((h) => (h || '').trim());
  const out = [];
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((v) => v === '')) continue;
    const obj = {};
    header.forEach((h, idx) => { if (h) obj[h] = (r[idx] ?? '').trim(); });
    out.push(obj);
  }
  return out;
}

function toNumber(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseFlexibleDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d;
  // "28-Jul-2026" style
  const m = String(v).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const d2 = new Date(`${m[2]} ${m[1]}, ${m[3]}`);
    if (!Number.isNaN(d2.getTime())) return d2;
  }
  return null;
}

// ==== Query-aware retrieval helpers (keep /chat context small + relevant instead of dumping
// the whole dataset — the sister app's known 429/latency problem came from doing that) ====

function normText(s) {
  return (s || '').toString().toLowerCase().normalize('NFKD').replace(/\s+/g, ' ').trim();
}
function normCode(s) {
  return (s || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const STOPWORDS = new Set([
  'apa', 'yang', 'di', 'ke', 'dari', 'untuk', 'dengan', 'adalah', 'ini', 'itu', 'saya', 'ingin',
  'tolong', 'berapa', 'bagaimana', 'gimana', 'dong', 'ya', 'nih', 'kah', 'ada', 'apakah', 'dan',
  'atau', 'saat', 'sekarang', 'tentang', 'soal', 'info', 'informasi', 'kode', 'barang', 'produk',
  'nya', 'nya?', 'nya.', 'pakai', 'pake', 'itu?', 'nih?',
]);

function extractKeywords(message) {
  return normText(message)
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

// Bounded Levenshtein — only ever called on short strings (product codes), so cost stays cheap.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const dp = [];
  for (let i = 0; i <= m; i++) dp.push([i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// Matches stock by product code (typo/format tolerant: "DKB180" == "DKB-180" == "DKB 180",
// plus up to ~2-char edit-distance) or by description keyword (handles "kabel 1 core yang
// ready", "odp yang ready", etc.), then optionally narrows to in-stock only for "ready"-style asks.
function findStockMatches(message, allStock) {
  const keywords = extractKeywords(message);
  if (keywords.length === 0) return { items: [], note: 'Tidak ada kata kunci spesifik terdeteksi di pertanyaan.' };
  const wantsReady = /ready|tersedia|stok|stock|\bada\b/.test(normText(message));

  let matched = allStock.filter((p) => {
    const nKode = normCode(p.kode);
    const nNama = normText(p.nama);
    return keywords.some((kw) => {
      const nkw = normText(kw);
      const ckw = normCode(kw);
      if (ckw.length >= 3 && nKode.includes(ckw)) return true;
      if (nkw.length >= 3 && nNama.includes(nkw)) return true;
      if (ckw.length >= 4 && ckw.length <= 12 && levenshtein(ckw, nKode) <= 2) return true;
      return false;
    });
  });

  let note = '';
  if (wantsReady) {
    const before = matched.length;
    matched = matched.filter((p) => p.stokTotal > 0);
    note += `Difilter hanya stok > 0 (dari ${before} hasil cocok kata kunci). `;
  }

  const total = matched.length;
  if (total > 120) {
    matched = [...matched].sort((a, b) => b.stokTotal - a.stokTotal).slice(0, 120);
    note += `Total ${total} produk cocok — ditampilkan 120 teratas (urut stok terbanyak). Minta user mempersempit pencarian jika butuh sisanya.`;
  } else {
    note += `${matched.length} produk cocok kata kunci.`;
  }
  return { items: matched, note };
}

const MONTHS = {
  januari: 1, jan: 1, februari: 2, feb: 2, maret: 3, mar: 3, april: 4, apr: 4, mei: 5,
  juni: 6, jun: 6, juli: 7, jul: 7, agustus: 8, agu: 8, ags: 8, september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, november: 11, nov: 11, desember: 12, des: 12,
};

function extractDateMention(message) {
  const t = normText(message);
  const m = t.match(/\b(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?\b/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTHS[m[2]];
  if (!month || day < 1 || day > 31) return null;
  const year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  return { day, month, year };
}

// Matches transactions by exact date mention, else by a known customer name or delivery
// location (lokasi) appearing in the question — covers "penjualan tanggal 13 Juli",
// "Soni Susilo ekspedisinya apa?", and "ekspedisi ke Manado pakai apa?".
function findTransactionMatches(message, allTransactions) {
  if (!allTransactions.length) return { items: [], note: '' };
  const nMsg = normText(message);
  const dateMention = extractDateMention(message);

  let matched = [];
  let note = '';

  if (dateMention) {
    matched = allTransactions.filter((tx) => {
      const d = parseFlexibleDate(tx.tanggal);
      return d && d.getDate() === dateMention.day && d.getMonth() + 1 === dateMention.month && d.getFullYear() === dateMention.year;
    });
    note = `Transaksi tanggal ${dateMention.day}/${dateMention.month}/${dateMention.year}: ${matched.length} baris ditemukan.`;
  } else {
    const customerSet = new Set();
    for (const tx of allTransactions) if (tx.customer) customerSet.add(tx.customer);
    let hitCustomer = null;
    for (const c of customerSet) {
      if (c.length >= 4 && nMsg.includes(normText(c))) { hitCustomer = c; break; }
    }
    if (hitCustomer) {
      matched = allTransactions.filter((tx) => tx.customer === hitCustomer);
      note = `Transaksi customer "${hitCustomer}": ${matched.length} baris.`;
    } else {
      const lokasiSet = new Set();
      for (const tx of allTransactions) if (tx.lokasi) lokasiSet.add(tx.lokasi);
      let hitLokasi = null;
      for (const l of lokasiSet) {
        if (l.length >= 3 && nMsg.includes(normText(l))) { hitLokasi = l; break; }
      }
      if (hitLokasi) {
        matched = allTransactions.filter((tx) => tx.lokasi === hitLokasi);
        note = `Transaksi ke lokasi "${hitLokasi}": ${matched.length} baris.`;
      }
    }
  }

  if (matched.length > 150) {
    note += ` (menampilkan 150 dari ${matched.length} baris)`;
    matched = matched.slice(0, 150);
  }
  return { items: matched, note };
}

function matchReferences(message) {
  const nMsg = normText(message);
  return REFERENCE_LINKS.filter((r) => r.keywords.some((kw) => nMsg.includes(normText(kw))))
    .map((r) => ({ judul: r.judul, links: r.links }));
}

// ---- /sync: fetch + aggregate + store compact summaries (+ raw transactions) in KV ----
async function handleSync(request, env) {
  const url = new URL(request.url);
  if (!env.SYNC_TOKEN || url.searchParams.get('token') !== env.SYNC_TOKEN) {
    return json({ error: 'Unauthorized. Pass ?token=<SYNC_TOKEN>.' }, 401);
  }

  const summary = { syncedAt: new Date().toISOString(), sources: {} };

  // 1) Stock / product data
  try {
    const csv = await (await fetch(csvExportUrl(PERFORMANCE_SHEET_ID, GIDS.stock))).text();
    const rows = rowsToObjects(parseCsv(csv), 1); // row 0 is a merged-header banner, row 1 is the real header
    const products = rows
      .filter((r) => r['KODE BARANG'])
      .map((r) => ({
        kode: r['KODE BARANG'],
        nama: r['DESKRIPSI'],
        harga: toNumber(r['HARGA SATUAN']),
        stokMKI: toNumber(r['MKI']),
        stokCFN: toNumber(r['CFN']),
        stokTotal: toNumber(r['MKI & CFN']),
      }))
      .filter((p) => p.stokTotal > 0 || p.harga > 0);
    await env.SHEET_CACHE.put('data:stock', JSON.stringify(products));
    summary.sources.stock = { ok: true, produkTersimpan: products.length };
  } catch (err) {
    summary.sources.stock = { ok: false, error: String(err) };
  }

  // 2) Branch performance (monthly aggregate) + 5) raw transactions (for date/customer/ekspedisi
  // lookups) — fetched once, used for both, since transactions is just the un-aggregated form.
  try {
    const csv = await (await fetch(csvExportUrl(PERFORMANCE_SHEET_ID, GIDS.grandData))).text();
    const rows = rowsToObjects(parseCsv(csv), 0);
    const byMonth = {};
    const byLokasi = {};
    const transactions = [];
    for (const r of rows) {
      const d = parseFlexibleDate(r['Order Date']);
      const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'unknown';
      const amount = toNumber(r['Amount']);
      if (!byMonth[key]) byMonth[key] = { bulan: key, revenue: 0, transaksi: 0 };
      byMonth[key].revenue += amount;
      byMonth[key].transaksi += 1;
      const lokasi = (r['Lokasi'] || '').trim();
      if (lokasi) byLokasi[lokasi] = (byLokasi[lokasi] || 0) + 1;
      transactions.push({
        tanggal: r['Order Date'],
        invoice: r['No Invoice'],
        customer: r['Customer'],
        kode: r['Kode Barang'],
        qty: toNumber(r['Quantity']),
        amount,
        status: r['Status'],
        company: r['Company'],
        ekspedisi: r['Status (Ekspedisi)'],
        lokasi,
        tglTerkirim: r['Tanggal Terkirim'],
      });
    }
    const performance = Object.values(byMonth).sort((a, b) => a.bulan.localeCompare(b.bulan));
    const topWilayah = Object.entries(byLokasi)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([lokasi, jumlahTransaksi]) => ({ lokasi, jumlahTransaksi }));
    await env.SHEET_CACHE.put('data:performance', JSON.stringify({ performance, topWilayah }));
    await env.SHEET_CACHE.put('data:transactions', JSON.stringify(transactions));
    summary.sources.performance = { ok: true, bulanTersimpan: performance.length, baris: rows.length };
    summary.sources.transactions = { ok: true, baris: transactions.length };
  } catch (err) {
    summary.sources.performance = { ok: false, error: String(err) };
    summary.sources.transactions = { ok: false, error: String(err) };
  }

  // 3) Piutang / AR aging
  // This sheet has two side-by-side tables; columns A-J list every invoice (paid + unpaid),
  // columns L-S are the sheet's own pre-filtered "outstanding only" table (no Status column
  // needed there, and it's row-compacted, not aligned 1:1 with the left table) — per the user,
  // L-S is the authoritative source for piutang. Column indices (0-based): 11 Tanggal,
  // 12 No Faktur, 13 Nama Customer, 14 Nilai Faktur, 15 Sisa Saldo Piutang, 16 Aging,
  // 17 Kategori, 18 Company.
  try {
    const csv = await (await fetch(csvExportUrl(PERFORMANCE_SHEET_ID, GIDS.ar))).text();
    const allRows = parseCsv(csv).slice(1); // drop header row
    const byKategori = {};
    let totalPiutang = 0;
    let rowCount = 0;
    for (const r of allRows) {
      if (!r[12]) continue; // stop counting once the compacted L-S list runs out (No Faktur empty)
      rowCount++;
      const kategori = (r[17] || r[16] || 'Tidak diketahui').trim();
      const nilai = toNumber(r[15]);
      totalPiutang += nilai;
      if (!byKategori[kategori]) byKategori[kategori] = { kategori, jumlahInvoice: 0, totalNilai: 0 };
      byKategori[kategori].jumlahInvoice += 1;
      byKategori[kategori].totalNilai += nilai;
    }
    await env.SHEET_CACHE.put(
      'data:piutang',
      JSON.stringify({ totalPiutang, byKategori: Object.values(byKategori) })
    );
    summary.sources.piutang = { ok: true, baris: rowCount };
  } catch (err) {
    summary.sources.piutang = { ok: false, error: String(err) };
  }

  // 4) KPI Personel — reuses the existing, already-decoded Apps Script endpoint
  try {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const res = await fetch(`${KPI_WEBAPP_URL}?action=teamOverview&month=${month}`);
    const kpi = await res.json();
    await env.SHEET_CACHE.put('data:kpi', JSON.stringify({ month, kpi }));
    summary.sources.kpi = { ok: true, orang: Array.isArray(kpi) ? kpi.length : undefined };
  } catch (err) {
    summary.sources.kpi = { ok: false, error: String(err) };
  }

  await env.SHEET_CACHE.put('lastSync', summary.syncedAt);
  return json(summary);
}

// ---- /status: cheap poll target for the frontend's "Data terkini" indicator ----
async function handleStatus(env) {
  const lastSync = await env.SHEET_CACHE.get('lastSync');
  return json({ lastSync: lastSync || null });
}

// ---- /chat: query-aware retrieval + multi-turn history, stream Gemini's SSE straight through ----
async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body harus JSON: { "message": "..." }' }, 400);
  }
  const message = (body.message || '').toString().trim();
  const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
  if (!message) return json({ error: 'Field "message" wajib diisi.' }, 400);
  if (!env.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY belum di-set di server.' }, 500);

  const [stockRaw, perfRaw, piutangRaw, kpiRaw, txRaw, lastSync] = await Promise.all([
    env.SHEET_CACHE.get('data:stock'),
    env.SHEET_CACHE.get('data:performance'),
    env.SHEET_CACHE.get('data:piutang'),
    env.SHEET_CACHE.get('data:kpi'),
    env.SHEET_CACHE.get('data:transactions'),
    env.SHEET_CACHE.get('lastSync'),
  ]);

  const allStock = stockRaw ? JSON.parse(stockRaw) : [];
  const allTransactions = txRaw ? JSON.parse(txRaw) : [];
  const stokMatch = findStockMatches(message, allStock);
  const txMatch = findTransactionMatches(message, allTransactions);
  const referensi = matchReferences(message);

  const context = {
    performa: perfRaw ? JSON.parse(perfRaw) : null,
    piutang: piutangRaw ? JSON.parse(piutangRaw) : null,
    kpiPersonel: kpiRaw ? JSON.parse(kpiRaw) : null,
    stokRelevan: stokMatch.items,
    stokCatatan: stokMatch.note,
    transaksiRelevan: txMatch.items,
    transaksiCatatan: txMatch.note,
    referensiLink: referensi,
  };

  const systemPrompt = `Kamu adalah "Asvir Makassar", asisten AI internal untuk cabang Makassar PT. Mitra Kabel Indonesia.
Tugasmu: menjawab pertanyaan tentang performa cabang, piutang, KPI personel, transaksi/penjualan, ekspedisi, dan stok/spesifikasi produk, HANYA berdasarkan DATA KONTEKS di bawah ini dan histori percakapan sebelumnya.

Aturan:
- Jika data yang ditanyakan tidak ada di konteks, katakan terus terang tidak tahu / datanya belum tersedia — jangan mengarang angka.
- User sering salah ketik (typo 1-2 huruf), menyingkat kata, atau menulis kode barang dengan/tanpa spasi/strip (mis. "DKB180", "DKB-180", "DKB 180" adalah kode yang SAMA) — pahami maksudnya, jangan langsung bilang "tidak ditemukan".
- Jika user bertanya jumlah spesifik (mis. "10 wilayah penjualan terbesar", "5 customer terbanyak"), berikan SEMUA item yang diminta sesuai jumlah tersebut jika datanya tersedia di konteks, jangan dipotong.
- Untuk pertanyaan stok/ketersediaan barang, gunakan "stokRelevan" (hasil pencarian kata kunci otomatis) — sebutkan juga rincian per company (MKI/CFN), bukan cuma total. Field "stokCatatan" menjelaskan bagaimana hasil ini difilter.
- Untuk pertanyaan tanggal tertentu, nama customer, atau ekspedisi/pengiriman ke suatu wilayah, gunakan "transaksiRelevan" (sudah difilter otomatis sesuai pertanyaan) — field "ekspedisi" dan "company" di tiap baris menunjukkan cara pengiriman. Field "transaksiCatatan" menjelaskan filter yang dipakai.
- Gunakan HISTORI PERCAKAPAN untuk memahami pertanyaan lanjutan yang tidak lengkap sendiri, contoh: "kalau revenue-nya?", "bulan lalu gimana?", "itu belanja apa lagi?" — kaitkan dengan topik/entitas yang dibahas sebelumnya.
- Jika "referensiLink" berisi entri yang relevan dengan pertanyaan (spesifikasi produk atau tutorial), sertakan URL-nya APA ADANYA (utuh, bisa diklik) di jawabanmu — jangan ubah atau potong URL-nya.
- Jawab singkat, padat, dan langsung ke angka/fakta. Gunakan Bahasa Indonesia sehari-hari yang sopan.
- Data disinkron terakhir: ${lastSync || 'belum pernah sync'}.

DATA KONTEKS (JSON):
${JSON.stringify(context)}`;

  const contents = [
    ...history
      .filter((h) => h && h.text)
      .map((h) => ({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: String(h.text) }] })),
    { role: 'user', parts: [{ text: message }] },
  ];

  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`;

  const geminiRes = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.3 },
    }),
  });

  if (!geminiRes.ok || !geminiRes.body) {
    const errText = await geminiRes.text().catch(() => '');
    return json({ error: `Gemini API error (${geminiRes.status}): ${errText}` }, 502);
  }

  // Proxy the SSE stream through untouched — this is what keeps first-token latency low.
  return new Response(geminiRes.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...corsHeaders(env),
    },
  });
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    try {
      if (pathname === '/sync' && request.method === 'GET') {
        const res = await handleSync(request, env);
        Object.entries(corsHeaders(env)).forEach(([k, v]) => res.headers.set(k, v));
        return res;
      }
      if (pathname === '/status' && request.method === 'GET') {
        const res = await handleStatus(env);
        Object.entries(corsHeaders(env)).forEach(([k, v]) => res.headers.set(k, v));
        return res;
      }
      if (pathname === '/chat' && request.method === 'POST') {
        return await handleChat(request, env);
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      const res = json({ error: String(err && err.message ? err.message : err) }, 500);
      Object.entries(corsHeaders(env)).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }
  },
};
