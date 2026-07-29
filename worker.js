/**
 * Asvir Makassar — Cloudflare Worker backend
 * Routes:
 *   GET  /sync   -> refresh Cloudflare KV cache from Google Sheets (protected by ?token=)
 *   POST /chat   -> stream a Gemini answer (SSE) grounded on the KV cache
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

// ---- /sync: fetch + aggregate + store compact summaries in KV ----
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

  // 2) Branch performance — aggregate Grand Data 2026 by month (keeps KV/context small)
  try {
    const csv = await (await fetch(csvExportUrl(PERFORMANCE_SHEET_ID, GIDS.grandData))).text();
    const rows = rowsToObjects(parseCsv(csv), 0);
    const byMonth = {};
    const byLokasi = {};
    for (const r of rows) {
      const d = parseFlexibleDate(r['Order Date']);
      const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'unknown';
      const amount = toNumber(r['Amount']);
      if (!byMonth[key]) byMonth[key] = { bulan: key, revenue: 0, transaksi: 0 };
      byMonth[key].revenue += amount;
      byMonth[key].transaksi += 1;
      const lokasi = (r['Lokasi'] || '').trim();
      if (lokasi) byLokasi[lokasi] = (byLokasi[lokasi] || 0) + 1;
    }
    const performance = Object.values(byMonth).sort((a, b) => a.bulan.localeCompare(b.bulan));
    const topWilayah = Object.entries(byLokasi)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([lokasi, jumlahTransaksi]) => ({ lokasi, jumlahTransaksi }));
    await env.SHEET_CACHE.put('data:performance', JSON.stringify({ performance, topWilayah }));
    summary.sources.performance = { ok: true, bulanTersimpan: performance.length, baris: rows.length };
  } catch (err) {
    summary.sources.performance = { ok: false, error: String(err) };
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

// ---- /chat: build a grounded system prompt from KV, stream Gemini's SSE straight through ----
async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body harus JSON: { "message": "..." }' }, 400);
  }
  const message = (body.message || '').toString().trim();
  if (!message) return json({ error: 'Field "message" wajib diisi.' }, 400);
  if (!env.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY belum di-set di server.' }, 500);

  const [stockRaw, perfRaw, piutangRaw, kpiRaw, lastSync] = await Promise.all([
    env.SHEET_CACHE.get('data:stock'),
    env.SHEET_CACHE.get('data:performance'),
    env.SHEET_CACHE.get('data:piutang'),
    env.SHEET_CACHE.get('data:kpi'),
    env.SHEET_CACHE.get('lastSync'),
  ]);

  const context = {
    performa: perfRaw ? JSON.parse(perfRaw) : null,
    piutang: piutangRaw ? JSON.parse(piutangRaw) : null,
    kpiPersonel: kpiRaw ? JSON.parse(kpiRaw) : null,
    // Stock list can be long — send a capped slice; Gemini still sees representative data.
    stok: stockRaw ? JSON.parse(stockRaw).slice(0, 400) : null,
  };

  const systemPrompt = `Kamu adalah "Asvir Makassar", asisten AI internal untuk cabang Makassar PT. Mitra Kabel Indonesia.
Tugasmu: menjawab pertanyaan tentang performa cabang, piutang, KPI personel, dan stok/spesifikasi produk, HANYA berdasarkan DATA KONTEKS di bawah ini.

Aturan:
- Jika data yang ditanyakan tidak ada di konteks, katakan terus terang tidak tahu / datanya belum tersedia — jangan mengarang angka.
- User sering salah ketik (typo) atau menyingkat kata — coba pahami maksudnya sebelum menjawab "tidak ditemukan".
- Jawab singkat, padat, dan langsung ke angka/fakta. Gunakan Bahasa Indonesia sehari-hari yang sopan.
- Data disinkron terakhir: ${lastSync || 'belum pernah sync'}.

DATA KONTEKS (JSON):
${JSON.stringify(context)}`;

  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`;

  const geminiRes = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: message }] }],
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
