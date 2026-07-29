/**
 * MIRA (Makassar Intelligent Response Assistant) — Cloudflare Worker backend
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
  grandData: '1703817529', // Grand Data 2026 — line-item transactions (= SALES, order amount)
  stock: '507949843',      // Stock GD MKS — product/stock by SKU
  ar: '1407414424',        // AR 2026 — piutang / aging
  revSum: '1062237088',    // Rev SUM — actual payments collected (REVENUE, different from Sales)
  poGudang: '2047354384',  // PO Gudang — incoming supplier purchase orders (columns A-K only)
  salesSum: '1234708655',  // Sales SUM — columns AS-BB hold 2025 vs 2026 YoY comparison + monthly target
  kpiMonitor: '64738765',  // KPI MONITORING — columns M-Z hold per-wilayah monthly invoice counts (zona)
};

// Same province mapping the live dashboard hardcodes (Kabupaten/Kota -> ISO 3166-2:ID code) —
// copied verbatim from calc.js so "zona wilayah" answers match what the dashboard shows.
const WILAYAH_TO_PROVINCE = {
  MAKASSAR: 'IDSN', BONE: 'IDSN', SIDRAP: 'IDSN', GOWA: 'IDSN', PALOPO: 'IDSN', BULUKUMBA: 'IDSN',
  JENEPONTO: 'IDSN', SENGKANG: 'IDSN', BELOPA: 'IDSN', PANGKEP: 'IDSN', ENREKANG: 'IDSN', PINRANG: 'IDSN',
  BARRU: 'IDSN', SOPPENG: 'IDSN', TAKALAR: 'IDSN', MALILI: 'IDSN', SINJAI: 'IDSN', 'PARE-PARE': 'IDSN',
  'LUWU TIMUR': 'IDSN', MANGKUTANA: 'IDSN', MASAMBA: 'IDSN', LUWU: 'IDSN', BANTAENG: 'IDSN', SUKAMAJU: 'IDSN',
  'LUWU UTARA': 'IDSN', MAROS: 'IDSN', SOROWAKO: 'IDSN', 'BONE-BONE': 'IDSN', WAJO: 'IDSN', WAWONDULA: 'IDSN',
  SELAYAR: 'IDSN', TORAJA: 'IDSN', LAROMPONG: 'IDSN', SIWA: 'IDSN', TOMONI: 'IDSN', WASUPONDA: 'IDSN',
  TANAMONI: 'IDSN', WOWONDULA: 'IDSN', WALENRANG: 'IDSN', RANTEPAO: 'IDSN', 'BELAWA WAJO': 'IDSN',
  BAEBUNTA: 'IDSN', LAPAI: 'IDSN', TOWUTI: 'IDSN',
  KENDARI: 'IDSG', 'BAU-BAU': 'IDSG', KOLAKA: 'IDSG', KONAWE: 'IDSG', MUNA: 'IDSG', 'KOLAKA UTARA': 'IDSG',
  BOMBANA: 'IDSG', RAHA: 'IDSG', BUTON: 'IDSG', LASUSUA: 'IDSG', 'KOLAKA TIMUR': 'IDSG', UNAHA: 'IDSG',
  'BUTON TENGAH': 'IDSG', WAKATOBI: 'IDSG', 'BAU BAU': 'IDSG',
  PALU: 'IDST', BANGGAI: 'IDST', 'TOLI-TOLI': 'IDST', MOROWALI: 'IDST', POSO: 'IDST', BETELEME: 'IDST',
  KOLONEDALLE: 'IDST', PARIGI: 'IDST', 'LUWUK BANGGAI': 'IDST', BURIKO: 'IDST', 'MOROWALI UTARA': 'IDST',
  TENTENA: 'IDST', LUMBEWE: 'IDST', BUNGKU: 'IDST', 'PARIGI MOUTONG': 'IDST', DONGGALA: 'IDST',
  'TOJO UNA-UNA': 'IDST', SIGI: 'IDST', PENDOLO: 'IDST', TARAELU: 'IDST', LAMBARESE: 'IDST', BUOL: 'IDST',
  MAJENE: 'IDSR', PASANGKAYU: 'IDSR', MAMUJU: 'IDSR', MAMASA: 'IDSR', POLEWALI: 'IDSR', POLMAN: 'IDSR', TOPOYO: 'IDSR',
  MANADO: 'IDSA', KOTAMOBAGU: 'IDSA', MINAHASA: 'IDSA', 'BOLAANG MONGODOW': 'IDSA', 'KEPULAUAN SANGIHE': 'IDSA',
  'SIAU TAGULANDANG BIARO': 'IDSA', 'KEPULAUAN TALAUD': 'IDSA', BITUNG: 'IDSA', TOMOHON: 'IDSA',
  GORONTALO: 'IDGO', BOALEMO: 'IDGO', 'BONE BOLANGO': 'IDGO', POHUWATU: 'IDGO',
  AMBON: 'IDMA', MALUKU: 'IDMA', SAUMLAKI: 'IDMA', BANDA: 'IDMA', NAMLEA: 'IDMA',
  TERNATE: 'IDMU', HALMAHERA: 'IDMU', 'MALUKU UTARA': 'IDMU',
  PAPUA: 'IDPA', NABIRE: 'IDPA', JAYAPURA: 'IDPA', WAMENA: 'IDPA',
  BINTUNI: 'IDPB', MANOKWARI: 'IDPB',
  JAKARTA: 'IDJK', SURABAYA: 'IDJI', SAMARINDA: 'IDKI', BALIKPAPAN: 'IDKI', BERAU: 'IDKI', BELITUNG: 'IDBB',
};

function zoneOf(totalInvoice) {
  if (totalInvoice > 50) return 'hijau';
  if (totalInvoice >= 20) return 'kuning';
  return 'merah';
}

// Same 5 codes the live Kinerja-Cabang-Makassar dashboard hardcodes for its "Fiber Optic 1-Core"
// section — kept identical here so MIRA's answer matches what the dashboard shows.
const FO_1CORE_CODES = ['KSFO028', 'KSFO108', 'KSFO083', 'KSFO113', 'KSFO128'];
const KPI_WEBAPP_URL =
  'https://script.google.com/macros/s/AKfycbyZjdcOqCzQZ3i54Y2pAZVfbnMfuaEHmPFOaMhlpPqBgD958CWKTN5iujN4lPOkvJ43/exec';

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

// Curated Falcom Technology product-page / tutorial references. Small and hand-maintained on
// purpose — matching the whole live catalog would need on-demand scraping (adds latency and
// fragility); extend this list over time with more {keywords, judul, links} entries.
// Falcom Technology reference catalog — ONLY these URLs may ever be cited to the user (never
// invent a URL outside this table). Kept as structured groups (category/solution/tutorial/
// general) because each group has a different inclusion rule in the system prompt below.
const PRODUCT_CATEGORIES = [
  { keywords: ['fiber optik', 'fiber optic', 'kabel fo', 'kabel fiber'], judul: 'Kabel Fiber Optik', url: 'https://falcom-technology.com/category/optical-fiber-cable/' },
  { keywords: ['kabel lan', 'cat5', 'cat6', 'kabel utp', 'kabel jaringan lan'], judul: 'Kabel LAN (CAT5/CAT6)', url: 'https://falcom-technology.com/category/lan-cable/' },
  { keywords: ['coaxial', 'coax', 'kabel coax'], judul: 'Kabel Coaxial', url: 'https://falcom-technology.com/category/coaxial-cable/' },
  { keywords: ['konektor fiber', 'konektor fo', 'adaptor fiber', 'adapter fiber', 'aksesoris fiber', 'pigtail', 'patch cord'], judul: 'Aksesoris Fiber Optik', url: 'https://falcom-technology.com/category/fiberoptic-accesorries/' },
  { keywords: ['olt epon', 'olt gpon', 'olt 3', 'olt3', 'olt 4', 'olt4', 'olt 8', 'olt8', 'olt 16', 'olt16', ' olt '], judul: 'OLT EPON & GPON', url: 'https://falcom-technology.com/category/epon-gpon/' },
  { keywords: [' onu', ' ont', 'onu/ont', 'modem gpon', 'modem epon'], judul: 'ONU/ONT', url: 'https://falcom-technology.com/category/onu-ont/' },
  { keywords: ['transmitter', 'edfa'], judul: 'Transmitter & EDFA', url: 'https://falcom-technology.com/category/transmitter-edfa/' },
  { keywords: ['analog digital', 'analogue digital'], judul: 'Analog Digital', url: 'https://falcom-technology.com/category/analogue-digital/' },
  { keywords: ['hfc', 'hybrid fiber coaxial'], judul: 'HFC (Hybrid Fiber Coaxial)', url: 'https://falcom-technology.com/category/hfc/' },
  { keywords: ['fiber broadband unit', ' fbu '], judul: 'Fiber Broadband Unit', url: 'https://falcom-technology.com/category/fiber-broadband-unit/' },
  { keywords: ['media converter', 'switch jaringan', 'switch fiber'], judul: 'Media Converter & Switch', url: 'https://falcom-technology.com/category/media-converter-switch/' },
  { keywords: ['access point', 'wireless ap', 'wifi outdoor', ' ap ', 'akses poin'], judul: 'Wireless Access Point', url: 'https://falcom-technology.com/category/wireless-access-point/' },
  { keywords: ['tools', 'sparepart', 'spare part', 'alat splicing', 'alat jaringan'], judul: 'Tools & Sparepart', url: 'https://falcom-technology.com/category/tools-spareparts/' },
  { keywords: [' rack ', 'rak server', 'rak jaringan'], judul: 'Rack', url: 'https://falcom-technology.com/category/rack/' },
];

const SOLUTIONS = [
  { keywords: ['hfc + fttx', 'hfc fttx', 'solusi hfc fttx', 'solusi hfc dan fttx'], judul: 'Solusi HFC + FTTX', url: 'https://falcom-technology.com/solution/hfc-fttx/' },
  { keywords: ['ftth', 'fiber to the home'], judul: 'Solusi FTTH', url: 'https://falcom-technology.com/solution/ftth/' },
  { keywords: ['solusi hfc'], judul: 'Solusi HFC', url: 'https://falcom-technology.com/solution/hfc/' },
  { keywords: ['solusi wireless', 'solusi access point'], judul: 'Solusi Wireless Access Point', url: 'https://falcom-technology.com/solution/wireless-access-point/' },
];

const TUTORIAL_LINKS = [
  { judul: 'Bantuan & Dukungan', url: 'https://falcom-technology.com/help-and-support/' },
  { judul: 'Kelas Pelatihan FTTX', url: 'https://falcom-technology.com/fttx-class/' },
  { judul: 'Galeri Video Tutorial', url: 'https://falcom-technology.com/category/video-gallery/' },
  { judul: 'Channel YouTube Falcom Technology (semua video tutorial & demo produk)', url: 'https://www.youtube.com/@falcomtechnologyofficial2262' },
];

// Curated Falcom YouTube video map — keyword-matched per video (not just per category), so a
// specific question ("cara pasang fast connector") lands on the exact tutorial, not just the
// general channel link. Never invent a video/keyword outside this list.
const YOUTUBE_VIDEOS = [
  { judul: 'Kabel Koaksial RG11 & RG6', url: 'https://www.youtube.com/watch?v=WpBoDU9Q7Fo', keywords: ['kabel koaksial', 'rg6', 'rg11', 'kode kabel coaxial', 'struktur kabel coax', 'kabel antena', 'tv kabel'] },
  { judul: 'Kabel Fiber Optik Armored vs Non Armored', url: 'https://www.youtube.com/watch?v=Qeqyo6aoCgA', keywords: ['kabel fiber armored', 'kabel fiber non armored', 'perbedaan armored', 'tahan gigitan tikus', 'pilih kabel fiber'] },
  { judul: 'Kelebihan ODP Berbahan PC/ABS di Jaringan FTTH', url: 'https://www.youtube.com/watch?v=phrnH1QICgE', keywords: [' odp', 'optical distribution point', 'odp pc abs', 'kotak pembagi fiber', 'material odp'] },
  { judul: 'Fusion Splicer Jilong KL-260T', url: 'https://www.youtube.com/watch?v=BImn1JIng7s', keywords: ['fusion splicer kl-260t', 'kl-260t', 'splicer jilong', 'alat sambung fiber', 'trunk line splicer'] },
  { judul: 'OLT GPON 3 PON Fastlink (kelebihan & cara setting)', url: 'https://www.youtube.com/watch?v=pEZHy1OrByU', keywords: ['olt gpon 3 pon', 'olt 3 pon', 'fastlink olt', 'cara setting olt', 'konfigurasi gpon', 'tutorial olt'] },
  { judul: 'Media Transmisi Terpandu (LAN, Fiber Optik, Coaxial)', url: 'https://www.youtube.com/watch?v=VjYtpEj6sIE', keywords: ['jenis kabel jaringan', 'media transmisi', 'perbedaan kabel lan fiber coaxial', 'dasar kabel jaringan'] },
  { judul: 'Pembagian Segmen Kabel Fiber Optik di Jaringan FTTH', url: 'https://www.youtube.com/watch?v=_zVYXtevSIc', keywords: ['segmen kabel ftth', 'feeder distribusi', 'drop core', 'arsitektur jaringan ftth', 'pembagian jalur fiber'] },
  { judul: 'FTTH EPON atau GPON?', url: 'https://www.youtube.com/watch?v=VVPAzg6Nhzc', keywords: ['epon vs gpon', 'pilih epon atau gpon', 'perbedaan epon gpon', 'teknologi ftth'] },
  { judul: 'Keunggulan OLT Outdoor 8 PON Fastlink', url: 'https://www.youtube.com/watch?v=p2P8G7NlwGk', keywords: ['olt outdoor', 'olt 8 pon', 'fastlink outdoor', 'olt tahan cuaca', 'spesifikasi olt outdoor'] },
  { judul: 'Cara Pemasangan Fast Connector FMC-S', url: 'https://www.youtube.com/watch?v=C58b2tOGhS8', keywords: ['fast connector', 'fmc-s', 'cara pasang konektor fiber cepat', 'konektor anti gagal', 'tutorial konektor fiber'] },
  { judul: 'Konektivitas Paling Populer WLAN', url: 'https://www.youtube.com/watch?v=SZ3OSUhIRfQ', keywords: ['wlan', 'wireless lan', 'jaringan nirkabel', 'konektivitas wifi'] },
  { judul: 'Perbedaan WiFi 4, WiFi 5, WiFi 6', url: 'https://www.youtube.com/watch?v=naigj3y7RgI', keywords: ['wifi 4', 'wifi 5', 'wifi 6', 'sejarah wifi', 'standar wireless', 'pilih access point'] },
  { judul: 'Solusi Jaringan Fiber Optik Termurah — Media Converter', url: 'https://www.youtube.com/watch?v=ijlfUFAcDL4', keywords: ['media converter', 'solusi fiber murah', 'konversi sinyal fiber ke ethernet'] },
  { judul: 'Perbedaan Fusion Splicer KL-500E, KL-280T & KL-360E', url: 'https://www.youtube.com/watch?v=9djM62OP4fg', keywords: ['perbandingan splicer', 'kl-500e', 'kl-280t', 'kl-360e', 'pilih fusion splicer'] },
  { judul: 'Cari OLT Murah dan Handal', url: 'https://www.youtube.com/watch?v=ZyFaibynEWQ', keywords: ['olt murah', 'rekomendasi olt', 'olt terjangkau'] },
  { judul: 'OLT GPON 1 PON Fastlink FTB1200', url: 'https://www.youtube.com/watch?v=lvuyiYC37eg', keywords: ['olt 1 pon', 'ftb1200', 'olt anti panas', 'olt compact'] },
  { judul: 'ONT/ONU CGW 77 Fastlink', url: 'https://www.youtube.com/watch?v=m08yUSjILFc', keywords: ['cgw 77', 'perangkat pelanggan ftth', 'modem gpon'] },
  { judul: 'New Product Splicer KL-280T', url: 'https://www.youtube.com/watch?v=FfvU4zafeWQ', keywords: ['splicer kl-280t', 'produk baru splicer', 'tools ftth'] },
  { judul: 'Kelebihan dan Tutorial Setting OLT EPON 2 PON', url: 'https://www.youtube.com/watch?v=adjeLfSioJI', keywords: ['olt epon 2 pon', 'cara setting epon', 'konfigurasi olt epon', 'tutorial olt epon'] },
  { judul: 'Perbedaan Kabel LAN UTP, STP, FTP', url: 'https://www.youtube.com/watch?v=Io8ufQ-4Huc', keywords: ['kabel lan', 'utp', 'stp', 'ftp', 'perbedaan kabel lan', 'jenis kabel ethernet'] },
  { judul: 'Perbedaan ODF, ODC, ODP', url: 'https://www.youtube.com/watch?v=lqz-QbbJcTk', keywords: [' odf', ' odc', ' odp', 'perbedaan perangkat distribusi fiber', 'istilah ftth'] },
  { judul: 'Service Charging Board Splicer Jilong KL-500E', url: 'https://www.youtube.com/watch?v=HxmhbXqm72k', keywords: ['servis splicer', 'charging board kl-500e', 'perbaikan splicer', 'maintenance splicer'] },
  { judul: 'Kelebihan dan Tutorial Setting OLT 8 Port PON GPON', url: 'https://www.youtube.com/watch?v=9rC_kTOmHyg', keywords: ['olt 8 pon gpon', 'cara setting olt 8 port', 'konfigurasi gpon 8 port'] },
  { judul: 'Struktur Kabel Fiber Optik Mini ADSS', url: 'https://www.youtube.com/watch?v=IqkxbRSUlw8', keywords: ['kabel adss', 'fiber optik mini adss', 'struktur adss'] },
];

// Non-technical (event/company news) videos — only surfaced when the question is about Falcom's
// activities/news, not technical products.
const YOUTUBE_VIDEOS_NONTEKNIS = [
  { judul: 'Opening Falcom Cab. Semarang', url: 'https://www.youtube.com/watch?v=H7wHIxKYoXo' },
  { judul: 'Buka Bersama ISP Sulawesi & Technology', url: 'https://www.youtube.com/watch?v=e4wWvJfMMHM' },
  { judul: 'Berani Bersaing Bersama Cablelink', url: 'https://www.youtube.com/watch?v=a5IG9BCfeqs' },
  { judul: 'Roadshow Gresik bersama Alwi Network', url: 'https://www.youtube.com/watch?v=1M-CvvA4Gro' },
  { judul: 'Roadshow Sampang Madura bersama Alifa Fiber', url: 'https://www.youtube.com/watch?v=enTE1dua6W0' },
  { judul: 'Falcom di Indonesia Internet Expo & Summit (JIExpo)', url: 'https://www.youtube.com/watch?v=g7bhV5oHcp4' },
];

function matchVideos(message) {
  const nMsg = ` ${normText(message)} `;
  const teknis = YOUTUBE_VIDEOS.filter((v) => v.keywords.some((kw) => nMsg.includes(kw))).slice(0, 3);
  const wantsEvent = /kegiatan falcom|berita falcom|event falcom|acara falcom|roadshow|opening cabang/.test(nMsg);
  return { teknis, nonTeknis: wantsEvent ? YOUTUBE_VIDEOS_NONTEKNIS : [] };
}

const ARTICLE_LINK = { judul: 'Artikel & Berita Teknis', url: 'https://falcom-technology.com/articles/' };

const GENERAL_LINKS = {
  semuaProduk: { judul: 'Semua Produk', url: 'https://falcom-technology.com/products/' },
  tentangKami: { judul: 'Tentang Kami', url: 'https://falcom-technology.com/about-us/' },
  kontak: { judul: 'Kontak / Jaringan Penjualan', url: 'https://falcom-technology.com/contact/' },
};

function matchReferences(message) {
  const nMsg = ` ${normText(message)} `; // padded so ' ap ' / ' rack ' style keywords can match at string edges
  const kategoriProduk = PRODUCT_CATEGORIES.filter((c) => c.keywords.some((kw) => nMsg.includes(kw)));
  const solusiSistem = SOLUTIONS.filter((s) => s.keywords.some((kw) => nMsg.includes(kw)));
  const wantsTutorial = /tutorial|cara pasang|cara install|cara setting|cara konfigurasi|cara pakai|cara menggunakan|troubleshoot|bagaimana cara|video (tutorial|demo)/.test(nMsg);
  const wantsArticle = /\bartikel\b|berita teknis/.test(nMsg);
  const wantsSpec = /\bspek\b|spesifikasi|datasheet/.test(nMsg);
  const video = matchVideos(message);
  const hasAnyMatch = kategoriProduk.length || solusiSistem.length || wantsTutorial || wantsArticle || video.teknis.length;
  return {
    kategoriProduk,
    solusiSistem,
    tutorialDanDukungan: wantsTutorial ? TUTORIAL_LINKS : [],
    artikel: wantsArticle ? [ARTICLE_LINK] : [],
    videoTutorialRelevan: video.teknis,
    videoKegiatanFalcom: video.nonTeknis,
    // Only fall back to generic pages when there's a clear product-spec question with no
    // specific category match — never for unrelated operational questions (sales/stok/piutang).
    fallbackUmum: wantsSpec && !hasAnyMatch ? [GENERAL_LINKS.semuaProduk, GENERAL_LINKS.kontak] : [],
  };
}

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
  // Scan ALL "number word" candidates, not just the first — messages routinely have an earlier
  // unrelated number (e.g. "3 customer yang... tanggal 28 Juli 2026") that isn't a date; taking
  // only the first regex match and bailing out if IT isn't a real month silently discarded any
  // real date mentioned later in the sentence.
  for (const m of t.matchAll(/\b(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?\b/g)) {
    const day = parseInt(m[1], 10);
    const month = MONTHS[m[2]];
    if (!month || day < 1 || day > 31) continue;
    const year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
    return { day, month, year };
  }
  return null;
}

// Date RANGE mention ("16-29 Juli 2026", "16 sampai 29 Juli", "16 s/d 29 Juli 2026") — tried
// before extractDateMention, since a range like "16-29 Juli" would otherwise only ever yield the
// single day 29 (whichever number sits immediately before the month name) and silently drop
// everything from the 16th-28th.
function extractDateRangeMention(message) {
  const t = normText(message);
  for (const m of t.matchAll(/\b(\d{1,2})\s*(?:-|sampai|s\/d|s\.d\.?|hingga)\s*(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?\b/g)) {
    const d1 = parseInt(m[1], 10);
    const d2 = parseInt(m[2], 10);
    const month = MONTHS[m[3]];
    if (!month || d1 < 1 || d1 > 31 || d2 < 1 || d2 > 31) continue;
    const year = m[4] ? parseInt(m[4], 10) : new Date().getFullYear();
    return { startDay: Math.min(d1, d2), endDay: Math.max(d1, d2), month, year };
  }
  return null;
}

// Matches transactions by exact date mention, else by a known customer name appearing in the
// question — covers "penjualan tanggal 13 Juli" and "Soni Susilo ekspedisinya apa?". Wilayah/
// ekspedisi questions ("ekspedisi ke Manado pakai apa?") are handled separately by
// findWilayahMatches against the full pre-aggregated data, not a capped raw-row scan — a capped
// scan previously gave incomplete/wrong ekspedisi answers.
// Fuzzy match: does the message contain most of a customer name's significant words? Handles
// partial/shortened names (e.g. message "Arsyad Ambo Dalle" vs stored "MUH. ARSYAD AMBO DALLE")
// which a plain substring check misses since the stored name is LONGER than what the user typed.
const NAME_STOPWORDS = new Set(['muh', 'tk', 'pt', 'cv', 'toko', 'bpk', 'ibu', 'dan']);
function nameWordsOf(text) {
  return normText(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

// True typo tolerance (not just missing/partial words): each significant word in the stored
// customer name is matched against message words either exactly OR within edit-distance 1-2
// (scaled to word length), so "Arsad Ambo Dale" still finds "MUH. ARSYAD AMBO DALLE".
function customerNameFuzzyMatch(msgWords, customerName) {
  const nameWords = nameWordsOf(customerName).filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w));
  if (!nameWords.length) return false;
  const hits = nameWords.filter((nw) =>
    msgWords.some((mw) => mw === nw || (Math.abs(mw.length - nw.length) <= 2 && levenshtein(mw, nw) <= (nw.length <= 4 ? 1 : 2)))
  ).length;
  return hits / nameWords.length >= 0.7;
}

// Matches transactions by (in priority order): exact date mention, product code mention (for
// "siapa pembeli terakhir KODE", "kapan KODE terakhir keluar"), or customer name (fuzzy, handles
// partial names). Results are sorted newest-first so "terakhir/last" questions read the top row.
function findTransactionMatches(message, allTransactions) {
  if (!allTransactions.length) return { items: [], note: '' };
  const rangeMention = extractDateRangeMention(message);
  const dateMention = !rangeMention ? extractDateMention(message) : null;

  const byDateDesc = (a, b) => {
    const da = parseFlexibleDate(a.tanggal);
    const db = parseFlexibleDate(b.tanggal);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  };

  // Collect ALL matched product codes (not just the first) — a question can name several codes
  // at once ("FOTB074 dan FOTB075"), match per keyword TOKEN (not by blobbing the whole message
  // into one string, which caused false-positive substring hits inside ordinary Indonesian words).
  const kodeSet = new Set();
  for (const tx of allTransactions) if (tx.kode) kodeSet.add(tx.kode);
  const hitKodes = [];
  for (const kw of extractKeywords(message)) {
    const ckw = normCode(kw);
    if (ckw.length < 4) continue;
    for (const k of kodeSet) {
      const ck = normCode(k);
      if (ck.length >= 4 && (ck === ckw || ckw.includes(ck)) && !hitKodes.includes(k)) hitKodes.push(k);
    }
  }

  let matched = allTransactions;
  const noteParts = [];

  if (rangeMention) {
    matched = matched.filter((tx) => {
      const d = parseFlexibleDate(tx.tanggal);
      return d && d.getMonth() + 1 === rangeMention.month && d.getFullYear() === rangeMention.year
        && d.getDate() >= rangeMention.startDay && d.getDate() <= rangeMention.endDay;
    });
    noteParts.push(`tanggal ${rangeMention.startDay}-${rangeMention.endDay} bulan ${rangeMention.month}/${rangeMention.year}`);
  } else if (dateMention) {
    matched = matched.filter((tx) => {
      const d = parseFlexibleDate(tx.tanggal);
      return d && d.getDate() === dateMention.day && d.getMonth() + 1 === dateMention.month && d.getFullYear() === dateMention.year;
    });
    noteParts.push(`tanggal ${dateMention.day}/${dateMention.month}/${dateMention.year}`);
  }

  if (hitKodes.length) {
    matched = matched.filter((tx) => hitKodes.includes(tx.kode));
    noteParts.push(`kode ${hitKodes.join(', ')}`);
  }

  let note = '';
  if (noteParts.length) {
    // Date and/or code filter(s) applied above.
    matched = [...matched].sort(byDateDesc);
    note = `Difilter ${noteParts.join(' DAN ')}: ${matched.length} baris ditemukan, diurutkan PALING BARU dulu. Jika kode disebut tapi baris untuk kode itu 0, artinya BENAR-BENAR tidak ada transaksi — bukan berarti pencarian gagal.`;
  } else {
    // No date/code found — fall back to fuzzy customer-name matching only.
    const customerSet = new Set();
    for (const tx of allTransactions) if (tx.customer) customerSet.add(tx.customer);
    const msgWords = nameWordsOf(message);
    let hitCustomer = null;
    for (const c of customerSet) {
      if (c.length >= 4 && customerNameFuzzyMatch(msgWords, c)) { hitCustomer = c; break; }
    }
    matched = hitCustomer ? allTransactions.filter((tx) => tx.customer === hitCustomer).sort(byDateDesc) : [];
    if (hitCustomer) {
      note = `Transaksi customer "${hitCustomer}": ${matched.length} baris, diurutkan dari yang PALING BARU (baris pertama = transaksi terakhir).`;
    }
  }

  if (matched.length > 150) {
    note += ` (menampilkan 150 TERBARU dari ${matched.length} baris — sisanya lebih lama)`;
    matched = matched.slice(0, 150);
  }
  return { items: matched, note };
}

// Wilayah/ekspedisi lookup against the FULL pre-aggregated per-lokasi breakdown (all ~100+
// locations, every ekspedisi they've ever used, ranked by frequency) — this is what makes
// "ekspedisi ke Manado pakai apa?" answer completely and correctly (e.g. MEGA MAS as the
// dominant carrier) instead of whatever happened to be in a capped sample of raw rows.
function findWilayahMatches(message, wilayahEkspedisi) {
  if (!wilayahEkspedisi || !wilayahEkspedisi.length) return null;
  const nMsg = normText(message);
  for (const w of wilayahEkspedisi) {
    if (w.lokasi && w.lokasi.length >= 3 && nMsg.includes(normText(w.lokasi))) return w;
  }
  return null;
}

// Zona wilayah lookup ("zona Manado apa", "wilayah merah apa saja") against the KPI Monitoring-
// derived zone data — separate from findWilayahMatches (that one's for ekspedisi, this one's for
// invoice-count zoning merah/kuning/hijau which comes from a different sheet entirely).
function findZonaWilayahMatches(message, zonaData) {
  if (!zonaData) return null;
  const nMsg = normText(message);
  for (const w of zonaData.wilayah || []) {
    if (w.nama && w.nama.length >= 3 && nMsg.includes(normText(w.nama))) return { tipe: 'satuWilayah', data: w };
  }
  if (/merah|kuning|hijau/.test(nMsg)) {
    const zone = ['merah', 'kuning', 'hijau'].find((z) => nMsg.includes(z));
    return { tipe: 'perZona', zona: zone, data: (zonaData.wilayah || []).filter((w) => w.zone === zone) };
  }
  if (/tanpa pembelanjaan|tidak ada pembelanjaan|belum pernah belanja/.test(nMsg)) {
    return { tipe: 'tanpaPembelanjaan', data: zonaData.tanpaPembelanjaan };
  }
  return null;
}

// Per-customer piutang lookup ("piutang customer X berapa?") against the full invoice-level
// detail list (only 189 rows total, cheap to scan) — the category aggregate alone has no
// per-customer breakdown at all, which is why these questions used to come back empty.
function findPiutangByCustomer(message, piutangDetail) {
  if (!piutangDetail || !piutangDetail.length) return null;
  const customerSet = new Set();
  for (const p of piutangDetail) if (p.customer) customerSet.add(p.customer);
  const msgWords = nameWordsOf(message);
  let hit = null;
  for (const c of customerSet) {
    if (c.length >= 4 && customerNameFuzzyMatch(msgWords, c)) { hit = c; break; }
  }
  if (!hit) return null;
  const invoices = piutangDetail.filter((p) => p.customer === hit);
  return {
    customer: hit,
    jumlahInvoice: invoices.length,
    totalSisaPiutang: invoices.reduce((sum, p) => sum + p.nilaiSisa, 0),
    invoices,
  };
}

// Per-customer PAYMENT history ("kapan X terakhir bayar/lunas piutang?") — distinct from
// findPiutangByCustomer (outstanding invoice balances) and from sales transaction lookup
// (order date). Sorted newest-first so "terakhir bayar" reads the top row.
function findPaymentsByCustomer(message, paymentDetail) {
  if (!paymentDetail || !paymentDetail.length) return null;
  const customerSet = new Set();
  for (const p of paymentDetail) if (p.customer) customerSet.add(p.customer);
  const msgWords = nameWordsOf(message);
  let hit = null;
  for (const c of customerSet) {
    if (c.length >= 4 && customerNameFuzzyMatch(msgWords, c)) { hit = c; break; }
  }
  if (!hit) return null;
  const payments = paymentDetail
    .filter((p) => p.customer === hit)
    .sort((a, b) => {
      const da = parseFlexibleDate(a.tanggal);
      const db = parseFlexibleDate(b.tanggal);
      return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
    });
  return {
    customer: hit,
    jumlahPembayaran: payments.length,
    totalDibayar: payments.reduce((sum, p) => sum + p.amount, 0),
    pembayaranTerbaruDulu: payments,
  };
}

// PO Gudang item-level lookup ("PO kode X status apa", "PO yang masih ditunggu apa saja") —
// only the matched subset is sent to Gemini, the full ~250-row list stays out of every request.
function findPoGudangMatches(message, poItems) {
  if (!poItems || !poItems.length) return { items: [], note: '' };
  const nMsg = normText(message);
  const keywords = extractKeywords(message);
  let matched = poItems.filter((p) => {
    const nKode = normCode(p.kode);
    return keywords.some((kw) => {
      const ckw = normCode(kw);
      return ckw.length >= 3 && nKode.includes(ckw);
    });
  });
  let note = '';
  const statusWords = { ditunggu: 'ditunggu', diterima: 'diterima', retur: 'retur', lainnya: 'lainnya' };
  for (const [word, status] of Object.entries(statusWords)) {
    if (nMsg.includes(word)) {
      matched = (matched.length ? matched : poItems).filter((p) => p.statusBarang === status);
      note = `Difilter status "${status}". `;
      break;
    }
  }
  if (matched.length > 100) {
    note += `Total ${matched.length} PO cocok, ditampilkan 100 terbaru.`;
    matched = matched.slice(-100);
  }
  return { items: matched, note: note || `${matched.length} PO cocok.` };
}

// "Siapa yang belanja cuma 1x?" — detects which frequency bucket the question means and returns
// that bucket's actual customer name list. Kept as a separate on-demand lookup (not folded into
// the always-included customerInsights) since a bucket can have 100s of names — only worth
// sending when the question is actually asking "who/siapa", not on every unrelated question.
function findCustomerBucketMatch(message, customerBuckets) {
  if (!customerBuckets) return null;
  const nMsg = normText(message);
  if (!/\bsiapa\b|\bnama\b|\bdaftar\b|\blist\b/.test(nMsg)) return null;
  let bucket = null;
  if (/\b1x\b|\bsatu kali\b|\bsekali\b/.test(nMsg)) bucket = '1x';
  else if (/\b2x\b|\bdua kali\b/.test(nMsg)) bucket = '2x';
  else if (/\b(3|tiga)\s*-?\s*(sampai\s*)?(5|lima)\s*x?\b/.test(nMsg)) bucket = '3-5x';
  else if (/\b(5|lima)\s*-?\s*(sampai\s*)?(10|sepuluh)\s*x?\b/.test(nMsg)) bucket = '5-10x';
  else if (/>\s*10x?|\blebih dari 10\b|\bdiatas 10\b/.test(nMsg)) bucket = '>10x';
  if (!bucket || !customerBuckets[bucket]) return null;
  const all = customerBuckets[bucket];
  const sample = [...all].sort((a, b) => b.totalSales - a.totalSales).slice(0, 60);
  return { bucket, totalCustomer: all.length, ditampilkan: sample.length, customers: sample };
}

function detectPersonMention(message, knownNames) {
  const nMsg = normText(message);
  for (const name of knownNames) {
    if (name && name.length >= 3 && nMsg.includes(normText(name))) return name;
  }
  return null;
}

function toIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Attendance / daily-indicator lookup — hits the KPI Apps Script live (not KV-cached, since
// per-day-per-person data is too combinatorial to pre-aggregate and needs to stay fresh for
// "hari ini" questions). Only called when the question actually looks attendance/indicator-related.
// Real actions below were discovered by reading the sister app's own source
// (KPI-Personel-Cabang-Makassar/{rekap-kinerja-tim,input-makassar}.html) — do not guess new
// action names without checking that source first, this endpoint 400s on unknown actions.
// The Apps Script's "evidence" field holds the actual substance behind each indicator — for
// "Follow Up Piutang Customer" it's a JSON array of which customers were contacted and the
// outcome, for delivery/handcarry indicators it's counts/details, etc. It's usually a JSON
// string but not guaranteed, so parse defensively and fall back to the raw text.
function parseEvidence(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function fetchAttendanceContext(message, kpiNames, history) {
  const nMsg = normText(message);
  const wantsAttendance = /jam\s*masuk|jam\s*pulang|jam\s*datang|\btelat\b|terlambat|\babsen\b|absensi|kehadiran/.test(nMsg);
  const wantsIndicator = /indikator|checklist|ceklist|kerjakan|dikerjakan|kegiatan harian|dikerjain|rincikan|rinciannya|detailnya/.test(nMsg);
  let personHit = detectPersonMention(message, kpiNames);
  // Follow-up like "rincikan indikatornya dong" doesn't repeat the name — without this, it fell
  // back to the team-wide MAKASSAR view instead of staying on the person from the prior turn.
  // Scan recent history (most recent first) for the last-mentioned person name.
  if (!personHit && (wantsAttendance || wantsIndicator) && Array.isArray(history)) {
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (!h || !h.text) continue;
      const found = detectPersonMention(h.text, kpiNames);
      if (found) { personHit = found; break; }
    }
  }
  if (!wantsAttendance && !wantsIndicator && !personHit) return null;

  const dateMention = extractDateMention(message);
  const targetDate = dateMention ? new Date(dateMention.year, dateMention.month - 1, dateMention.day) : new Date();
  const isoDay = toIsoDate(targetDate);
  const yearMonth = isoDay.slice(0, 7);

  try {
    if (personHit) {
      const res = await fetch(
        `${KPI_WEBAPP_URL}?action=personView&nama=${encodeURIComponent(personHit)}&month=${yearMonth}`
      );
      const data = await res.json();
      const labels = data?.detail?.labels || [];
      const days = data?.detail?.days || [];
      if (dateMention) {
        const dayEntry = days.find((d) => d.tanggal === isoDay);
        if (!dayEntry) return { nama: personHit, tanggal: isoDay, catatan: 'Tidak ada data untuk tanggal ini (mungkin hari libur atau belum lewat).' };
        return {
          nama: personHit,
          tanggal: isoDay,
          jamDatang: dayEntry.jamDatang || null,
          jamPulang: dayEntry.jamPulang || null,
          submitted: dayEntry.submitted,
          dinas: dayEntry.dinas,
          indikator: labels.map((label, i) => ({
            label,
            tercapai: !!dayEntry.values?.[i],
            detail: parseEvidence(dayEntry.evidence?.[i]),
          })),
        };
      }
      // No specific date — give a recent-days summary instead of the whole month.
      return {
        nama: personHit,
        bulan: yearMonth,
        ringkasan10HariTerakhir: days.slice(-10).map((d) => ({
          tanggal: d.tanggal,
          jamDatang: d.jamDatang || null,
          jamPulang: d.jamPulang || null,
          indikatorTercapai: (d.values || []).filter(Boolean).length,
          totalIndikator: labels.length,
        })),
      };
    }

    // No specific person — team-wide attendance + indicator status for the target date.
    // "config" gives the 10 team indicator LABELS (dayStatus alone only returns bare
    // true/false values with no names, which made answers unreadable) — pair them up.
    const [teamStatus, dayStatus, config] = await Promise.all([
      fetch(`${KPI_WEBAPP_URL}?action=teamStatus&tanggal=${isoDay}`).then((r) => r.json()),
      fetch(`${KPI_WEBAPP_URL}?action=dayStatus&nama=MAKASSAR&tanggal=${isoDay}`).then((r) => r.json()),
      fetch(`${KPI_WEBAPP_URL}?action=config&nama=MAKASSAR`).then((r) => r.json()),
    ]);
    const teamLabels = config?.labels || [];
    const indikatorTim = teamLabels.length
      ? teamLabels.map((label, i) => ({
          label,
          tercapai: !!dayStatus?.values?.[i],
          detail: parseEvidence(dayStatus?.evidence?.[i]),
        }))
      : dayStatus;
    return { tanggal: isoDay, jamMasukPulangTim: teamStatus, indikatorTim };
  } catch (err) {
    return { error: `Gagal mengambil data absensi: ${String(err)}` };
  }
}

// ---- /sync: fetch + aggregate + store compact summaries (+ raw transactions) in KV ----
async function handleSync(request, env) {
  const url = new URL(request.url);
  if (!env.SYNC_TOKEN || url.searchParams.get('token') !== env.SYNC_TOKEN) {
    return json({ error: 'Unauthorized. Pass ?token=<SYNC_TOKEN>.' }, 401);
  }
  return json(await runSync(env));
}

// Actual sync logic, shared by the manual GET /sync (token-protected) and the automatic Cron
// Trigger below — the cron keeps KV fresh on its own schedule so answers don't go stale between
// manual syncs (this is what was actually wrong with the KSFO028 stock question: not a parsing
// bug, just old cached data — the live dashboard "looks always right" only because it re-fetches
// the sheet with no cache on every page load, not because it reads from a different source).
async function runSync(env) {
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
        turnoverMKI: toNumber(r['MKI Turnover']),
        turnoverCFN: toNumber(r['CFN Turnover']),
        turnoverTotal: toNumber(r['MKI & CFN Turnover']),
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
    const byLokasiEkspedisi = {}; // lokasi -> { ekspedisiName -> count } — full data, not a capped sample
    const byKode = {}; // top products: kode -> { amount, qty, amountMKI, amountCFN }
    const byEkspedisiGlobal = {};
    const byCustomer = {}; // frekuensi customer
    const fo1core = { byMonth: {}, byKode: {} };
    const dpStats = {}; // Daily Performance: bulan -> { invoiceAll:Set, invoiceOTD:Set, invoiceNonRetur:Set }
    let sameDayCount = 0;
    let cutOffCount = 0;
    let handCarryCount = 0;
    const transactions = [];
    for (const r of rows) {
      const d = parseFlexibleDate(r['Order Date']);
      const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'unknown';
      const amount = toNumber(r['Amount']);
      const qty = toNumber(r['Quantity']);
      const kode = (r['Kode Barang'] || '').trim();
      const company = (r['Company'] || '').trim().toUpperCase();
      // Uppercase — matches the dashboard's own normalizeGrandData() exactly. Without this,
      // "Ari"/"ARI"/"ari" count as 3 separate customers instead of 1, inflating customer counts
      // (confirmed: 9 case-variant names in the sheet == the exact 283-vs-274 discrepancy found).
      const customer = (r['Customer'] || '').trim().toUpperCase();
      const noInvoice = (r['No Invoice'] || '').trim();
      const stage = (r['Stage'] || '').trim();
      const statusSameCutOff = (r['Status'] || '').trim(); // col H is actually "Same Day / Cut Off" status
      const ekspedisi = (r['Status (Ekspedisi)'] || '').trim();
      const lokasi = (r['Lokasi'] || '').trim();
      const isRetur = /^R[-/]/i.test(noInvoice) || amount < 0;

      if (!byMonth[key]) byMonth[key] = { bulan: key, sales: 0, transaksi: 0 };
      byMonth[key].sales += amount;
      byMonth[key].transaksi += 1;

      // Daily Performance: OTD Accuracy = invoiceUnik(stage=complete AND Same Day) / invoiceUnik(all,
      // retur included). Total Invoice metric = invoiceUnik EXCLUDING retur. Both per-month, matching
      // the live dashboard's exact definitions (see calc.js/render.js renderDpKpiPanel).
      if (noInvoice) {
        if (!dpStats[key]) dpStats[key] = { invoiceAll: new Set(), invoiceOTD: new Set(), invoiceNonRetur: new Set() };
        dpStats[key].invoiceAll.add(noInvoice);
        if (!isRetur) dpStats[key].invoiceNonRetur.add(noInvoice);
        if (stage.toLowerCase() === 'complete' && statusSameCutOff === 'Same Day') dpStats[key].invoiceOTD.add(noInvoice);
      }

      if (lokasi) byLokasi[lokasi] = (byLokasi[lokasi] || 0) + 1;
      if (lokasi && ekspedisi) {
        if (!byLokasiEkspedisi[lokasi]) byLokasiEkspedisi[lokasi] = {};
        byLokasiEkspedisi[lokasi][ekspedisi] = (byLokasiEkspedisi[lokasi][ekspedisi] || 0) + 1;
      }

      if (kode) {
        if (!byKode[kode]) byKode[kode] = { kode, amount: 0, qty: 0, amountMKI: 0, amountCFN: 0 };
        byKode[kode].amount += amount;
        byKode[kode].qty += qty;
        if (company === 'MKI') byKode[kode].amountMKI += amount;
        else if (company === 'CFN') byKode[kode].amountCFN += amount;
      }

      if (/same/i.test(statusSameCutOff)) sameDayCount++;
      else if (/cut/i.test(statusSameCutOff)) cutOffCount++;
      const ekspUpper = ekspedisi.toUpperCase();
      if (ekspUpper.includes('HAND CARRY')) handCarryCount++;
      const ekspLabel = ekspedisi || 'TIDAK TERCATAT';
      byEkspedisiGlobal[ekspLabel] = (byEkspedisiGlobal[ekspLabel] || 0) + 1;

      if (customer) {
        if (!byCustomer[customer]) {
          byCustomer[customer] = { customer, invoices: new Set(), totalSales: 0, frequency: 0, lastPurchase: null };
        }
        const c = byCustomer[customer];
        if (r['No Invoice']) c.invoices.add(r['No Invoice']);
        c.totalSales += amount;
        c.frequency += 1;
        if (d && (!c.lastPurchase || d > c.lastPurchase)) c.lastPurchase = d;
      }

      if (FO_1CORE_CODES.includes(kode)) {
        if (!fo1core.byMonth[key]) fo1core.byMonth[key] = { bulan: key, amount: 0, qty: 0 };
        fo1core.byMonth[key].amount += amount;
        fo1core.byMonth[key].qty += qty;
        if (!fo1core.byKode[kode]) fo1core.byKode[kode] = { kode, amount: 0, qty: 0 };
        fo1core.byKode[kode].amount += amount;
        fo1core.byKode[kode].qty += qty;
      }

      transactions.push({
        tanggal: r['Order Date'],
        invoice: noInvoice,
        customer,
        kode,
        qty,
        amount,
        status: statusSameCutOff,
        stage,
        isRetur,
        company,
        ekspedisi,
        lokasi,
        tglTerkirim: r['Tanggal Terkirim'],
      });
    }
    const performance = Object.values(byMonth).sort((a, b) => a.bulan.localeCompare(b.bulan));
    const totalSales2026 = performance.reduce((s, m) => s + m.sales, 0);
    const dailyPerformanceTargets = Object.entries(dpStats)
      .map(([bulan, s]) => {
        const invoiceUnik = s.invoiceNonRetur.size;
        const invoiceUnikTotal = s.invoiceAll.size;
        const otdPct = invoiceUnikTotal > 0 ? (s.invoiceOTD.size / invoiceUnikTotal) * 100 : 0;
        return {
          bulan,
          invoiceUnik,
          targetInvoice: 280,
          pencapaianInvoicePersen: (invoiceUnik / 280) * 100,
          otdAccuracyPersen: otdPct,
          targetOtdPersen: 80,
          invoiceOTD: s.invoiceOTD.size,
          invoiceUnikTotal,
        };
      })
      .sort((a, b) => a.bulan.localeCompare(b.bulan));
    const topWilayah = Object.entries(byLokasi)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([lokasi, jumlahTransaksi]) => ({ lokasi, jumlahTransaksi }));
    // Complete ekspedisi breakdown per wilayah (all ~100+ locations, not a capped sample) so
    // "ekspedisi ke <wilayah> pakai apa" is always answered from full data, ranked by usage.
    const wilayahEkspedisi = Object.entries(byLokasiEkspedisi).map(([lokasi, ekspMap]) => ({
      lokasi,
      totalTransaksi: byLokasi[lokasi] || 0,
      ekspedisi: Object.entries(ekspMap)
        .sort((a, b) => b[1] - a[1])
        .map(([nama, jumlah]) => ({ nama, jumlah })),
    }));

    const produkList = Object.values(byKode);
    const topProducts = {
      byAmount: [...produkList].sort((a, b) => b.amount - a.amount).slice(0, 20),
      byQty: [...produkList].sort((a, b) => b.qty - a.qty).slice(0, 20),
    };

    // "Transaksi Belum Dikirim" (dashboard Daily Performance > Delivery tab): stage is neither
    // "Complete" nor "Return" — confirmed against real rows (empty stage = still pending).
    const undelivered = transactions
      .filter((tx) => !['complete', 'return'].includes((tx.stage || '').toLowerCase().trim()))
      .sort((a, b) => {
        const da = parseFlexibleDate(a.tanggal);
        const db = parseFlexibleDate(b.tanggal);
        return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
      });

    const delivery = {
      sameDayCount,
      cutOffCount,
      handCarryCount,
      pihakKetigaCount: rows.length - handCarryCount,
      byEkspedisi: Object.entries(byEkspedisiGlobal)
        .sort((a, b) => b[1] - a[1])
        .map(([nama, jumlah]) => ({ nama, jumlah })),
    };

    const now = new Date();
    const customerList = Object.values(byCustomer).map((c) => {
      const daysSince = c.lastPurchase ? Math.floor((now - c.lastPurchase) / 86400000) : null;
      return {
        customer: c.customer,
        invoiceUnik: c.invoices.size,
        totalSales: c.totalSales,
        frequency: c.frequency,
        lastPurchase: c.lastPurchase ? toIsoDate(c.lastPurchase) : null,
        daysSinceLastPurchase: daysSince,
        churned: daysSince !== null && daysSince >= 60,
      };
    });
    const bucketOf = (n) => (n === 1 ? '1x' : n === 2 ? '2x' : n <= 5 ? '3-5x' : n <= 10 ? '5-10x' : '>10x');
    const buckets = {};
    const namesByBucket = {}; // cached separately from customerInsights so "siapa saja" questions
    // don't bloat every OTHER question's context with hundreds of names by default.
    for (const c of customerList) {
      const b = bucketOf(c.invoiceUnik);
      if (!buckets[b]) buckets[b] = { bucket: b, jumlahCustomer: 0, totalSales: 0 };
      buckets[b].jumlahCustomer += 1;
      buckets[b].totalSales += c.totalSales;
      if (!namesByBucket[b]) namesByBucket[b] = [];
      namesByBucket[b].push({ customer: c.customer, totalSales: c.totalSales });
    }
    await env.SHEET_CACHE.put('data:customerBuckets', JSON.stringify(namesByBucket));
    const customerInsights = {
      totalCustomer: customerList.length,
      totalChurned: customerList.filter((c) => c.churned).length,
      buckets: Object.values(buckets),
      topByFrekuensi: [...customerList].sort((a, b) => b.invoiceUnik - a.invoiceUnik).slice(0, 20),
      topBySales: [...customerList].sort((a, b) => b.totalSales - a.totalSales).slice(0, 20),
    };

    const fiberOptic1Core = {
      kodeList: FO_1CORE_CODES,
      monthly: Object.values(fo1core.byMonth).sort((a, b) => a.bulan.localeCompare(b.bulan)),
      perKode: Object.values(fo1core.byKode),
    };

    // Stock movement: "tidak bergerak" (in stock, never sold in 2026) and "terjual dibawah 5
    // unit" (in stock, sold but <5 units) — reuses the stock list this same /sync run already
    // cached, cross-referenced against byKode (already built above from this same tx pass).
    let stockMovement = { totalTidakBergerak: 0, tidakBergerak: [], totalTerjualDibawah5: 0, terjualDibawah5: [] };
    try {
      const stockRaw2 = await env.SHEET_CACHE.get('data:stock');
      const stockItems = stockRaw2 ? JSON.parse(stockRaw2) : [];
      const fullTidakBergerak = stockItems.filter((p) => p.stokTotal > 0 && !byKode[p.kode]);
      const fullDibawah5 = stockItems.filter((p) => p.stokTotal > 0 && byKode[p.kode] && byKode[p.kode].qty > 0 && byKode[p.kode].qty < 5);
      stockMovement = {
        // Explicit true counts — the arrays below are capped at 100 for context size, so Gemini
        // must cite these totals rather than counting (or guessing) the length of a capped list.
        totalTidakBergerak: fullTidakBergerak.length,
        tidakBergerak: fullTidakBergerak.map((p) => ({ kode: p.kode, nama: p.nama, stokTotal: p.stokTotal })).slice(0, 100),
        totalTerjualDibawah5: fullDibawah5.length,
        terjualDibawah5: fullDibawah5
          .map((p) => ({ kode: p.kode, nama: p.nama, stokTotal: p.stokTotal, qtyTerjual2026: byKode[p.kode].qty }))
          .slice(0, 100),
      };
    } catch { /* non-critical, leave empty if this sub-step fails */ }

    await env.SHEET_CACHE.put('data:performance', JSON.stringify({ performance, topWilayah, totalSales2026 }));
    await env.SHEET_CACHE.put('data:transactions', JSON.stringify(transactions));
    await env.SHEET_CACHE.put('data:wilayahEkspedisi', JSON.stringify(wilayahEkspedisi));
    await env.SHEET_CACHE.put('data:topProducts', JSON.stringify(topProducts));
    await env.SHEET_CACHE.put('data:delivery', JSON.stringify(delivery));
    await env.SHEET_CACHE.put('data:customerInsights', JSON.stringify(customerInsights));
    await env.SHEET_CACHE.put('data:fiberOptic1Core', JSON.stringify(fiberOptic1Core));
    await env.SHEET_CACHE.put('data:dailyPerformanceTargets', JSON.stringify(dailyPerformanceTargets));
    await env.SHEET_CACHE.put('data:stockMovement', JSON.stringify(stockMovement));
    await env.SHEET_CACHE.put('data:undelivered', JSON.stringify(undelivered));
    summary.sources.performance = { ok: true, bulanTersimpan: performance.length, baris: rows.length };
    summary.sources.transactions = { ok: true, baris: transactions.length };
    summary.sources.wilayahEkspedisi = { ok: true, wilayah: wilayahEkspedisi.length };
    summary.sources.topProducts = { ok: true, produk: produkList.length };
    summary.sources.delivery = { ok: true };
    summary.sources.customerInsights = { ok: true, customer: customerList.length };
    summary.sources.fiberOptic1Core = { ok: true };
    summary.sources.dailyPerformanceTargets = { ok: true };
    summary.sources.undelivered = { ok: true, jumlah: undelivered.length };
    summary.sources.stockMovement = { ok: true, tidakBergerak: stockMovement.tidakBergerak.length, dibawah5: stockMovement.terjualDibawah5.length };
  } catch (err) {
    summary.sources.performance = { ok: false, error: String(err) };
    summary.sources.transactions = { ok: false, error: String(err) };
    summary.sources.wilayahEkspedisi = { ok: false, error: String(err) };
    summary.sources.topProducts = { ok: false, error: String(err) };
    summary.sources.delivery = { ok: false, error: String(err) };
    summary.sources.customerInsights = { ok: false, error: String(err) };
    summary.sources.fiberOptic1Core = { ok: false, error: String(err) };
    summary.sources.dailyPerformanceTargets = { ok: false, error: String(err) };
    summary.sources.stockMovement = { ok: false, error: String(err) };
    summary.sources.undelivered = { ok: false, error: String(err) };
  }

  // 2b) YoY comparison (Sales SUM sheet, columns AS-BB / absolute index 44-53). Row 0 is a
  // section title not January, so each month is matched by its NAME in col AS, not row position.
  try {
    const csv = await (await fetch(csvExportUrl(PERFORMANCE_SHEET_ID, GIDS.salesSum))).text();
    const allRows = parseCsv(csv);
    const MONTH_NAMES_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const MONTH_NAMES_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const IDX = { AS: 44, AT: 45, AV: 47, AX: 49, AZ: 51, BB: 53 };
    const months = MONTH_NAMES_EN.map((monthName, m) => {
      const row = allRows.find((r) => (r[IDX.AS] || '').toLowerCase() === monthName.toLowerCase());
      if (!row) return { monthIdx: m, label: MONTH_NAMES_ID[m], targetSalesRevenue: 0, rev2025: 0, rev2026: 0, sales2025: 0, sales2026: 0 };
      return {
        monthIdx: m,
        label: MONTH_NAMES_ID[m],
        targetSalesRevenue: toNumber(row[IDX.AT]),
        rev2025: toNumber(row[IDX.AV]),
        rev2026: toNumber(row[IDX.AX]),
        sales2025: toNumber(row[IDX.AZ]),
        sales2026: toNumber(row[IDX.BB]),
      };
    });
    const totalSales2025 = months.reduce((s, m) => s + m.sales2025, 0);
    const totalSales2026yoy = months.reduce((s, m) => s + m.sales2026, 0);
    const totalRev2025 = months.reduce((s, m) => s + m.rev2025, 0);
    const totalRev2026 = months.reduce((s, m) => s + m.rev2026, 0);
    const totalTarget = months.reduce((s, m) => s + m.targetSalesRevenue, 0);
    const growthPct = (curr, prev) => (prev > 0 ? ((curr - prev) / prev) * 100 : null);
    await env.SHEET_CACHE.put(
      'data:yoy',
      JSON.stringify({
        months,
        totalSales2025,
        totalSales2026: totalSales2026yoy,
        totalRev2025,
        totalRev2026,
        totalTarget,
        growthSalesPersen: growthPct(totalSales2026yoy, totalSales2025),
        growthRevPersen: growthPct(totalRev2026, totalRev2025),
        achievementSalesPersen: totalTarget > 0 ? (totalSales2026yoy / totalTarget) * 100 : null,
        achievementRevPersen: totalTarget > 0 ? (totalRev2026 / totalTarget) * 100 : null,
      })
    );
    summary.sources.yoy = { ok: true, bulan: months.length };
  } catch (err) {
    summary.sources.yoy = { ok: false, error: String(err) };
  }

  // 2c) Zona Wilayah (KPI MONITORING sheet, columns M-Z: NAMA at col M/idx12, Jan..Des at
  // idx13-24, TOTAL at idx25 — gviz types these numeric so header text never surfaces as object
  // keys, hence positional access). Zone thresholds + province grouping copied from calc.js.
  try {
    const csv = await (await fetch(csvExportUrl(PERFORMANCE_SHEET_ID, GIDS.kpiMonitor))).text();
    const allRows = parseCsv(csv);
    const NAMA_IDX = 12;
    const MONTH_START_IDX = 13;
    const TOTAL_IDX = 25;
    const MONTH_NAMES_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    const wilayahData = [];
    for (const r of allRows) {
      const nama = (r[NAMA_IDX] || '').trim();
      if (!nama || !/^[A-Za-z]/.test(nama)) continue;
      const total = toNumber(r[TOTAL_IDX]);
      const monthly = MONTH_NAMES_ID.map((label, i) => ({ label, invoice: toNumber(r[MONTH_START_IDX + i]) }));
      wilayahData.push({ nama, monthly, total, zone: zoneOf(total) });
    }
    const tanpaPembelanjaan = wilayahData.filter((w) => w.total === 0).map((w) => w.nama);
    const byProvince = {};
    for (const w of wilayahData) {
      const code = WILAYAH_TO_PROVINCE[w.nama];
      if (!code) continue;
      if (!byProvince[code]) byProvince[code] = { code, total: 0, wilayahCount: 0 };
      byProvince[code].total += w.total;
      byProvince[code].wilayahCount += 1;
    }
    Object.values(byProvince).forEach((p) => { p.zone = zoneOf(p.total); });
    await env.SHEET_CACHE.put(
      'data:zonaWilayah',
      JSON.stringify({
        wilayah: wilayahData.sort((a, b) => b.total - a.total),
        tanpaPembelanjaan,
        provinsi: Object.values(byProvince).sort((a, b) => b.total - a.total),
      })
    );
    summary.sources.zonaWilayah = { ok: true, wilayah: wilayahData.length };
  } catch (err) {
    summary.sources.zonaWilayah = { ok: false, error: String(err) };
  }

  // 2d) Revenue (Rev SUM) — this is DIFFERENT from Sales (Grand Data Amount): Revenue is actual
  // cash collected ("Pelunasan"), Sales is order value at invoice time. Only columns A-E are
  // real data — later columns repeat the same header names for a recap block (would silently
  // collide if read by name), so this sheet is read by fixed position: 0 Payment Date,
  // 1 No Faktur, 2 Customer, 3 Pelunasan, 4 Company.
  try {
    const csv = await (await fetch(csvExportUrl(PERFORMANCE_SHEET_ID, GIDS.revSum))).text();
    const allRows = parseCsv(csv).slice(1);
    const byMonth = {};
    const detail = []; // per-payment records — needed for "kapan X terakhir BAYAR" (payment != sale)
    for (const r of allRows) {
      if (!r[1]) continue; // No Faktur empty = past the real data block
      const d = parseFlexibleDate(r[0]);
      const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'unknown';
      const amount = toNumber(r[3]);
      if (!byMonth[key]) byMonth[key] = { bulan: key, revenue: 0, pembayaran: 0 };
      byMonth[key].revenue += amount;
      byMonth[key].pembayaran += 1;
      detail.push({ tanggal: r[0], noFaktur: r[1], customer: (r[2] || '').trim().toUpperCase(), amount, company: r[4] });
    }
    const monthly = Object.values(byMonth).sort((a, b) => a.bulan.localeCompare(b.bulan));
    const total2026 = monthly.reduce((s, m) => s + m.revenue, 0);
    await env.SHEET_CACHE.put('data:revenue', JSON.stringify({ monthly, total2026, detail }));
    summary.sources.revenue = { ok: true, bulan: monthly.length, pembayaran: detail.length };
  } catch (err) {
    summary.sources.revenue = { ok: false, error: String(err) };
  }

  // 2c) PO Gudang (incoming supplier purchase orders). Only columns A-K are real/used by the
  // live dashboard — a second block from column M onward exists in the raw sheet but is dead
  // data (confirmed unused anywhere), so it's ignored here too.
  try {
    const csv = await (await fetch(csvExportUrl(PERFORMANCE_SHEET_ID, GIDS.poGudang))).text();
    const rows = rowsToObjects(parseCsv(csv), 0);
    const byStatus = {};
    const byMonth = {};
    const items = [];
    for (const r of rows) {
      if (!r['NO PO']) continue;
      const stage = (r['Stage'] || '').trim().toLowerCase();
      const noSuratJalan = (r['NO Surat Jalan'] || '').trim();
      const statusEkspedisi = (r['Status (Ekspedisi)'] || '').trim();
      const qtyPesan = toNumber(r['Quantity']);
      const qtyDiterima = toNumber(r['Quantity Diterima (GD MKS)']);
      let statusBarang;
      if (stage === 'complete') statusBarang = 'diterima';
      else if (stage === 'return') statusBarang = 'retur';
      else if (!stage && !noSuratJalan && !statusEkspedisi) statusBarang = 'ditunggu';
      else statusBarang = 'lainnya';

      if (!byStatus[statusBarang]) byStatus[statusBarang] = { status: statusBarang, jumlahPO: 0, qtyPesan: 0, qtyDiterima: 0 };
      byStatus[statusBarang].jumlahPO += 1;
      byStatus[statusBarang].qtyPesan += qtyPesan;
      byStatus[statusBarang].qtyDiterima += qtyDiterima;

      const d = parseFlexibleDate(r['Order Date']);
      const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'unknown';
      if (!byMonth[key]) byMonth[key] = { bulan: key, jumlahPO: 0, qtyPesan: 0 };
      byMonth[key].jumlahPO += 1;
      byMonth[key].qtyPesan += qtyPesan;

      items.push({
        tanggal: r['Order Date'],
        noPO: r['NO PO'],
        company: r['COMPANY'],
        kode: r['Kode Barang'],
        qtyPesan,
        qtyDiterima,
        statusBarang,
        tanggalMasukGudang: r['Tanggal Masuk GD MKS'],
      });
    }
    await env.SHEET_CACHE.put(
      'data:poGudang',
      JSON.stringify({
        byStatus: Object.values(byStatus),
        monthly: Object.values(byMonth).sort((a, b) => a.bulan.localeCompare(b.bulan)),
        items,
      })
    );
    summary.sources.poGudang = { ok: true, baris: items.length };
  } catch (err) {
    summary.sources.poGudang = { ok: false, error: String(err) };
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
    const detail = []; // per-invoice rows — needed for "piutang customer X" lookups
    let totalPiutang = 0;
    let rowCount = 0;
    for (const r of allRows) {
      if (!r[12]) continue; // stop counting once the compacted L-S list runs out (No Faktur empty)
      rowCount++;
      const kategori = (r[17] || r[16] || 'Tidak diketahui').trim();
      const nilai = toNumber(r[15]);
      const customer = (r[13] || '').trim().toUpperCase(); // matches dashboard's buildAR() normalization
      totalPiutang += nilai;
      if (!byKategori[kategori]) byKategori[kategori] = { kategori, jumlahInvoice: 0, totalNilai: 0 };
      byKategori[kategori].jumlahInvoice += 1;
      byKategori[kategori].totalNilai += nilai;
      detail.push({ tanggal: r[11], noFaktur: r[12], customer, nilaiSisa: nilai, kategori });
    }
    // Ratio AR-to-sales needs total 2026 sales, already computed and cached above in this
    // same /sync run — read it back rather than re-deriving from a second data pass.
    const perfCached = await env.SHEET_CACHE.get('data:performance');
    const totalSales2026 = perfCached ? JSON.parse(perfCached).totalSales2026 : 0;
    const ratioARtoSales = totalSales2026 ? (totalPiutang / totalSales2026) * 100 : null;
    await env.SHEET_CACHE.put(
      'data:piutang',
      JSON.stringify({ totalPiutang, byKategori: Object.values(byKategori), ratioARtoSales, detail })
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
  return summary;
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

  const [
    stockRaw, perfRaw, piutangRaw, kpiRaw, txRaw, wilayahRaw,
    revenueRaw, poGudangRaw, topProductsRaw, deliveryRaw, customerInsightsRaw, fo1coreRaw,
    yoyRaw, zonaWilayahRaw, dailyPerformanceRaw, stockMovementRaw, undeliveredRaw, customerBucketsRaw,
    lastSync,
  ] = await Promise.all([
    env.SHEET_CACHE.get('data:stock'),
    env.SHEET_CACHE.get('data:performance'),
    env.SHEET_CACHE.get('data:piutang'),
    env.SHEET_CACHE.get('data:kpi'),
    env.SHEET_CACHE.get('data:transactions'),
    env.SHEET_CACHE.get('data:wilayahEkspedisi'),
    env.SHEET_CACHE.get('data:revenue'),
    env.SHEET_CACHE.get('data:poGudang'),
    env.SHEET_CACHE.get('data:topProducts'),
    env.SHEET_CACHE.get('data:delivery'),
    env.SHEET_CACHE.get('data:customerInsights'),
    env.SHEET_CACHE.get('data:fiberOptic1Core'),
    env.SHEET_CACHE.get('data:yoy'),
    env.SHEET_CACHE.get('data:zonaWilayah'),
    env.SHEET_CACHE.get('data:dailyPerformanceTargets'),
    env.SHEET_CACHE.get('data:stockMovement'),
    env.SHEET_CACHE.get('data:undelivered'),
    env.SHEET_CACHE.get('data:customerBuckets'),
    env.SHEET_CACHE.get('lastSync'),
  ]);

  const allStock = stockRaw ? JSON.parse(stockRaw) : [];
  const allTransactions = txRaw ? JSON.parse(txRaw) : [];
  const allWilayahEkspedisi = wilayahRaw ? JSON.parse(wilayahRaw) : [];
  const piutangData = piutangRaw ? JSON.parse(piutangRaw) : null;
  const kpiData = kpiRaw ? JSON.parse(kpiRaw) : null;
  const poGudangData = poGudangRaw ? JSON.parse(poGudangRaw) : null;
  const zonaWilayahData = zonaWilayahRaw ? JSON.parse(zonaWilayahRaw) : null;
  const stokMatch = findStockMatches(message, allStock);
  const txMatch = findTransactionMatches(message, allTransactions);
  const wilayahMatch = findWilayahMatches(message, allWilayahEkspedisi);
  const piutangMatch = findPiutangByCustomer(message, piutangData?.detail);
  const revenueData = revenueRaw ? JSON.parse(revenueRaw) : null;
  const paymentMatch = findPaymentsByCustomer(message, revenueData?.detail);
  const poMatch = findPoGudangMatches(message, poGudangData?.items);
  const zonaMatch = findZonaWilayahMatches(message, zonaWilayahData);
  const customerBucketMatch = findCustomerBucketMatch(message, customerBucketsRaw ? JSON.parse(customerBucketsRaw) : null);
  const referensi = matchReferences(message);
  const kpiNames = Array.isArray(kpiData?.kpi) ? kpiData.kpi.map((p) => p.nama).filter(Boolean) : [];
  const absensi = await fetchAttendanceContext(message, kpiNames, history);

  const context = {
    // "performa" = SALES (order value from Grand Data 2026). "revenue" = actual cash collected
    // (Rev SUM "Pelunasan") — these are different metrics per the dashboard, don't conflate them.
    performa: perfRaw ? JSON.parse(perfRaw) : null,
    // Only the compact monthly totals go in by default — the full per-payment detail is never
    // sent wholesale, only the customer-matched subset via pembayaranRelevan.
    revenue: revenueData ? { monthly: revenueData.monthly, total2026: revenueData.total2026 } : null,
    pembayaranRelevan: paymentMatch,
    // Only the compact totals go in by default — the 189-row invoice detail is never sent
    // wholesale, only the customer-matched subset via piutangRelevan (keeps every other
    // question's context small, same principle as stock/transactions retrieval).
    piutang: piutangData
      ? { totalPiutang: piutangData.totalPiutang, byKategori: piutangData.byKategori, ratioARtoSalesPersen: piutangData.ratioARtoSales }
      : null,
    piutangRelevan: piutangMatch,
    kpiPersonel: kpiData,
    stokRelevan: stokMatch.items,
    stokCatatan: stokMatch.note,
    transaksiRelevan: txMatch.items,
    transaksiCatatan: txMatch.note,
    wilayahEkspedisiRelevan: wilayahMatch,
    topProduk: topProductsRaw ? JSON.parse(topProductsRaw) : null,
    deliveryOverview: deliveryRaw ? JSON.parse(deliveryRaw) : null,
    poGudangRingkasan: poGudangData ? { byStatus: poGudangData.byStatus, monthly: poGudangData.monthly } : null,
    poGudangRelevan: poMatch.items,
    poGudangCatatan: poMatch.note,
    customerInsights: customerInsightsRaw ? JSON.parse(customerInsightsRaw) : null,
    daftarNamaCustomerPerBucket: customerBucketMatch,
    fiberOptic1Core: fo1coreRaw ? JSON.parse(fo1coreRaw) : null,
    perbandinganTahunSebelumnya: yoyRaw ? JSON.parse(yoyRaw) : null,
    zonaWilayahRelevan: zonaMatch,
    targetPerformaHarianBulanan: dailyPerformanceRaw ? JSON.parse(dailyPerformanceRaw) : null,
    stokTidakBergerakDanKurangLaku: stockMovementRaw ? JSON.parse(stockMovementRaw) : null,
    transaksiBelumDikirim: undeliveredRaw ? JSON.parse(undeliveredRaw) : null,
    referensiLink: referensi,
    absensiDanIndikatorHarian: absensi,
  };

  const systemPrompt = `Kamu adalah "MIRA" (Makassar Intelligent Response Assistant), asisten AI internal untuk cabang Makassar PT. Mitra Kabel Indonesia. Kamu punya dua peran: (1) rekan bicara untuk dashboard "Kinerja Cabang Makassar" — bisa menjawab apapun yang bisa dilihat di dashboard itu (performa harian, sales, revenue, wilayah, stok & PO, delivery, piutang, frekuensi customer, KPI personel, dll); (2) membantu pelanggan/teknisi memahami spesifikasi, tutorial, dan informasi produk jaringan (fiber optik, LAN, coaxial, HFC, OLT/ONU, media converter, access point, dll) dari katalog Falcom Technology. Jawab HANYA berdasarkan DATA KONTEKS di bawah ini dan histori percakapan sebelumnya.

Aturan:
- Jika data yang ditanyakan tidak ada di konteks, katakan terus terang tidak tahu / datanya belum tersedia — jangan mengarang angka.
- User sering salah ketik (typo 1-2 huruf), menyingkat kata, atau menulis kode barang dengan/tanpa spasi/strip (mis. "DKB180", "DKB-180", "DKB 180" adalah kode yang SAMA) — pahami maksudnya, jangan langsung bilang "tidak ditemukan".
- Jika user bertanya jumlah spesifik (mis. "10 wilayah penjualan terbesar", "5 customer terbanyak"), berikan SEMUA item yang diminta sesuai jumlah tersebut jika datanya tersedia di konteks, jangan dipotong.
- PENTING — TIGA hal ini BEDA, jangan pernah dicampur:
  1. **PENJUALAN/SALES** = transaksi ke customer (Grand Data, field "transaksiRelevan"/"performa") — kapan customer ORDER/beli.
  2. **PEMBAYARAN/PELUNASAN** = uang yang BENAR-BENAR masuk dari customer (Rev SUM, field "pembayaranRelevan"/"revenue") — BEDA dari tanggal order, seorang customer bisa order duluan lalu bayar belakangan (atau sebaliknya bayar dulu untuk order lama). Kalau user tanya "kapan X bayar/lunas/pembayaran terakhir", WAJIB pakai "pembayaranRelevan" — JANGAN jawab pakai tanggal transaksi/order dari "transaksiRelevan", itu beda hal.
  3. **PO GUDANG** = pembelian stok dari SUPPLIER ke gudang kita (bukan dari customer) — HANYA relevan kalau user secara eksplisit menulis "PO" atau "PO Gudang" dalam pertanyaannya. Kalau user tanya "pembelian"/"pemesanan" TANPA menyebut "PO" secara eksplisit, itu KEMUNGKINAN BESAR maksudnya penjualan ke customer (poin 1), BUKAN PO Gudang — jangan otomatis anggap "pembelian" = PO Gudang.
  Rasio Sales-ke-Revenue = revenue/sales*100 per bulan, hitung sendiri dari kedua array bulanan itu kalau ditanya.
- Untuk pertanyaan stok/ketersediaan barang, gunakan "stokRelevan". Jawab SINGKAT: cukup jumlah stok per company (MKI/CFN) + total, TANPA menyebut turnover/perputaran gudang kecuali user SPESIFIK menanyakan turnover/perputaran. Field "stokCatatan" menjelaskan filter yang dipakai (untuk konteksmu sendiri, tidak perlu disebut ke user).
- Untuk pertanyaan tanggal tertentu, KODE BARANG spesifik ("siapa pembeli terakhir KODE", "kapan KODE terakhir keluar"), atau nama customer spesifik ("kapan si X belanja terakhir, beli apa saja"), gunakan "transaksiRelevan" — field "ekspedisi" dan "company" tiap baris menunjukkan cara pengiriman. Baca "transaksiCatatan": kalau bilang "diurutkan dari yang PALING BARU", maka baris PERTAMA di array = transaksi TERAKHIR/TERBARU — pakai itu untuk jawab pertanyaan "terakhir/kapan".
- Untuk pertanyaan PIUTANG (sisa tagihan yang BELUM dibayar) customer tertentu, WAJIB gunakan "piutangRelevan" (rincian per invoice) — field umum "piutang" cuma total per kategori umur + "ratioARtoSalesPersen", TIDAK punya rincian per customer. Ini beda dari "pembayaranRelevan" (uang yang SUDAH masuk) — piutang = belum bayar, pembayaran = sudah bayar.
- Untuk pertanyaan "ekspedisi ke wilayah X pakai apa", WAJIB gunakan "wilayahEkspedisiRelevan" (lengkap, terurut dari paling sering) — JANGAN pakai transaksiRelevan untuk ini. Untuk pertanyaan ekspedisi SECARA UMUM (bukan per wilayah, mis. "berapa banyak pakai hand carry", "ekspedisi apa yang paling sering dipakai", "berapa yang same day"), gunakan "deliveryOverview" (sameDayCount, cutOffCount, handCarryCount, pihakKetigaCount, byEkspedisi).
- Untuk "produk paling laku/terlaris", gunakan "topProduk" (byAmount = berdasarkan nilai rupiah, byQty = berdasarkan jumlah unit, sudah top-20).
- Untuk "kabel 1 core"/"fiber optic 1 core" secara spesifik sebagai section dashboard, gunakan "fiberOptic1Core" (5 kode resmi: KSFO028, KSFO108, KSFO083, KSFO113, KSFO128, dengan tren bulanan & per kode) — untuk pencarian stok kabel 1-core secara umum tetap pakai "stokRelevan".
- Untuk pertanyaan PO Gudang (HANYA kalau user eksplisit tulis "PO"/"PO Gudang" — lihat aturan di atas), gunakan "poGudangRingkasan" (ringkasan per status: ditunggu/diterima/retur/lainnya + tren bulanan) untuk pertanyaan umum, atau "poGudangRelevan" (sudah difilter kode/status, field "poGudangCatatan" menjelaskan filternya) untuk pertanyaan spesifik.
- Untuk "frekuensi customer", "customer paling sering belanja", atau "customer churn/tidak aktif", gunakan "customerInsights" (totalCustomer, totalChurned = tidak beli >=60 hari, buckets = pengelompokan berdasar jumlah invoice unik, topByFrekuensi, topBySales).
- Untuk pertanyaan "SIAPA saja" customer di suatu bucket frekuensi (mis. "siapa yang belanja cuma 1x"), gunakan "daftarNamaCustomerPerBucket" — kalau null padahal user tanya "siapa", berarti bucket-nya tidak terdeteksi dari pertanyaan, minta user sebutkan lebih spesifik (1x/2x/3-5x/5-10x/lebih dari 10x). Kalau "ditampilkan" < "totalCustomer", sebutkan bahwa itu sebagian (urut dari nilai belanja terbesar), bukan semuanya.
- Untuk perbandingan tahun ini vs tahun lalu ("pertumbuhan dibanding 2025", "naik/turun berapa persen dari tahun lalu"), gunakan "perbandinganTahunSebelumnya" (sales2025/sales2026, rev2025/rev2026 per bulan+total, growthSalesPersen, growthRevPersen, achievementSalesPersen/achievementRevPersen terhadap target tahunan).
- Untuk "zona wilayah" (merah/kuning/hijau berdasar jumlah invoice, BEDA dari topik ekspedisi), "wilayah tanpa pembelanjaan", atau zona per provinsi, gunakan "zonaWilayahRelevan". Zona: hijau jika total invoice >50, kuning jika 20-50, merah jika <20.
- Untuk target & pencapaian performa harian/bulanan (target invoice 280/bulan, target OTD/On-Time-Delivery 80%), gunakan "targetPerformaHarianBulanan" per bulan (invoiceUnik, pencapaianInvoicePersen, otdAccuracyPersen).
- Untuk "stok tidak bergerak/tidak laku" atau "produk terjual di bawah 5 unit", gunakan "stokTidakBergerakDanKurangLaku" (tidakBergerak = stok ada tapi 0 terjual sepanjang 2026, terjualDibawah5 = terjual tapi kurang dari 5 unit).
- Untuk pertanyaan "customer/barang yang belum dikirim/belum diantar/belum terkirim", gunakan "transaksiBelumDikirim" (daftar lengkap transaksi tahun 2026 yang statusnya masih pending, belum "Complete" dan belum "Return") — sebutkan nama customer, kode barang, dan tanggal order-nya.
- Pahami Bahasa Indonesia informal/sehari-hari dan istilah daerah (mis. "gimana" = "bagaimana", "kemarin" = hari sebelum ini, "pake"/"pakai" = sama). Jangan kaku pada ejaan baku.
- Gunakan HISTORI PERCAKAPAN untuk memahami pertanyaan lanjutan yang tidak lengkap sendiri, contoh: "kalau revenue-nya?", "bulan lalu gimana?", "itu belanja apa lagi?" — kaitkan dengan topik/entitas yang dibahas sebelumnya.
- Kamu JUGA membantu pelanggan/teknisi memahami SPESIFIKASI, TUTORIAL, dan INFORMASI PRODUK JARINGAN (fiber optik, LAN, coaxial, HFC, OLT/ONU, media converter, access point, dll) dari katalog Falcom Technology. Untuk topik ini, field "referensiLink" berisi kandidat link yang SUDAH dicocokkan otomatis dari kata kunci pertanyaan — gunakan HANYA link dari situ, JANGAN PERNAH mengarang URL lain:
  - Pertanyaan SPESIFIKASI produk → sertakan link dari "kategoriProduk" (kategori terkait).
  - Pertanyaan solusi sistem (FTTH, HFC, dll) → sertakan link dari "solusiSistem".
  - Pertanyaan TUTORIAL/cara pasang/cara pakai/troubleshooting → sertakan link dari "tutorialDanDukungan" (Bantuan & Dukungan, Kelas Pelatihan FTTX, Galeri Video, Channel YouTube).
  - Pertanyaan artikel/berita teknis → sertakan link dari "artikel".
  - Jika "videoTutorialRelevan" berisi entri (video YouTube spesifik yang cocok dengan kata kunci pertanyaan), WAJIB sertakan sebagai "🎥 Tonton tutorialnya:" — ini lebih spesifik/diutamakan daripada link kategori umum. Kalau kosong tapi topiknya masih seputar produk yang sama, arahkan ke kategori produk terkait (JANGAN pilih video acak dari luar daftar).
  - "videoKegiatanFalcom" hanya untuk pertanyaan soal kegiatan/berita/event Falcom (bukan teknis produk) — pakai kalau ada isinya.
  - Kalau semuanya kosong tapi jelas ini pertanyaan spek produk tanpa kategori yang cocok → pakai "fallbackUmum" (Semua Produk/Kontak).
  - Kalau kamu tidak yakin dengan detail spesifikasi teknis suatu produk (bukan dari data konteks), katakan jujur "[perlu verifikasi lebih lanjut]" lalu arahkan ke link terkait — jangan menebak angka spesifikasi.
  - JANGAN menyalin/merangkai ulang isi halaman secara panjang (hak cipta) — cukup 1-3 kalimat ringkasan, lalu arahkan ke link untuk detail lengkap.
  - Sertakan URL APA ADANYA (utuh, bisa diklik, jangan dipotong). Format baris link di akhir jawaban: "🔗 Info lengkap: [Nama Halaman] — (URL)" — kalau lebih dari satu, buat daftar bullet, MAKSIMAL 3 link per jawaban.
  - Field ini TIDAK relevan untuk pertanyaan operasional (sales/stok/piutang/dll) — jangan sisipkan link produk ke jawaban yang tidak memintanya.
- Untuk pertanyaan jam masuk/pulang karyawan atau isi indikator harian personel, gunakan "absensiDanIndikatorHarian". Jika berisi "jamMasukPulangTim" itu data satu tim untuk satu tanggal (per orang: datang/pulang true-false + jamDatang/jamPulang, dan field ...Ok menandakan apakah role tsb secara keseluruhan tepat waktu). Jika berisi "indikator" (array label + tercapai true/false + detail) — field "detail" berisi BUKTI/RINCIAN NYATA di balik indikator itu (mis. untuk "Follow Up Piutang Customer" detail-nya adalah daftar nama customer yang dihubungi, saldo piutang, dan hasil follow up-nya; untuk indikator delivery/handcarry berisi rincian invoice/barang). WAJIB pakai "detail" ini kalau user bertanya SPESIFIK tentang isi/rincian suatu indikator (mis. "customer siapa saja yang di-follow up", "barang apa yang di-handcarry") — jangan cuma bilang "tercapai (YA)" tanpa rinciannya kalau datanya ada. Jika null/kosong padahal user jelas bertanya soal ini, katakan datanya tidak ditemukan (mungkin nama salah ketik, atau tanggalnya di luar rentang).
- Jawab singkat, padat, dan langsung ke angka/fakta. Gunakan Bahasa Indonesia sehari-hari yang sopan.
- FORMAT: JANGAN pakai tanda bintang tunggal (*kata*) untuk penekanan biasa — itu bikin tampilan penuh tanda bintang yang mengganggu. Pakai bintang ganda (**angka penting**) SEPERLUNYA saja, hanya untuk angka kunci atau nama entitas utama dalam jawaban — bukan untuk kata biasa seperti "sales", "revenue", "pending", "catatan", dll. Sisanya tulis sebagai teks polos.
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

  // Cron Trigger (see wrangler.toml [triggers]) — keeps KV fresh automatically so answers don't
  // go stale between manual /sync calls.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env));
  },
};
