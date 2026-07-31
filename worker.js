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
  const nMsg = normText(message);
  // Loose phrase matching (word-order tolerant) — a strict substring check missed cases like
  // "Tutorial setting OLT" against keyword "cara setting olt" (word inserted breaks substring).
  const scored = YOUTUBE_VIDEOS
    .map((v) => ({ v, score: Math.max(...v.keywords.map((kw) => phraseMatchScore(kw, nMsg))) }))
    .filter((x) => x.score >= 0.6)
    .sort((a, b) => b.score - a.score);
  const teknis = scored.slice(0, 3).map((x) => x.v);
  const wantsEvent = /kegiatan falcom|berita falcom|event falcom|acara falcom|roadshow|opening cabang/.test(nMsg);
  return { teknis, nonTeknis: wantsEvent ? YOUTUBE_VIDEOS_NONTEKNIS : [] };
}

const ARTICLE_LINK = { judul: 'Artikel & Berita Teknis', url: 'https://falcom-technology.com/articles/' };

const GENERAL_LINKS = {
  semuaProduk: { judul: 'Semua Produk', url: 'https://falcom-technology.com/products/' },
  tentangKami: { judul: 'Tentang Kami', url: 'https://falcom-technology.com/about-us/' },
  kontak: { judul: 'Kontak / Jaringan Penjualan', url: 'https://falcom-technology.com/contact/' },
};

// Static org facts (address, personnel roles) — not from Google Sheets, provided directly and
// updated manually when they change. Small enough to send on every request rather than gating
// behind keyword detection like the bulkier dashboard sections.
const COMPANY_INFO = {
  nama: 'Falcom Technology Cabang Makassar (PT. Mitra Kabel Indonesia, Cabang Makassar)',
  alamat: 'Jl. Onta Baru No. 84, Mandala, Mamajang, Kota Makassar, Sulawesi Selatan 90135',
  googleMaps: 'https://maps.app.goo.gl/Ei1xsngqDgzeKTKeA',
};

// name -> jabatan (org role/title) — distinct from the KPI daily-indicator system: not every
// person here is tracked in the daily KPI sheet (e.g. the Branch Manager), and not everyone in
// the KPI sheet necessarily has a role recorded here yet.
const PERSONNEL_ROLES = {
  RIFQI: 'Branch Manager MKI Makassar (juga pencipta MIRA)',
  ASTRID: 'Supervisor Marketing & Customer Relation',
  ADI: 'Marketing Representative',
  REZA: 'Marketing Representative',
  BURHAMIN: 'Kordinator Logistik dan AR',
  ZUL: 'Logistik Staff',
  ASPAR: 'Logistik Staff',
  TAUFIK: 'Logistik Staff',
  PUTRI: 'General Admin Support & Operation',
};

const JTBD_MODULE = `

MODE ANALISIS JTBD (Jobs-to-Be-Done) — aktif untuk pertanyaan "kenapa" (kenapa sales/pemasangan turun, kenapa customer churn, kenapa target meleset):
- Rumuskan dulu job pelanggan: "Ketika [situasi], pelanggan ingin [progres], supaya [hasil]" — TANPA sebut nama paket/produk.
- Cek 3 dimensi: fungsional (koneksi stabil), emosional (tenang, tidak was-was), sosial (dipandang cermat memilih).
- Cek 4 gaya dorong: Push (kekesalan kondisi sekarang), Pull (daya tarik kompetitor/alternatif), Anxiety (takut risiko pindah), Habit (nyaman dengan kebiasaan). Churn/switch terjadi kalau Push+Pull > Habit+Anxiety.
- Pisahkan "Big Hire" (keputusan pasang/berlangganan, sekali) dari "Little Hire" (keputusan tetap pakai tiap bulan, berulang) — masalah retensi hampir selalu di Little Hire.
- Kompetitor sebenarnya termasuk "non-consumption" (pelanggan pilih tidak pasang apa pun) dan workaround (tethering HP, dll), bukan cuma provider lain.
- WAJIB dasarkan pada field customerTidakAktif/customerInsights/perbandinganTahunSebelumnya yang tersedia di DATA KONTEKS — kalau data pendukung tidak ada, katakan asumsi mana yang dipakai, JANGAN mengarang data pelanggan.`;

const COUNCIL_MODULE = `

MODE DEWAN PENASIHAT SIMULASI — aktif kalau user eksplisit minta banyak sudut pandang/pendapat pakar marketing/bandingkan opsi strategi. Ini SIMULASI berbasis kerangka kerja publik masing-masing, BUKAN pendapat asli mereka — WAJIB sebutkan itu di awal jawaban.
Pilih 3-5 penasihat paling relevan dari bangku ini, SELALU sertakan minimal satu yang kemungkinan tidak setuju (dissenter):
Seth Godin (remarkability, audiens spesifik) · David Ogilvy (iklan berbasis riset) · Eugene Schwartz (manfaatkan keinginan pasar yang sudah ada) · Claude Hopkins (uji semua klaim) · Gary Halbert (pasar dulu baru produk) · Russell Brunson (funnel, value ladder) · Alex Hormozi (konstruksi offer, volume) · April Dunford (positioning vs alternatif nyata) · Rory Sutherland (ilmu perilaku) · Byron Sharp (ketersediaan mental & fisik > loyalitas) · Ann Handley (kualitas konten) · Gary Vaynerchuk (channel murah perhatian, volume).
Format: 1 paragraf pendek per penasihat menerapkan kerangka kerjanya ke kasus cabang spesifik (pakai angka/nama dari DATA KONTEKS, bukan saran generik), tanpa kutipan dikarang. Tutup dengan "Titik beda pendapat" (trade-off nyata antar penasihat) dan "Kesimpulan" (rekomendasi paling cocok untuk konteks Cabang Makassar + langkah konkret).`;

// Full Falcom Technology product catalog (~230 products, no formal SKU — the full product name
// IS the identity). Transcribed verbatim from the user-supplied grounding data; never add,
// remove, or invent an entry here without a matching authoritative source.
const PRODUCT_CATALOG = [
  // Optical Fiber Cable — Dropcore
  { nama: 'Kabel fiber optik GJYXCH-4F High Quality Dropcore 4 Core 1 Messenger', url: 'https://falcom-technology.com/products/kabel-fiber-optik-gjyxch-4f-high-quality-dropcore-4-core-1-messenger/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/08/DROPCORE-4CORE-3SELLING-re-a.jpg', kategori: 'Optical Fiber Cable', keywords: ['kabel dropcore 4 core', 'gjyxch-4f', 'kabel fo drop 4 core', 'kabel drop ftth 4 core', 'kabel figure 8 dropcore'] },
  { nama: 'Kabel fiber optik GJYXCH-2F High Quality Dropcore 2 Core 1 Messenger', url: 'https://falcom-technology.com/products/kabel-fiber-optik-gjyxch-2f-high-quality-dropcore-2-core-1-messenger/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/08/DROPCORE-2CORE-3SELLING-1000-2000mm.jpg', kategori: 'Optical Fiber Cable', keywords: ['kabel dropcore 2 core', 'gjyxch-2f', 'kabel fo drop 2 core', 'kabel drop ke pelanggan'] },
  { nama: 'Kabel fiber optik GJYXCH-1F Super Premium Dropcore 1,2 mm', url: 'https://falcom-technology.com/products/kabel-fiber-optik-gjyxch-1f-super-premium-dropcore-12-mm/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/02/FO-Super-Premium-DPN.jpg', kategori: 'Optical Fiber Cable', keywords: ['dropcore 1 core premium', 'kabel fo 1 core 1.2mm', 'gjyxch-1f super premium'] },
  { nama: 'Kabel fiber optik GJYXCH-1F Premium Dropcore 1 Core (1 Messenger)', url: 'https://falcom-technology.com/products/kabel-fiber-optik-gjyxch-1f-high-quality-dropcore-1-core-1-messenger/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/08/DROPCORE-PREMIUM-1CORE-3SELLING-best-seller.jpg', kategori: 'Optical Fiber Cable', keywords: ['dropcore 1 core messenger premium', 'gjyxch-1f high quality'] },
  { nama: 'Kabel fiber optik GJYXCH-1F Dropcore 1 Core 1 Messenger', url: 'https://falcom-technology.com/products/kabel-fiber-optik-gjyxch-1f-dropcore-1-core-1-messenger/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/DROPCORE-1-CORE-I-MESSENGER-REV-a.jpg', kategori: 'Optical Fiber Cable', keywords: ['dropcore 1 core standar', 'gjyxch-1f biasa', 'kabel fo drop murah'] },
  // Optical Fiber Cable — Flat Jelly Tube
  { nama: 'Kabel fiber optik FLAT JELLY TUBE 6 CORE 2KM', url: 'https://falcom-technology.com/products/kabel-fiber-optik-flat-jelly-tube-6-core-2km/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/FO-6CORE-JELLY-TUBE-HASBEL-A.jpg', kategori: 'Optical Fiber Cable', keywords: ['fjt 6 core 2km', 'flat jelly tube 6 core', 'kabel fo flat isi 6'] },
  { nama: 'kabel fiber optik FLAT JELLY TUBE 6 CORE 1KM', url: 'https://falcom-technology.com/products/kabel-fiber-optik-flat-jelly-tube-6-core-1km/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/FO-6-CORE-JELLY-TUBE-BOX-A.jpg', kategori: 'Optical Fiber Cable', keywords: ['fjt 6 core 1km'] },
  { nama: 'kabel fiber optik FLAT JELLY TUBE 4 CORE 2KM', url: 'https://falcom-technology.com/products/kabel-fiber-optik-flat-jelly-tube-4-core-2km/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/FO-4CORE-JELLY-TUBE-HASBEL-A.jpg', kategori: 'Optical Fiber Cable', keywords: ['fjt 4 core 2km', 'kabel fo flat isi 4'] },
  { nama: 'kabel fiber optik FLAT JELLY TUBE 4 CORE 1KM', url: 'https://falcom-technology.com/products/kabel-fiber-optik-flat-jelly-tube-4-core-1km/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/FO-4CORE-JELLY-TUBE-BOX-A.jpg', kategori: 'Optical Fiber Cable', keywords: ['fjt 4 core 1km'] },
  { nama: 'Kabel fiber optik FLAT JELLY TUBE 2,4 & 6 CORE 2KM', url: 'https://falcom-technology.com/products/kabel-fiber-optik-flat-jelly-tube-24-6-core-2km/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/10/Icon-Flat-Jelly-Tube-2a.jpg', kategori: 'Optical Fiber Cable', keywords: ['fjt 2 4 6 core 2km', 'flat jelly tube opsi core'] },
  { nama: 'Kabel fiber optik FLAT JELLY TUBE 2, 4 & 6 CORE 1KM', url: 'https://falcom-technology.com/products/kabel-fiber-optik-flat-jelly-tube-2-4-6-core-1km/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/10/Icon-Flat-Jelly-Tube-2.jpg', kategori: 'Optical Fiber Cable', keywords: ['fjt 2 4 6 core 1km'] },
  { nama: 'kabel fiber optik FLAT JELLY TUBE 2 CORE 2KM', url: 'https://falcom-technology.com/products/kabel-fiber-optik-flat-jelly-tube-2-core-2km/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/FO-2CORE-JELLY-TUBE-HASBEL-A.jpg', kategori: 'Optical Fiber Cable', keywords: ['fjt 2 core 2km'] },
  { nama: 'Kabel fiber optik FLAT JELLY TUBE 2 CORE 1KM', url: 'https://falcom-technology.com/products/kabel-fiber-optik-flat-jelly-tube-2-core-1km/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/FO-2CORE-JELLY-TUBE-BOX.jpg', kategori: 'Optical Fiber Cable', keywords: ['fjt 2 core 1km'] },
  // Optical Fiber Cable — FIG-8 MINI GYXTC8Y
  { nama: 'KABEL FIBER OPTIK FIG-8 MINI 4,6,12 Core 5,6mm×10,7mm', url: 'https://falcom-technology.com/products/kabel-fiber-optik-fig-8-mini-4612-core-56mm107mm/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/08/Fig-8-GYXTC8Y-6core.jpg', kategori: 'Optical Fiber Cable', keywords: ['fig 8 mini 4 6 12 core', 'gyxtc8y', 'kabel angka 8 dengan penggantung'] },
  { nama: 'Kabel Fiber Optik FIG-8 MINI 4,6,12 Core 4,2mm×6,5mm', url: 'https://falcom-technology.com/products/kabel-fiber-optik-fig-8-mini-4612-core-42mm65mm/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/08/FIG-8-MINI-GYXTC8Y-12core.jpg', kategori: 'Optical Fiber Cable', keywords: ['fig 8 mini kecil', 'gyxtc8y 4.2mm'] },
  { nama: 'Kabel Fiber Optik FIG-8 MINI 24 CORE 4 TUBE 6,1MM×11,1MM', url: 'https://falcom-technology.com/products/kabel-fiber-optik-fig-8-mini-24-core-4-tube-61mm111mm/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/FIG-8-MINI-GYTC8Y-a.jpg', kategori: 'Optical Fiber Cable', keywords: ['fig 8 mini 24 core', 'gyxtc8y 24 core 4 tube'] },
  { nama: 'Kabel fiber optik FIG-8 MINI 2 Core 3,6mm×6,2mm', url: 'https://falcom-technology.com/products/kabel-fiber-optik-fig-8-mini-2-core-36mm62mm/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/08/GYXTC8Y-No6-pki-Dos-a-1.jpg', kategori: 'Optical Fiber Cable', keywords: ['fig 8 mini 2 core'] },
  // Optical Fiber Cable — FIG-8 ARMORED GYXTC8S
  { nama: 'KABEL FIBER OPTIK FIG-8 ARMORED 48 Core 9.3mm×15.5mm GYTC8S', url: 'https://falcom-technology.com/products/kabel-fiber-optik-fig-8-armored-48-core-9-3-mm15-5mm-gytc8s/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/FIG-8-ARMORED-48-CORE-9.3-mm-155mm-a.jpg', kategori: 'Optical Fiber Cable', keywords: ['fig 8 armored 48 core', 'gytc8s besar'] },
  { nama: 'KABEL FIBER OPTIK FIG-8 ARMORED 4,6,12 Core 7mm×13.1mm', url: 'https://falcom-technology.com/products/kabel-fiber-optik-fig-8-armored-4612-core-7mm13-1mm/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/08/GYXTC8S-No2-a-1.jpg', kategori: 'Optical Fiber Cable', keywords: ['fig 8 armored 4 6 12 core', 'anti tikus'] },
  { nama: 'KABEL FIBER OPTIK FIG-8 ARMORED 4,6,12 Core 5mm×10.4mm', url: 'https://falcom-technology.com/products/kabel-fiber-optik-fig-8-armored-4612-core-5mm10-4mm/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/08/FIG-8-ARMORED-6-CORE-5MM-104-A-2.jpg', kategori: 'Optical Fiber Cable', keywords: ['fig 8 armored kecil 5mm'] },
  { nama: 'KABEL FIBER OPTIK FIG-8 ARMORED 24 Core 8.5mm×15mm GYTC8S', url: 'https://falcom-technology.com/products/kabel-fiber-optik-fig-8-armored-24-core-8-5mm15mm-gytc8s/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/08/FIG-8-Armored-GYXTC8S-24-core-NO3-A.jpg', kategori: 'Optical Fiber Cable', keywords: ['fig 8 armored 24 core'] },
  // Optical Fiber Cable — ARMORED GYXTW
  { nama: 'KABEL FIBER OPTIK NON ARMORED 2,4,6 CORE 6,2mm', url: 'https://falcom-technology.com/products/kabel-fiber-optik-non-armored-246-core-62mm/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/NON-ARMORED-GYXTY-2KM-A.jpg', kategori: 'Optical Fiber Cable', keywords: ['kabel fo non armored', 'kabel fiber tanpa lapis baja', 'gyxtw non armored'] },
  { nama: 'Kabel fiber optik ARMORED 24 CORE 4000M', url: 'https://falcom-technology.com/products/kabel-fiber-optik-armored-24-core-4000m/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/06/ARMORED-GYXTW-24-core-4000M-A.jpg', kategori: 'Optical Fiber Cable', keywords: ['kabel armored 24 core', 'gyxtw 24 core 4000m'] },
  { nama: 'Kabel fiber optik ARMORED 2,4,6,12 Core 6.2mm', url: 'https://falcom-technology.com/products/kabel-fiber-optik-armored-24612-core-6-2mm/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/Armored-GYXTW-A.jpg', kategori: 'Optical Fiber Cable', keywords: ['kabel armored 2 4 6 12 core', 'lapis besi anti tikus'] },
  { nama: 'Kabel fiber optik ARMORED 12 CORE 9,5MM, 4000M', url: 'https://falcom-technology.com/products/kabel-fiber-optik-armored-12-core-95mm-4000m/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/06/ARMORED-GYXTW-12-core-4000M-a.jpg', kategori: 'Optical Fiber Cable', keywords: ['kabel armored 12 core 4000m'] },
  // Optical Fiber Cable — ADSS
  { nama: 'Kabel Fiber Optik MINI ADSS 12 CORE – 1 TUBE', url: 'https://falcom-technology.com/products/kabel-fiber-optik-mini-adss-12-core-1-tube/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/06/MINI-ADSS-12-CORE-A-1.jpg', kategori: 'Optical Fiber Cable', keywords: ['kabel adss 12 core', 'adss mini 1 tube', 'fiber optik aerial 12 core', 'kabel fo tanpa penggantung'] },
  { nama: 'Kabel fiber optik ADSS 6 CORE – 1 TUBE', url: 'https://falcom-technology.com/products/kabel-fiber-optik-adss-6-core-1-tube/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/ADSS-6-CORE-9mm-web1.jpg', kategori: 'Optical Fiber Cable', keywords: ['kabel adss 6 core', 'adss 1 tube'] },
  { nama: 'Kabel Fiber Optik ADSS 48 CORE – 4 TUBE', url: 'https://falcom-technology.com/products/kabel-fiber-optik-adss-48-core-4-tube/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/ADSS-48-CORE-WEB1.jpg', kategori: 'Optical Fiber Cable', keywords: ['kabel adss 48 core backbone'] },
  { nama: 'Kabel Fiber Optik ADSS 24 CORE – 4 TUBE', url: 'https://falcom-technology.com/products/kabel-fiber-optik-adss-24-core-4-tube/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/ADSS-24-CORE-9mm-4TUBE-WEB1.jpg', kategori: 'Optical Fiber Cable', keywords: ['kabel adss 24 core'] },
  { nama: 'Kabel Fiber Optik ADSS 12 CORE – 2 TUBE', url: 'https://falcom-technology.com/products/kabel-fiber-optik-adss-12-core-2-tube/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/ADSS-12CORE-9mm-2-TUBE-WEB1.jpg', kategori: 'Optical Fiber Cable', keywords: ['kabel adss 12 core 2 tube'] },
  // Optical Fiber Cable — PRECON / DROPCABLE
  { nama: 'PRECON kabel fiber optik / DROPCABLE 50,75,100,150m SC APC', url: 'https://falcom-technology.com/products/kabel-fiber-optik-precon-dropcable-5075100150m-sc-apc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/PRECON-DROPCABLE-NO2-A.jpg', kategori: 'Optical Fiber Cable', keywords: ['precon sc apc', 'dropcable konektor apc', 'patchcord precon 50-150m'] },
  { nama: 'kabel fiber optik PRECON / DROPCABLE 50,75,100,125,150,200m SC UPC', url: 'https://falcom-technology.com/products/kabel-fiber-optik-precon-dropcable-5075100125150200m-sc-upc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/PRECON-DROPCABLE-NO1-A.jpg', kategori: 'Optical Fiber Cable', keywords: ['precon sc upc', 'dropcable konektor upc', 'patchcord precon 200m'] },

  // LAN Cable — CAT5E
  { nama: 'Kabel Lan UTP LAN CAT5E INDOOR', url: 'https://falcom-technology.com/products/kabel-lan-utp-lan-cat5e-indoor/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/08/LAN-UTP-CAT5E-INDOOR-a.jpg', kategori: 'LAN Cable', keywords: ['kabel lan cat5e indoor', 'utp cat5e dalam ruangan'] },
  { nama: 'Kabel Lan NEW FTP LAN CAT 5E OUTDOOR', url: 'https://falcom-technology.com/products/kabel-lan-new-ftp-lan-cat-5e-outdoor/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/03/OK.jpg', kategori: 'LAN Cable', keywords: ['kabel lan cat5e outdoor ftp'] },
  { nama: 'KABEL LAN FTP CAT5E OUTDOOR FALCOM', url: 'https://falcom-technology.com/products/kabel-lan-ftp-cat5e-outdoor-falcom/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/07/LAN-FTP-CAT5E-OUTDOOR-a.jpg', kategori: 'LAN Cable', keywords: ['kabel ftp cat5e outdoor falcom'] },
  { nama: 'KABEL LAN FTP CAT5E INDOOR FALCOM', url: 'https://falcom-technology.com/products/kabel-lan-ftp-cat5e-indoor-falcom/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/LAN-FTP-CAT-5E-INDOOR-BARU-A.jpg', kategori: 'LAN Cable', keywords: ['kabel ftp cat5e indoor falcom'] },
  // LAN Cable — CAT6
  { nama: 'Kabel UTP LAN CAT6 PREMIUM INDOOR', url: 'https://falcom-technology.com/products/kabel-utp-lan-cat6-premium-indoor/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/LAN-Cable-PREM-CAT6-indoor-A.jpg', kategori: 'LAN Cable', keywords: ['kabel lan cat6 premium indoor'] },
  { nama: 'KABEL LAN UTP CAT6 INDOOR FALCOM', url: 'https://falcom-technology.com/products/kabel-lan-utp-cat6-indoor-falcom/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/08/LAN-Cable-Standart-CAT6-indoor.jpg', kategori: 'LAN Cable', keywords: ['kabel lan cat6 utp indoor'] },
  { nama: 'Kabel Lan FTP LAN CAT6 OUTDOOR', url: 'https://falcom-technology.com/products/kabel-lan-ftp-lan-cat6-outdoor/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/08/LAN-FTP-CAT6-OUTDOOR-a.jpg', kategori: 'LAN Cable', keywords: ['kabel lan cat6 outdoor ftp'] },
  { nama: 'KABEL LAN FTP CAT 6 OUTDOOR FALCOM', url: 'https://falcom-technology.com/products/kabel-lan-ftp-cat-6-outdoor-falcom/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/07/LAN-CAT-6-OUTDOOR-ISI-2ROLL-AA.jpg', kategori: 'LAN Cable', keywords: ['kabel ftp cat6 outdoor falcom'] },
  { nama: 'Kabel FTP LAN CAT6 INDOOR', url: 'https://falcom-technology.com/products/kabel-ftp-lan-cat6-indoor/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/LAN-FTP-CAT-6-INDOOR-BARU-A.jpg', kategori: 'LAN Cable', keywords: ['kabel ftp cat6 indoor'] },

  // Coaxial Cable — RG 6
  { nama: 'Kabel koaksial RG F698 BV', url: 'https://falcom-technology.com/products/kabel-koaksial-rg-f698-bv/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/08/RG6-F698-BV-a.jpg', kategori: 'Coaxial Cable', keywords: ['kabel coax rg6 f698 bv', 'kabel antena rg6'] },
  { nama: 'Kabel koaksial RG F695 BEM', url: 'https://falcom-technology.com/products/kabel-koaksial-rg-f695-bem/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/04/RG6-F695-BEM-a.jpg', kategori: 'Coaxial Cable', keywords: ['kabel coax rg6 f695 bem'] },
  { nama: 'Kabel koaksial RG F695 BE', url: 'https://falcom-technology.com/products/kabel-koaksial-rg-f695-be/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/08/RG6-F695-BE-a.jpg', kategori: 'Coaxial Cable', keywords: ['kabel coax rg6 f695 be'] },
  { nama: 'Kabel koaksial RG F675 BE', url: 'https://falcom-technology.com/products/kabel-koaksial-rg-f675-be/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/04/RG6-F675-BE-a.jpg', kategori: 'Coaxial Cable', keywords: ['kabel coax rg6 f675 be'] },
  { nama: 'Kabel koaksial RG 6 PRO', url: 'https://falcom-technology.com/products/kabel-koaksial-rg-6-pro/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/08/RG6-F675-PRO-REVISI.jpg', kategori: 'Coaxial Cable', keywords: ['kabel coax rg6 pro', 'kabel antena tv pro'] },
  // Coaxial Cable — RG 11
  { nama: 'Kabel koaksial RG 1195 BEM FCCS', url: 'https://falcom-technology.com/products/kabel-koaksial-rg-1195-bem-fccs/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/08/RG11-F1195-BEMF-CCS-a.jpg', kategori: 'Coaxial Cable', keywords: ['kabel coax rg11 fccs'] },
  { nama: 'Kabel koaksial RG 1195 BEM CCS', url: 'https://falcom-technology.com/products/kabel-koaksial-rg-1195-bem-ccs/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/04/RG11-F1195-BEMF-CCS-re.jpg', kategori: 'Coaxial Cable', keywords: ['kabel coax rg11 ccs', 'kabel backbone catv'] },

  // Fiberoptic Accessories — ODF/OTB
  { nama: 'ODF/OTB 24 CORE SC UPC, 1U + 24 PIGTAIL', url: 'https://falcom-technology.com/products/odf-otb-24-core-sc-upc-1u-24-pigtail/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/ODF-24core-SC-UPC-1U-24-Pigtail-a.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odf 24 core upc', 'otb 24 port', 'terminal box fiber 24 core'] },
  { nama: 'ODF/OTB 24CORE SC APC 1U+24 PIGTAIL', url: 'https://falcom-technology.com/products/odf-24-core/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/ODF-24-Core.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odf 24 core apc'] },
  { nama: 'ODF/OTB 48CORE SC APC 2U+48 PIGTAIL', url: 'https://falcom-technology.com/products/odc-48-core/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/ODC-48.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odf 48 core apc'] },
  { nama: 'ODF/OTB 96 CORE 4U 8 TRAY X 12 CORE SC APC+96 PIGTAIL', url: 'https://falcom-technology.com/products/odf-96-core/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/ODF-96-Core.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odf 96 core apc'] },
  { nama: 'ODF/OTB 96 CORE,4U 8 TRAY x 12 CORE SC UPC + 96 PIGTAIL', url: 'https://falcom-technology.com/products/odf-otb-96-core4u-8-tray-x-12-core-sc-upc-96-pigtail/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/ODF-96-core-4U-8-tray-12-core-SC-UPC-96-Pigtail-A.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odf 96 core upc'] },
  // Fiberoptic Accessories — ODP
  { nama: 'ODP Kapsul 16 port 2 in 1', url: 'https://falcom-technology.com/products/odp-kapsul-16-port-2-in-1/', gambar: 'https://falcom-technology.com/wp-content/uploads/2025/01/ODP-CAPSUL-2-in-1-a.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odp kapsul 16 port', 'kotak pembagi fiber kapsul'] },
  { nama: 'ODP KAPSUL', url: 'https://falcom-technology.com/products/odp-kapsul/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/12/ODP-CAPSUL-a.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odp kapsul polos'] },
  { nama: 'ODP 8 PORT ADAPTER WHITE', url: 'https://falcom-technology.com/products/odp-8-port-adapter-white/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/12/ODP-8-PORT-ADAPTER-WHITE-a.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odp 8 port putih'] },
  { nama: 'ODP 8 PORT ADAPTER', url: 'https://falcom-technology.com/products/odp-8-port-adapter/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/12/ODP-8-PORT-ADAPTER-a.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odp 8 port adapter'] },
  { nama: 'ODP 8 CORE TYPE BOX PLC PUTIH', url: 'https://falcom-technology.com/products/odp-8-core-type-box-plc-putih/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/ODP-8-Core-type-Box-PLC-putih-A.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odp 8 core box plc putih'] },
  { nama: 'ODP 8 CORE TYPE ADAPTER PUTIH', url: 'https://falcom-technology.com/products/odp-8-core-type-adapter-putih/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/ODP-8-CORE-adapter-PLC-putih-A.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odp 8 core adapter putih'] },
  { nama: 'ODP 8 CORE TYPE 2 IN 1 PUTIH', url: 'https://falcom-technology.com/products/odp-8-core-type-2-in-1-putih/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/05/ODP-8-PORT-2-IN-1-PUTIH-a.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odp 8 core 2in1 putih'] },
  { nama: 'ODP 8 CORE TYPE 2 IN 1 HITAM', url: 'https://falcom-technology.com/products/odp-8-core-type-2-in-1-hitam/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/05/ODP-8-PORT-2-IN-1-Hitam-a.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odp 8 core 2in1 hitam'] },
  { nama: 'ODP 24 CORE TYPE ADAPTER PUTIH', url: 'https://falcom-technology.com/products/odp-24-core-type-adapter-putih/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/ODP-24-Core-Type-adapter-putih-A-1.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odp 24 core adapter putih'] },
  { nama: 'ODP 2 in 1 Cassette Adapter 24 Port', url: 'https://falcom-technology.com/products/odp-2-in-1-cassette-adapter-24-port/', gambar: 'https://falcom-technology.com/wp-content/uploads/2025/01/ODP-2-in-1-Cassette-Adapter-24-Port-b.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odp cassette 24 port'] },
  { nama: 'ODP 16 PORT ADAPTER – GRAY', url: 'https://falcom-technology.com/products/odp-16-port-adapter-gray/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/12/ODP-16-PORT-ADAPTER-GRAY-a.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odp 16 port abu-abu'] },
  { nama: 'ODP 16 CORE TYPE 2 IN 1 PUTIH', url: 'https://falcom-technology.com/products/odp-16-core-type-2-in-1-putih/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/05/ODP-16-PORT-2-IN-1-Putih-a.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odp 16 core 2in1 putih'] },
  { nama: 'ODP 16 CORE DOUBLE LOCK TIPE BOX PLC PUTIH', url: 'https://falcom-technology.com/products/odp-16-core-double-lock-tipe-box-plc-putih/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/ODP16-Core-Type-adapter-putih-B.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odp 16 core double lock putih'] },
  { nama: 'ODP 16 CORE DOUBLE LOCK TIPE BOX PLC HITAM', url: 'https://falcom-technology.com/products/odp-16-core-double-lock-tipe-box-plc-hitam/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/ODP16.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odp 16 core double lock hitam'] },
  // Fiberoptic Accessories — ODC
  { nama: 'ODC 96 CORE 24XPLC 1*4 SC APC, PLAT BESI+KLEM TIANG', url: 'https://falcom-technology.com/products/odc-96-core-plc-1x4x24-set/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/ODC-96-Core-PLC-1x4x24-set.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odc 96 core tiang', 'odc plc 1x4 24 set'] },
  { nama: 'ODC 96 CORE', url: 'https://falcom-technology.com/products/odc-96-core/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/ODC-96-Core-1.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odc 96 core polos'] },
  { nama: 'ODC 32K, 4x SC/UPC PLC 3x (1*2) + 2x STAINLESS PLATE', url: 'https://falcom-technology.com/products/odc-32k-4x-sc-upc-plc-3x-12-2x-stainless-plate/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/ODC-32-core-UPC-a.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odc 32 core upc stainless'] },
  { nama: 'ODC 32K, 4x SC/APC PLC 3x (1*2) + 2x STAINLESS PLATE', url: 'https://falcom-technology.com/products/odc-32k-4x-sc-apc-plc-3x-12-2x-stainless-plate/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/ODC-32-core-APC-a.jpg', kategori: 'Fiberoptic Accessories', keywords: ['odc 32 core apc stainless'] },
  // Fiberoptic Accessories — Splitter Optic Rasio APC & UPC
  { nama: 'SPLITTER OPTIK 2 WAY R SC/UPC', url: 'https://falcom-technology.com/products/splitter-optik-2-way-r-sc-upc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/Splitter-Optic-Rasio-APC-dan-UPC-5-95.jpg', kategori: 'Fiberoptic Accessories', keywords: ['splitter optik 2 way upc'] },
  { nama: 'SPLITTER OPTIK 2 WAY R SC/APC', url: 'https://falcom-technology.com/products/splitter-optik-2-way-r-sc-apc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/Splitter-Optic-Rasio-50-50-SC-APC.jpg', kategori: 'Fiberoptic Accessories', keywords: ['splitter optik 2 way apc'] },
  { nama: 'SPLITTER OPTIC PLC 1*2, 1*4, 1*8 SC/UPC', url: 'https://falcom-technology.com/products/splitter-optic-plc-sc-upc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/Splitter-Optic-PLC-1-2-UPC.jpg', kategori: 'Fiberoptic Accessories', keywords: ['splitter plc 1x2 1x4 1x8 upc'] },
  // Fiberoptic Accessories — Splitter Optic PLC
  { nama: 'Splitter Optic PLC 1*8 Steeltube type UPC', url: 'https://falcom-technology.com/products/splitter-optic-plc-1-8-steel-tube-type-upc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2025/04/Splitter-Optic-PLC-1-8-Steel-tube-type-UPC.jpg', kategori: 'Fiberoptic Accessories', keywords: ['splitter plc 1x8 steeltube upc'] },
  { nama: 'Splitter Optic PLC 1*8 Cassette (Box) Type SC UPC', url: 'https://falcom-technology.com/products/splitter-optic-plc-1-8-cassette-type-sc-upc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/Splitter-Optic-PLC-1-8-Cassette-Type-SC-UPC.jpg', kategori: 'Fiberoptic Accessories', keywords: ['splitter plc 1x8 cassette upc'] },
  { nama: 'Splitter Optic PLC 1*8 Cassette (Box) type SC APC', url: 'https://falcom-technology.com/products/splitter-optic-plc-18-cassette-box-type-sc-apc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/09/Splitter-Optic-PLC-Cassette-1-8-SC-APC.jpg', kategori: 'Fiberoptic Accessories', keywords: ['splitter plc 1x8 cassette apc'] },
  { nama: 'Splitter Optic PLC 1*4 Steeltube type UPC', url: 'https://falcom-technology.com/products/splitter-optic-plc-1-4-steel-tube-type-upc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2025/04/Splitter-Optic-PLC-1-4-Steel-tube-type-UPC.jpg', kategori: 'Fiberoptic Accessories', keywords: ['splitter plc 1x4 steeltube upc'] },
  { nama: 'Splitter Optic PLC 1*2 Steeltube type UPC', url: 'https://falcom-technology.com/products/splitter-optic-plc-12-steel-tube-type-upc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2025/04/Splitter-Optic-PLC-1-2-Steel-tube-type-UPC.jpg', kategori: 'Fiberoptic Accessories', keywords: ['splitter plc 1x2 steeltube upc'] },
  { nama: 'Splitter Optic PLC 1*16 Cassette (Box) Type SC UPC', url: 'https://falcom-technology.com/products/splitter-optic-plc-116-cassette-box-type-sc-upc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2025/04/Splitter-Optic-PLC-1-16-CassetteType-SC-UPC.jpg', kategori: 'Fiberoptic Accessories', keywords: ['splitter plc 1x16 cassette upc'] },
  { nama: 'Splitter Optic PLC 1*16 Cassette (Box) type SC APC', url: 'https://falcom-technology.com/products/splitter-optic-plc-116-cassette-box-type-sc-apc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2025/04/Splitter-Optic-PLC-Cassette-1-16-SC-APC.jpg', kategori: 'Fiberoptic Accessories', keywords: ['splitter plc 1x16 cassette apc'] },
  { nama: 'PLC SPLITTER CASSETTE BOX SC/UPC 1X4', url: 'https://falcom-technology.com/products/plc-splitter-cassette-box-sc-upc-1x4/', gambar: 'https://falcom-technology.com/wp-content/uploads/2025/06/PLC-1X4-cassette-type-box-SC-UPC-a.png', kategori: 'Fiberoptic Accessories', keywords: ['plc splitter box 1x4 upc'] },
  { nama: 'PLC SPLITTER CASSETTE BOX SC/UPC 1X2', url: 'https://falcom-technology.com/products/plc-splitter-cassette-box-sc-upc-1x2/', gambar: 'https://falcom-technology.com/wp-content/uploads/2025/06/PLC-1X2-cassette-type-box-SC-UPC-a.png', kategori: 'Fiberoptic Accessories', keywords: ['plc splitter box 1x2 upc'] },
  { nama: 'PLC SPLITTER CASSETTE BOX SC/UPC 1X16', url: 'https://falcom-technology.com/products/plc-splitter-cassette-box-sc-upc-1x16/', gambar: 'https://falcom-technology.com/wp-content/uploads/2025/07/PLC-1X16-cassette-type-box-SC-UPC-a.png', kategori: 'Fiberoptic Accessories', keywords: ['plc splitter box 1x16 upc'] },
  // Fiberoptic Accessories — Joint Closure
  { nama: 'Vertical Mini Joint closure 12 / 24 / 48 Core', url: 'https://falcom-technology.com/products/vertical-mini-joint-closure-12-core/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/Horizontal-Mini-Joint-closure-12-Core.jpg', kategori: 'Fiberoptic Accessories', keywords: ['joint closure vertical mini', 'jc 12 24 48 core'] },
  { nama: 'JOINT CLOSURE HORIZONTAL 4 TRAY 48 Core', url: 'https://falcom-technology.com/products/joint-closure-horizontal-4-tray-48-core/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/12/JOINT-CLOSURE-HORIZONTAL-4-TRAY-a.jpg', kategori: 'Fiberoptic Accessories', keywords: ['jc horizontal 48 core 4 tray'] },
  { nama: 'JOINT CLOSURE HORIZONTAL 2 TRAY 24 CORE', url: 'https://falcom-technology.com/products/joint-closure-horizontal-2-tray-24-core/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/12/JOINT-CLOSURE-HORIZONTAL-2-TRAY-24-CORE-A.jpg', kategori: 'Fiberoptic Accessories', keywords: ['jc horizontal 24 core 2 tray'] },
  { nama: 'Joint Closure GPG-G Horizontal', url: 'https://falcom-technology.com/products/joint-closure-gpg-g-horizontal/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/GPG-G-Horizontal-Joint-closure.jpg', kategori: 'Fiberoptic Accessories', keywords: ['joint closure gpg-g'] },
  { nama: 'JOINT CLOSURE DOME 6 TRAY 96 – 144 CORE', url: 'https://falcom-technology.com/products/joint-closure-dome-6-tray-96-144-core/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/11/JOINT-CLOSURE-6-TRAY-96-144-CORE-A.jpg', kategori: 'Fiberoptic Accessories', keywords: ['jc dome 96-144 core besar'] },
  { nama: 'JOINT CLOSURE DOME 4 TRAY 96 CORE', url: 'https://falcom-technology.com/products/joint-closure-dome-4-tray-96-core/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/11/JOINT-CLOSURE-4-TRAY-A.jpg', kategori: 'Fiberoptic Accessories', keywords: ['jc dome 96 core 4 tray'] },
  { nama: 'JOINT CLOSURE DOME 2 TRAY 24 CORE', url: 'https://falcom-technology.com/products/joint-closure-dome-2-tray-24-core/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/11/JOINT-CLOSURE-2-TRAY-A.jpg', kategori: 'Fiberoptic Accessories', keywords: ['jc dome 24 core kecil'] },
  { nama: 'JOINT CLOSURE 1 CORE TYPE SLEEVE', url: 'https://falcom-technology.com/products/joint-closure-1-core-type-sleeve/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/11/TYPE-SLEEVE-1CORE-A.jpg', kategori: 'Fiberoptic Accessories', keywords: ['jc 1 core sleeve'] },
  { nama: 'JOINT CLOSURE 1 CORE TYPE ADAPTER', url: 'https://falcom-technology.com/products/joint-closure-1-core-type-adapter/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/11/TYPE-ADAPTER-1CORE-A.jpg', kategori: 'Fiberoptic Accessories', keywords: ['jc 1 core adapter'] },
  { nama: 'Horizontal Mini Joint closure 12 Core B', url: 'https://falcom-technology.com/products/horizontal-mini-joint-closure-12-core-b/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/Horizontal-Mini-Joint-closure-12-Core-B.jpg', kategori: 'Fiberoptic Accessories', keywords: ['jc horizontal mini 12 core'] },

  // EPON/GPON (OLT) — OLT EPON
  { nama: 'OLT EPON 4 PON FASTLINK + SFP PX20+++++', url: 'https://falcom-technology.com/products/olt-epon-4-pon-fastlink-sfp-px20/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/OLT-1310-4-PORT-A.jpg', kategori: 'EPON/GPON', keywords: ['olt epon 4 pon fastlink', 'olt epon sfp px20'] },
  { nama: 'OLT EPON 4 PON AC/DC FASTLINK + SFP PX20+++++', url: 'https://falcom-technology.com/products/olt-epon-4-pon-ac-dc-fastlink-sfp-px20/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/OLT-1310-4-PORT-ACDC-B.jpg', kategori: 'EPON/GPON', keywords: ['olt epon 4 pon dual power ac dc'] },
  { nama: 'OLT EPON 2 PON FASTLINK + SFP PX20+++++ 9DB', url: 'https://falcom-technology.com/products/olt-epon-2-pon-fastlink-sfp-px20-9db/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/OLT-EPON-2-PORT.jpg', kategori: 'EPON/GPON', keywords: ['olt epon 2 pon 9db'] },
  { nama: 'OLT EPON 2 PON FASTLINK', url: 'https://falcom-technology.com/products/olt-epon-2-pon-fastlink/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/10/OLT-FASTLINK-EPON-2-PORT-A.jpg', kategori: 'EPON/GPON', keywords: ['olt epon 2 pon fastlink polos'] },
  // EPON/GPON (OLT) — OLT GPON
  { nama: 'OLT OUTDOOR GPON 8 PON GPT-F88I FASTLINK', url: 'https://falcom-technology.com/products/olt-outdoor-gpon-8-pon-gpt-f88i-fastlink/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/Master-OLT-GPON-OUTDOOR.jpg', kategori: 'EPON/GPON', keywords: ['olt gpon outdoor 8 pon', 'olt tahan cuaca'] },
  { nama: 'OLT GPON 8 PON FASTLINK + SPF C+++', url: 'https://falcom-technology.com/products/olt-gpon-8-pon-fastlink-spf-c/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/03/OLT-GPON-10G.jpg', kategori: 'EPON/GPON', keywords: ['olt gpon 8 pon sfp'] },
  { nama: 'OLT GPON 8 PON FASTLINK + 8X SFP C+++', url: 'https://falcom-technology.com/products/olt-gpon-8-pon-fastlink-8x-sfp-c/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/12/KINGTAPE-GPON-8-PON-a.jpg', kategori: 'EPON/GPON', keywords: ['olt gpon 8 pon 8 sfp'] },
  { nama: 'OLT GPON 8 PON FASTLINK', url: 'https://falcom-technology.com/products/olt-gpon-8-pon-fastlink/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/05/OLT-EPON-1310-8-PORT-A.jpg', kategori: 'EPON/GPON', keywords: ['olt gpon 8 pon polos'] },
  { nama: 'OLT GPON 4 PON FASTLINK Dual power supply', url: 'https://falcom-technology.com/products/olt-gpon-4-pon-fastlink-dual-power-supply/', gambar: 'https://falcom-technology.com/wp-content/uploads/2025/04/OLT-FASTLINK-GPON-4-PON-Dual-power-supply-A.jpg', kategori: 'EPON/GPON', keywords: ['olt gpon 4 pon dual power'] },
  { nama: 'OLT GPON 3 PON FASTLINK', url: 'https://falcom-technology.com/products/olt-gpon-3-pon-fastlink/', gambar: 'https://falcom-technology.com/wp-content/uploads/2026/02/FALCOM-OLT-3-PON.webp', kategori: 'EPON/GPON', keywords: ['olt gpon 3 pon'] },
  { nama: 'OLT GPON 2 PON FASTLINK', url: 'https://falcom-technology.com/products/olt-gpon-2-pon-fastlink/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/10/OLT-FASTLINK-GPON-2-PORT-A.jpg', kategori: 'EPON/GPON', keywords: ['olt gpon 2 pon'] },
  { nama: 'OLT GPON 1 PON FASTLINK', url: 'https://falcom-technology.com/products/olt-gpon-1-pon-fastlink/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/10/FASTLINK-GPON-1-PON-A.jpg', kategori: 'EPON/GPON', keywords: ['olt gpon 1 pon kecil'] },
  { nama: 'OLT GPON 1 PON AC/DC FTB-1200 FASTLINK', url: 'https://falcom-technology.com/products/olt-gpon-1-pon-ac-dc-ftb-1200-fastlink/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/12/KINGTYPE-GPON-1-PON-a-1.jpg', kategori: 'EPON/GPON', keywords: ['olt gpon 1 pon ftb-1200'] },

  // ONU/ONT — XPON
  { nama: 'ONU XPON HG8546M', url: 'https://falcom-technology.com/products/hg8546m-xpon-terminal/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/10/Modem-G8546M-XPON-Terminal-a.jpg', kategori: 'ONU/ONT', keywords: ['onu hg8546m', 'ont xpon', 'modem gpon hg8546'] },
  { nama: 'ONU XPON GPNFOC', url: 'https://falcom-technology.com/products/onu-xpon-dkb-180-fastlink/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/12/ONU-KINGTYPE-GPN0C-a.jpg', kategori: 'ONU/ONT', keywords: ['onu gpnfoc', 'ont dual epon gpon', 'onu 1fe 1ge wifi'] },
  { nama: 'ONU XPON FASTLINK DKB 180', url: 'https://falcom-technology.com/products/onu-xpon-fastlink-dkb-180/', gambar: 'https://falcom-technology.com/wp-content/uploads/2026/05/ONU-FASTLINK-DKB-180-A022-POSTEL-a.jpg', kategori: 'ONU/ONT', keywords: ['onu fastlink dkb 180', 'ont xpon dkb-180'] },
  { nama: 'ONU XPON CGW-77', url: 'https://falcom-technology.com/products/onu-cgw77/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/ONU-CGW77-hal-a.jpg', kategori: 'ONU/ONT', keywords: ['onu cgw-77', 'ont xpon cgw77'] },
  { nama: 'ONU FASTLINK FL327D WIFI 6 – 4 Antena', url: 'https://falcom-technology.com/products/onu-fastlink-fl327d-wifi-6-4-antena/', gambar: 'https://falcom-technology.com/wp-content/uploads/2026/01/ONU-FASTLINK-FL327D-WIFI-6-4-ANTENA-a.jpg', kategori: 'ONU/ONT', keywords: ['onu fl327d wifi6 4 antena', 'ont wifi 6 4 antena'] },
  { nama: 'ONU FASTLINK FL327D WIFI 6 – 2 Antena', url: 'https://falcom-technology.com/products/onu-fastlink-fl327d-wifi-6-2-antena/', gambar: 'https://falcom-technology.com/wp-content/uploads/2026/01/ONU-FASTLINK-FL327D-WIFI-6-2-ANTENA-a-1.jpg', kategori: 'ONU/ONT', keywords: ['onu fl327d wifi6 2 antena'] },
  { nama: 'ONU FASTLINK FL327D WIFI 5', url: 'https://falcom-technology.com/products/onu-fastlink-fl327d-wifi-5/', gambar: 'https://falcom-technology.com/wp-content/uploads/2026/01/ONU-FASTLINK-FL327D-WIFI-5-2-ANTENA-a-1.jpg', kategori: 'ONU/ONT', keywords: ['onu fl327d wifi5'] },

  // Transmitter & EDFA — EDFA
  { nama: 'EYDFA WDM 8 23DBM FASTLINK', url: 'https://falcom-technology.com/products/eydfa-wdm-8-23dbm-fastlink/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/11/EDFA-8-PORT-A.jpg', kategori: 'Transmitter & EDFA', keywords: ['edfa 8 output 23dbm', 'eydfa wdm 8'] },
  { nama: 'EYDFA WDM 4 23dBM FASTLINK', url: 'https://falcom-technology.com/products/eydfa-wdm-4-23dbm-fastlink/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/11/EDFA-4-PORT-A.jpg', kategori: 'Transmitter & EDFA', keywords: ['edfa 4 output 23dbm'] },
  { nama: 'EYDFA WDM 32 23dBm FASTLINK', url: 'https://falcom-technology.com/products/eydfa-wdm-32-23dbm-fastlink/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/EYDFA-32.jpg', kategori: 'Transmitter & EDFA', keywords: ['edfa 32 output', 'eydfa besar'] },
  { nama: 'EYDFA WDM 16 23DBM FASTLINK', url: 'https://falcom-technology.com/products/eydfa-wdm-16-23dbm-fastlink/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/EDFA-16-PORT-A.jpg', kategori: 'Transmitter & EDFA', keywords: ['edfa 16 output 23dbm'] },
  // Transmitter & EDFA — Transmitter
  { nama: 'TRANSMITTER 1550 nm', url: 'https://falcom-technology.com/products/transmitter-1550-nm/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/11/TRANSMITTER-1550nm-VT-1510D-10mW-A.jpg', kategori: 'Transmitter & EDFA', keywords: ['transmitter optik 1550nm'] },
  { nama: 'TRANSMITTER 1550', url: 'https://falcom-technology.com/products/transmitter-1550/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/TRANSMITTER-1550-a.jpg', kategori: 'Transmitter & EDFA', keywords: ['transmitter 1550 varian lain'] },
  { nama: 'MINI OPTICAL TRANSMITTER 1310nm – 1550nm', url: 'https://falcom-technology.com/products/mini-optical-transmitter-1310nm-1550nm/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/11/1310nm-1550nm-Mini-Optical-Transmitter-A.jpg', kategori: 'Transmitter & EDFA', keywords: ['mini transmitter optik 1310 1550nm'] },

  // Analog Digital — Analog Headend
  { nama: 'CATV Modulator FC 963B', url: 'https://falcom-technology.com/products/catv-modulator-fc-963b/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/Modulator-FC-963B.jpg', kategori: 'Analog Digital', keywords: ['modulator catv fc963b'] },
  { nama: 'CATV MODULATOR E-204', url: 'https://falcom-technology.com/products/catv-modulator-e-204/', gambar: 'https://falcom-technology.com/wp-content/uploads/2025/07/MODULATOR-E-204-a.png', kategori: 'Analog Digital', keywords: ['modulator catv e204'] },
  { nama: 'CATV Modulator E-203', url: 'https://falcom-technology.com/products/catv-modulator-e-203/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/04/CATV-MODULATOR-E-203.jpg', kategori: 'Analog Digital', keywords: ['modulator catv e203'] },
  { nama: 'CATV Agile Modulator E-990H', url: 'https://falcom-technology.com/products/catv-agile-modulator-e-990h/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/CATV-AGILE-MODULATOR-E-990H.jpg', kategori: 'Analog Digital', keywords: ['modulator agile catv e990h'] },
  // Analog Digital — Digital Headend
  { nama: 'IPQAM 16 Channel', url: 'https://falcom-technology.com/products/ipqam-edge-qam-16-channel/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/08/Wellav-IFQ332-IPQAM-edge-QAM-16-channel.jpg', kategori: 'Analog Digital', keywords: ['ipqam 16 channel', 'edge qam'] },
  { nama: 'Digital CMP100 16 slot', url: 'https://falcom-technology.com/products/digital-cmp100-16-slot/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/Digital-CMP100-16-slot.jpg', kategori: 'Analog Digital', keywords: ['digital headend cmp100 16 slot'] },
  { nama: 'Digital CMP 203 6 SLOT', url: 'https://falcom-technology.com/products/digital-cmp-203/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/08/Digital-CMP-203-a.jpg', kategori: 'Analog Digital', keywords: ['digital headend cmp203 6 slot'] },
  // Analog Digital — STB
  { nama: 'Set Top Box Falcom', url: 'https://falcom-technology.com/products/set-top-box-falcom/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/SET-TOP-BOX.jpg', kategori: 'Analog Digital', keywords: ['stb falcom', 'set top box tv kabel'] },

  // HFC — CATV Amplifier
  { nama: 'Amplifier S50', url: 'https://falcom-technology.com/products/amplifier-s50/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/Amplifier-S50.jpg', kategori: 'HFC', keywords: ['amplifier catv s50'] },
  { nama: 'Amplifier S400', url: 'https://falcom-technology.com/products/amplifier-s400/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/Amplifier-S400-1.jpg', kategori: 'HFC', keywords: ['amplifier catv s400'] },
  { nama: 'Amplifier S300', url: 'https://falcom-technology.com/products/amplifier-s300/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/Amplifier-S300.jpg', kategori: 'HFC', keywords: ['amplifier catv s300'] },
  { nama: 'Amplifier RSUZ', url: 'https://falcom-technology.com/products/amplifier-rsuz/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/08/Ampl-RSUZ-a.jpg', kategori: 'HFC', keywords: ['amplifier rsuz'] },
  { nama: 'Amplifier G400A', url: 'https://falcom-technology.com/products/amplifier-g400a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/Amplifier-G400A-1.jpg', kategori: 'HFC', keywords: ['amplifier g400a'] },
  { nama: 'Amplifier G300A', url: 'https://falcom-technology.com/products/amplifier-g300a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/Amplifier-G300A.jpg', kategori: 'HFC', keywords: ['amplifier g300a'] },
  { nama: 'Amplifier FSA H500A', url: 'https://falcom-technology.com/products/amplifier-fsa-h500a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/Amplifier-FSA-H500A.jpg', kategori: 'HFC', keywords: ['amplifier fsa h500a'] },
  { nama: 'Amplifier D500', url: 'https://falcom-technology.com/products/amplifier-d500/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/Amplifier-D500.jpg', kategori: 'HFC', keywords: ['amplifier d500'] },
  { nama: 'Amplifier CLS3', url: 'https://falcom-technology.com/products/amplifier-cls3/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/Amplifier-CLS3.jpg', kategori: 'HFC', keywords: ['amplifier cls3'] },
  { nama: 'Amplifier CLS1', url: 'https://falcom-technology.com/products/amplifier-cls1/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/Amplifier-CLS1.jpg', kategori: 'HFC', keywords: ['amplifier cls1'] },
  // HFC — CATV Node
  { nama: 'Node 860JL', url: 'https://falcom-technology.com/products/node-860jl/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/NODE-860JL.jpg', kategori: 'HFC', keywords: ['catv node 860jl'] },
  { nama: 'Node 800M', url: 'https://falcom-technology.com/products/node-800m/', gambar: 'https://falcom-technology.com/wp-content/uploads/2025/04/Node-800M-a.jpg', kategori: 'HFC', keywords: ['catv node 800m'] },
  { nama: 'Node 409A', url: 'https://falcom-technology.com/products/node-409a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/NODE-409A.jpg', kategori: 'HFC', keywords: ['catv node 409a'] },
  { nama: 'Node 303A', url: 'https://falcom-technology.com/products/node-303a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/NODE-303A.jpg', kategori: 'HFC', keywords: ['catv node 303a'] },
  // HFC — CATV Power Supply
  { nama: 'Power Supply 5A 90VAC', url: 'https://falcom-technology.com/products/power-supply-5a-90-vac/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/Power-Supply-5A-90VAC.jpg', kategori: 'HFC', keywords: ['power supply catv 5a', 'adaptor catv 90vac'] },
  { nama: 'Power Supply 15A 90VAC', url: 'https://falcom-technology.com/products/power-supply-15a-90vac/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/03/Power-Supply-15A-90VAC.jpg', kategori: 'HFC', keywords: ['power supply catv 15a'] },
  // HFC — Connectors
  { nama: 'Connector Entry to Entry', url: 'https://falcom-technology.com/products/connector-entry-to-entry/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/08/Connector-entry-to-entry.jpg', kategori: 'HFC', keywords: ['konektor entry to entry coax'] },
  { nama: 'Connector Feedthru', url: 'https://falcom-technology.com/products/connector-feedthru/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/08/Connector-feedthru.jpg', kategori: 'HFC', keywords: ['konektor feedthru coax'] },
  { nama: 'Connector TV 1', url: 'https://falcom-technology.com/products/connector-tv-1/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/08/Connector-TV-1.jpg', kategori: 'HFC', keywords: ['konektor tv tipe 1'] },
  { nama: 'Connector TV 2', url: 'https://falcom-technology.com/products/connector-tv-2/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/08/Connector-TV-2.jpg', kategori: 'HFC', keywords: ['konektor tv tipe 2'] },
  { nama: 'Connector RG11 Drat Jarum', url: 'https://falcom-technology.com/products/connector-rg11-drat-jarum/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/06/Connector-RG11-drat-Jarum.jpg', kategori: 'HFC', keywords: ['konektor rg11 drat jarum'] },
  { nama: 'Connector RG6 Drat', url: 'https://falcom-technology.com/products/connector-rg6-drat/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/06/Connector-RG6-drat.jpg', kategori: 'HFC', keywords: ['konektor rg6 drat'] },
  // HFC — Tap Indoor
  { nama: 'Tap FIT 410', url: 'https://falcom-technology.com/products/tap-fit-410/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/04/FIS-410.jpg', kategori: 'HFC', keywords: ['tap indoor fit410'] },
  { nama: 'Splitter sinyal CATV FIT 420', url: 'https://falcom-technology.com/products/splitter-sinyal-catv-fit-420/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/Tap-Indoor-420.jpg', kategori: 'HFC', keywords: ['splitter catv fit420'] },
  { nama: 'Splitter kabel koaksial Tap FIT 416', url: 'https://falcom-technology.com/products/splitter-kabel-koaksial-tap-fit-416/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/Tap-Indoor-416.jpg', kategori: 'HFC', keywords: ['tap splitter fit416'] },
  { nama: 'Splitter kabel koaksial Tap FIT 414', url: 'https://falcom-technology.com/products/splitter-kabel-koaksial-tap-fit-414/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/Tap-Indoor-414.jpg', kategori: 'HFC', keywords: ['tap splitter fit414'] },
  { nama: 'Splitter kabel koaksial Tap FIT 412', url: 'https://falcom-technology.com/products/splitter-kabel-koaksial-tap-fit-412/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/Tap-Indoor-412.jpg', kategori: 'HFC', keywords: ['tap splitter fit412'] },
  { nama: 'RF Tap FIT 418', url: 'https://falcom-technology.com/products/rf-tap-fit-418/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/Tap-Indoor-418.jpg', kategori: 'HFC', keywords: ['rf tap fit418'] },
  // HFC — Tap Outdoor
  { nama: 'TAP OUTDOOR FOT 416 A', url: 'https://falcom-technology.com/products/tap-outdoor-fot-416-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/OUTDOOR-TAP-416A-1.jpg', kategori: 'HFC', keywords: ['tap outdoor fot416a'] },
  { nama: 'Tap FOT 823 A', url: 'https://falcom-technology.com/products/tap-fot-823-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/01/OUTDOOR-TAP-823A-a.jpg', kategori: 'HFC', keywords: ['tap outdoor fot823a'] },
  { nama: 'Tap FOT 820 A', url: 'https://falcom-technology.com/products/tap-fot-820-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/01/OUTDOOR-TAP-820A-a.jpg', kategori: 'HFC', keywords: ['tap outdoor fot820a'] },
  { nama: 'Tap FOT 818 A', url: 'https://falcom-technology.com/products/tap-fot-818-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2022/10/OUTDOOR-TAP-818A-a.jpg', kategori: 'HFC', keywords: ['tap outdoor fot818a'] },
  { nama: 'Tap FOT 817 A', url: 'https://falcom-technology.com/products/tap-fot-817-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2022/10/OUTDOOR-TAP-817A.jpg', kategori: 'HFC', keywords: ['tap outdoor fot817a'] },
  { nama: 'Tap FOT 814 A', url: 'https://falcom-technology.com/products/tap-fot-814-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/OUTDOOR-TAP-814A-a.jpg', kategori: 'HFC', keywords: ['tap outdoor fot814a'] },
  { nama: 'Tap FOT 812 A', url: 'https://falcom-technology.com/products/tap-fot-812-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/04/OUTDOOR-TAP-812A-a.jpg', kategori: 'HFC', keywords: ['tap outdoor fot812a'] },
  { nama: 'Tap FOT 811 A', url: 'https://falcom-technology.com/products/tap-fot-811-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2022/10/OUTDOOR-TAP-811A-a.jpg', kategori: 'HFC', keywords: ['tap outdoor fot811a'] },
  { nama: 'Tap FOT 414 A', url: 'https://falcom-technology.com/products/tap-fot-414-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/01/OUTDOOR-TAP-414A-a.jpg', kategori: 'HFC', keywords: ['tap outdoor fot414a'] },
  { nama: 'Tap FOT 412 A', url: 'https://falcom-technology.com/products/tap-fot-412-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/01/OUTDOOR-TAP-412A-a.jpg', kategori: 'HFC', keywords: ['tap outdoor fot412a'] },
  { nama: 'Splitter TAP OUDOOR FOT 810 A', url: 'https://falcom-technology.com/products/splitter-tap-oudoor-fot-810-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/OUTDOOR-TAP-810A-a.jpg', kategori: 'HFC', keywords: ['splitter tap outdoor fot810a'] },
  { nama: 'Splitter TAP OUDOOR FOT 416 A', url: 'https://falcom-technology.com/products/splitter-tap-oudoor-fot-416-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/OUTDOOR-TAP-416A-1-1.jpg', kategori: 'HFC', keywords: ['splitter tap outdoor fot416a'] },
  { nama: 'Splitter TAP OUDOOR FOT 220 A', url: 'https://falcom-technology.com/products/splitter-tap-oudoor-fot-220-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/OUTDOOR-TAP-220A-a.jpg', kategori: 'HFC', keywords: ['splitter tap outdoor fot220a'] },
  { nama: 'Splitter TAP OUDOOR FOT 218 A', url: 'https://falcom-technology.com/products/splitter-tap-oudoor-fot-218-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/OUTDOOR-TAP-218A-a.jpg', kategori: 'HFC', keywords: ['splitter tap outdoor fot218a'] },
  { nama: 'Splitter TAP OUDOOR FOT 216 A', url: 'https://falcom-technology.com/products/splitter-tap-oudoor-fot-216-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/OUTDOOR-TAP-216A-a.jpg', kategori: 'HFC', keywords: ['splitter tap outdoor fot216a'] },
  { nama: 'Splitter TAP OUDOOR FOT 214 A', url: 'https://falcom-technology.com/products/splitter-tap-oudoor-fot-214-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/OUTDOOR-TAP-214A-a.jpg', kategori: 'HFC', keywords: ['splitter tap outdoor fot214a'] },
  { nama: 'Splitter TAP OUDOOR FOT 212 A', url: 'https://falcom-technology.com/products/splitter-tap-oudoor-fot-212-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/OUTDOOR-TAP-212A-a.jpg', kategori: 'HFC', keywords: ['splitter tap outdoor fot212a'] },
  { nama: 'Splitter TAP OUDOOR FOT 211 A', url: 'https://falcom-technology.com/products/splitter-tap-oudoor-fot-211-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/OUTDOOR-TAP-211A-a.jpg', kategori: 'HFC', keywords: ['splitter tap outdoor fot211a'] },
  { nama: 'Splitter TAP OUDOOR FOT 210 A', url: 'https://falcom-technology.com/products/splitter-tap-oudoor-fot-210-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/OUTDOOR-TAP-210A-a.jpg', kategori: 'HFC', keywords: ['splitter tap outdoor fot210a'] },
  { nama: 'Splitter TAP FOT 410 A', url: 'https://falcom-technology.com/products/splitter-tap-fot-410-a/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/01/OUTDOOR-TAP-410A-a.jpg', kategori: 'HFC', keywords: ['splitter tap fot410a'] },
  // HFC — Splitter Indoor
  { nama: 'Splitter FIS 408', url: 'https://falcom-technology.com/products/splitter-fis-408/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/FIS-Splitter-408.jpg', kategori: 'HFC', keywords: ['splitter indoor fis408'] },
  { nama: 'Splitter FIS 306', url: 'https://falcom-technology.com/products/splitter-fis-306/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/FIS-Splitter-306.jpg', kategori: 'HFC', keywords: ['splitter indoor fis306'] },
  { nama: 'Splitter FIS 204', url: 'https://falcom-technology.com/products/splitter-fis-204/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/FIS-Splitter-204-1.jpg', kategori: 'HFC', keywords: ['splitter indoor fis204'] },
  // HFC — Splitter Outdoor
  { nama: 'Tap FOS 204', url: 'https://falcom-technology.com/products/tap-fos-204/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/04/FOS-204.jpg', kategori: 'HFC', keywords: ['tap outdoor fos204'] },
  { nama: 'Splitter FOS 408', url: 'https://falcom-technology.com/products/splitter-fos-408/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/04/FOS-408.jpg', kategori: 'HFC', keywords: ['splitter outdoor fos408'] },
  { nama: 'Splitter FOS 306', url: 'https://falcom-technology.com/products/splitter-fos-306/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/04/FOS-306.jpg', kategori: 'HFC', keywords: ['splitter outdoor fos306'] },

  // Fiber Broadband Unit — FBE
  { nama: 'ONB Optical Network Base 22', url: 'https://falcom-technology.com/products/onb-optical-network-base-22/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/ONB-Optical-Network-Base-22.jpg', kategori: 'Fiber Broadband Unit', keywords: ['onb optical network base 22', 'fbe 22'] },
  { nama: 'ONB Optical Network Base 20', url: 'https://falcom-technology.com/products/onb-optical-network-base-20/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/ONB-Optical-Network-Base-20.jpg', kategori: 'Fiber Broadband Unit', keywords: ['onb optical network base 20', 'fbe 20'] },
  // Fiber Broadband Unit — FBM
  { nama: 'FBM-1501', url: 'https://falcom-technology.com/products/fbm-1501/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/FBM-1501L.jpg', kategori: 'Fiber Broadband Unit', keywords: ['fbm-1501', 'fiber broadband master 1501'] },
  { nama: 'FBM-1301', url: 'https://falcom-technology.com/products/fbm-1301/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/10/FBM-1301.jpg', kategori: 'Fiber Broadband Unit', keywords: ['fbm-1301', 'fiber broadband master 1301'] },
  // Fiber Broadband Unit — Modem
  { nama: 'MODEM ES 27 + WiFi', url: 'https://falcom-technology.com/products/modem-es-27-wifi/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/MODEM-ES-27-A.jpg', kategori: 'Fiber Broadband Unit', keywords: ['modem es27 wifi', 'modem catv wifi'] },
  { nama: 'MODEM BROADBAND 1 RF+1 ETH', url: 'https://falcom-technology.com/products/modem-broadband-1-rf1-eth/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/EoC-Slave-1-RF1-ETH-CNCR-CLJ300W-D-S.jpg', kategori: 'Fiber Broadband Unit', keywords: ['modem broadband 1 rf 1 ethernet'] },

  // Media Converter & Switch — Media Converter
  { nama: 'Media Converter Netlink HTB-3100-AB', url: 'https://falcom-technology.com/products/media-converter-netlink-htb-3100-ab/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/06/Media-Converter-Netlink-HTB-3100-AB.jpg', kategori: 'Media Converter & Switch', keywords: ['media converter netlink htb3100'] },
  { nama: 'Media Converter FX-LINK', url: 'https://falcom-technology.com/products/media-converter-fx-link/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/12/Fast-Ethernet-Converter-C.jpg', kategori: 'Media Converter & Switch', keywords: ['media converter fx-link'] },
  { nama: 'MEDIA CONVERTER 10/100/1000 MBPS WOR-942ASS20-SC', url: 'https://falcom-technology.com/products/media-converter-10-100-1000-mbps-wor-942ass20-sc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/MEDIA-CONVERTER-101001000-MBPS-WOR-942ASS20-SC-gmb1.jpg', kategori: 'Media Converter & Switch', keywords: ['media converter gigabit wor942', 'media converter fiber ke ethernet gigabit'] },
  { nama: 'MEDIA CONVERTER 10/100/1000 MBPS WOR-922ASS20-SC', url: 'https://falcom-technology.com/products/media-converter-10-100-1000-mbps-wor-922ass20-sc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/06/FX-LINK-MEDIA-CONVERTER-101001000-MBPS-WOR-922ASS20-SC-gmb1.jpg', kategori: 'Media Converter & Switch', keywords: ['media converter gigabit wor922'] },
  { nama: 'Media Converter 10/100 Mbps WOR-840ASS20-SC', url: 'https://falcom-technology.com/products/media-converter-10-100-mbps-wor-840ass20-sc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/Fiber-atau-T-Transceiver.jpg', kategori: 'Media Converter & Switch', keywords: ['media converter fast ethernet wor840'] },
  { nama: 'Media Converter 10/100 Mbps WOR-810ASS20-SC', url: 'https://falcom-technology.com/products/media-converter-10100-mbps-wor-810ass20-sc/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/Media-Converter-10100-Mbps-WOR-810ASS20-SC-gmb-1.jpg', kategori: 'Media Converter & Switch', keywords: ['media converter fast ethernet wor810'] },
  // Media Converter & Switch — Switch
  { nama: 'Switch 10/100 Mbps, WOR-SYF-08M, 8x RJ45', url: 'https://falcom-technology.com/products/switch-10-100-mbps-wor-syf-08m-8x-rj45/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/SWITCH-8-PORT.jpg', kategori: 'Media Converter & Switch', keywords: ['switch 8 port fast ethernet', 'switch hub 8 port'] },
  { nama: 'Switch 10/100 Mbps, WOR-SYF-05M, 5x RJ45', url: 'https://falcom-technology.com/products/fast-ethernet-switch/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/Fast-Ethernet-Switch.jpg', kategori: 'Media Converter & Switch', keywords: ['switch 5 port fast ethernet'] },
  { nama: 'Gigabit Ethernet Fiber Switch', url: 'https://falcom-technology.com/products/gigabit-ethernet-fiber-switch/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/Gigabit-Ethernet-Fiber-Switch.jpg', kategori: 'Media Converter & Switch', keywords: ['switch fiber gigabit', 'switch fiber optik'] },

  // Wireless Access Point
  { nama: 'Wireless-N WiFi Repeater Black', url: 'https://falcom-technology.com/products/wireless-n-wifi-repeater-black/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/06/Wireless-N-Repeater-Black.jpg', kategori: 'Wireless Access Point', keywords: ['wifi repeater hitam', 'penguat sinyal wifi wireless-n'] },
  { nama: 'Wireless-N WiFi Repeater White', url: 'https://falcom-technology.com/products/wireless-repeater/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/06/Wireless-Repeater.jpg', kategori: 'Wireless Access Point', keywords: ['wifi repeater putih'] },
  { nama: 'Wireless Range Extender', url: 'https://falcom-technology.com/products/wireless-range-extender/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/Wireless-Range-Extender.jpg', kategori: 'Wireless Access Point', keywords: ['wifi range extender', 'penguat jangkauan wifi'] },
  { nama: 'Wireless Range Extender – White', url: 'https://falcom-technology.com/products/wireless-range-extender-white/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/Extender.jpg', kategori: 'Wireless Access Point', keywords: ['wifi range extender putih'] },
  { nama: 'Wireless Access Point Outdoor', url: 'https://falcom-technology.com/products/wireless-access-point-outdoor/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/05/Wireless-Access-Point-Outdoor.jpg', kategori: 'Wireless Access Point', keywords: ['access point outdoor', 'wap luar ruangan tahan cuaca'] },

  // Tools & Spareparts — Spareparts
  { nama: 'TUNER AGILE', url: 'https://falcom-technology.com/products/tuner-agile/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/TUNER-AGILE-a.jpg', kategori: 'Tools & Spareparts', keywords: ['tuner agile catv'] },
  { nama: 'TRAVO H500', url: 'https://falcom-technology.com/products/travo-h500/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/TRAVO-H500.jpg', kategori: 'Tools & Spareparts', keywords: ['travo trafo h500'] },
  { nama: 'REGULATOR OLT', url: 'https://falcom-technology.com/products/regulator-olt/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/REGULATOR-OLT-a.jpg', kategori: 'Tools & Spareparts', keywords: ['regulator olt'] },
  { nama: 'REGULATOR E203', url: 'https://falcom-technology.com/products/regulator-e203/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/REGULATOR-E203.jpg', kategori: 'Tools & Spareparts', keywords: ['regulator e203'] },
  { nama: 'REGULATOR D500', url: 'https://falcom-technology.com/products/regulator-d500/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/REGULATOR-D500.jpg', kategori: 'Tools & Spareparts', keywords: ['regulator d500'] },
  { nama: 'REGULATOR 963MW', url: 'https://falcom-technology.com/products/regulator-963mw/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/REGULATOR-963MW-gbr-a.jpg', kategori: 'Tools & Spareparts', keywords: ['regulator 963mw'] },
  // Tools & Spareparts — Tools FTTH
  { nama: 'TANGGA TELESKOPIK SILVER ROVER', url: 'https://falcom-technology.com/products/tangga-teleskopik-silver-rover/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/12/Tangga-Rover-Silver-a.jpg', kategori: 'Tools & Spareparts', keywords: ['tangga teleskopik silver', 'tangga lipat teknisi'] },
  { nama: 'TANGGA TELESKOPIK DOUBLE LADDER BLACK EDITION ROVER', url: 'https://falcom-technology.com/products/tangga-teleskopik-double-ladder-black-edition-rover/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/12/Tangga-Rover-Doble-a.jpg', kategori: 'Tools & Spareparts', keywords: ['tangga double ladder hitam'] },
  { nama: 'TANGGA TELESKOPIK BLACK EDITION ROVER', url: 'https://falcom-technology.com/products/tangga-teleskopik-black-edition-rover/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/12/Tangga-Rover-63.jpg', kategori: 'Tools & Spareparts', keywords: ['tangga teleskopik hitam'] },
  { nama: 'TANG STRIPPER', url: 'https://falcom-technology.com/products/tang-stripper/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/11/TANG-STRIPPER.jpg', kategori: 'Tools & Spareparts', keywords: ['tang stripper kabel fo', 'alat kupas kabel fiber'] },
  { nama: 'Tang Crimping Lan RJ11, RJ45 OW-TOOLS', url: 'https://falcom-technology.com/products/tang-crimping-lan-rj11-rj45-ow-tools/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/TANG-CRIMPING-RG11.jpg', kategori: 'Tools & Spareparts', keywords: ['tang crimping rj45 rj11'] },
  { nama: 'Tang Crimping Lan RJ-45, RJ12, RJ11 OW-HT315', url: 'https://falcom-technology.com/products/tang-crimping-lan-rj-45-rj12-rj11-ow-ht315/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/TANG-CRIMPING-RG45-RG12-RG11.jpg', kategori: 'Tools & Spareparts', keywords: ['tang crimping rj45 rj12 ht315'] },
  { nama: 'SPLICER OPTIC DVP 740D', url: 'https://falcom-technology.com/products/splicer-optic-dvp-740d/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/01/DVP-740D-A.jpg', kategori: 'Tools & Spareparts', keywords: ['fusion splicer dvp740d', 'alat sambung fiber'] },
  { nama: 'SPLICER OPTIC AI-9', url: 'https://falcom-technology.com/products/splicer-optic-ai-9/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/11/SPLICER-OPTIC-AI-9.jpg', kategori: 'Tools & Spareparts', keywords: ['fusion splicer ai-9'] },
  { nama: 'Optical Fusion Splicer KL-360T Backbone Jilong', url: 'https://falcom-technology.com/products/optical-fusion-splicer-kl-360e-backbone-jilong/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/04/Splicer-JILONG-KL-360E-a.jpg', kategori: 'Tools & Spareparts', keywords: ['fusion splicer kl-360t jilong', 'splicer backbone'] },
  { nama: 'Optical Fusion Splicer KL-280T FALCOM', url: 'https://falcom-technology.com/products/optical-fusion-splicer-kl-280t-falcom/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/10/Splicer-JILONG-KL-280T-A-RE.jpg', kategori: 'Tools & Spareparts', keywords: ['fusion splicer kl-280t falcom'] },
  { nama: 'Optical Fusion Splicer 500E Compact FTTx', url: 'https://falcom-technology.com/products/fiber-fusion-splicer-500e-compact-fttx/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/04/FUSION-SPLISER-500E-A.jpg', kategori: 'Tools & Spareparts', keywords: ['fusion splicer 500e compact fttx'] },
  { nama: 'Optical Fusion Splicer 300T', url: 'https://falcom-technology.com/products/optical-fusion-splicer-300t/', gambar: 'https://falcom-technology.com/wp-content/uploads/2026/06/JILONG-300T-a.jpg', kategori: 'Tools & Spareparts', keywords: ['fusion splicer 300t'] },
  { nama: 'Optical Fusion Splicer 260t', url: 'https://falcom-technology.com/products/optical-fusion-splicer-260t/', gambar: 'https://falcom-technology.com/wp-content/uploads/2026/03/JILONG-KL260T-a-1.jpg', kategori: 'Tools & Spareparts', keywords: ['fusion splicer 260t'] },
  { nama: 'OPTIC POWER METER', url: 'https://falcom-technology.com/products/optic-power-meter/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/11/Optic-Power-Meter.jpg', kategori: 'Tools & Spareparts', keywords: ['power meter fiber optik', 'alat ukur redaman'] },
  { nama: 'FUSION SPLICER TEKCN SUPER X', url: 'https://falcom-technology.com/products/fusion-splicer-tekcn-super-x/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/07/ARC-FUSION-SPLICER-A.jpg', kategori: 'Tools & Spareparts', keywords: ['fusion splicer tekcn super x'] },
  { nama: 'Fiber Cleaver KL-23F', url: 'https://falcom-technology.com/products/fiber-cleaver-kl-23f/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/04/FIBER-CLEAVER-KL-23F-a.jpg', kategori: 'Tools & Spareparts', keywords: ['cleaver kl-23f', 'alat potong fiber'] },
  { nama: 'FIBER CLEAVER KL-21B', url: 'https://falcom-technology.com/products/fiber-cleaver-kl-21b/', gambar: 'https://falcom-technology.com/wp-content/uploads/2024/05/FIBER-CLEAVER-KL-21B-a.jpg', kategori: 'Tools & Spareparts', keywords: ['cleaver kl-21b'] },
  { nama: 'FIBER CLEAVER FC6S', url: 'https://falcom-technology.com/products/fiber-cleaver-fc6s/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/11/FIBER-CLEAVER-FC6S-a.jpg', kategori: 'Tools & Spareparts', keywords: ['cleaver fc6s'] },
  { nama: 'DB METER FC1001', url: 'https://falcom-technology.com/products/db-meter-fc1001/', gambar: 'https://falcom-technology.com/wp-content/uploads/2023/11/DB-Meter-fc1001-a.jpg', kategori: 'Tools & Spareparts', keywords: ['db meter fc1001', 'alat ukur db fiber'] },

  // Rack
  { nama: 'CLOSE RACK', url: 'https://falcom-technology.com/products/close-rack/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/07/CLOSE-RACK.jpg', kategori: 'Rack', keywords: ['rack tertutup', 'close rack server'] },
  { nama: 'OPEN RACK', url: 'https://falcom-technology.com/products/open-rack/', gambar: 'https://falcom-technology.com/wp-content/uploads/2021/04/RACK.jpg', kategori: 'Rack', keywords: ['rack terbuka', 'open rack server'] },
];

// Loose match: what fraction of a keyword PHRASE's words appear anywhere in the message —
// tolerates reordering, extra words, and partial phrasing (per user's matching rules), unlike a
// strict substring check.
function phraseMatchScore(phrase, nMsg) {
  const words = phrase.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length) return 0;
  const hits = words.filter((w) => nMsg.includes(w)).length;
  return hits / words.length;
}

// Product catalog lookup — returns up to 5 best-matching products (ranked), or null if nothing
// scores high enough. Kept separate from PRODUCT_CATEGORIES: this is for SPECIFIC product
// questions ("ODP 16 port hitam"), categories handle broader ones ("kabel fiber optik apa saja").
function findProductCatalogMatch(message) {
  const nMsg = normText(message);
  const scored = [];
  for (const p of PRODUCT_CATALOG) {
    let best = 0;
    for (const kw of p.keywords) {
      const s = phraseMatchScore(kw, nMsg);
      if (s > best) best = s;
    }
    if (best >= 0.6) scored.push({ p, score: best });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return {
    jumlahCocok: scored.length,
    produk: scored.slice(0, 5).map((x) => ({ nama: x.p.nama, url: x.p.url, gambar: x.p.gambar, kategori: x.p.kategori })),
  };
}

// Confirmed by MKI Makassar directly — stock codes and catalog model numbers can't be reliably
// bridged by fuzzy text matching alone (see resolveStockCodeToCatalogProduct below), so any
// mapping actually confirmed by a human takes ABSOLUTE priority over that guesswork. Add more
// entries here as they get confirmed; key = stock kode (as in the sheet), value = EXACT catalog
// "nama" string (must match a PRODUCT_CATALOG entry's nama field verbatim).
const KNOWN_CODE_TO_CATALOG = {
  KSFO108: 'Kabel fiber optik GJYXCH-1F Super Premium Dropcore 1,2 mm',
  KSFO028: 'Kabel fiber optik GJYXCH-1F Premium Dropcore 1 Core (1 Messenger)',
};
function resolveKnownCodeOverride(message) {
  const keywords = extractKeywords(message);
  for (const kw of keywords) {
    const ckw = normCode(kw);
    const nama = KNOWN_CODE_TO_CATALOG[ckw];
    if (!nama) continue;
    const p = PRODUCT_CATALOG.find((x) => x.nama === nama);
    if (p) return { jumlahCocok: 1, produk: [{ nama: p.nama, url: p.url, gambar: p.gambar, kategori: p.kategori }] };
  }
  return null;
}

// The product CATALOG (marketing pages) only has full descriptive names/keywords, never SKU-style
// codes — but users very naturally ask about a product using the CODE they see in stock/invoices
// ("spek KSFO108"), which never overlaps with any catalog keyword on its own. Bridge the two: look
// the code up in the STOCK data to get its real description ("Kabel Fiber Optik 1Core G657A ..."),
// which DOES have enough descriptive words for the catalog's phrase matching to find the product.
function resolveStockCodeDescriptions(message, allStock) {
  if (!allStock || !allStock.length) return [];
  const keywords = extractKeywords(message);
  const found = [];
  for (const kw of keywords) {
    const ckw = normCode(kw);
    if (ckw.length < 4) continue;
    const item = allStock.find((p) => normCode(p.kode) === ckw);
    if (item && item.nama) found.push(item.nama);
  }
  return found;
}

const CABLE_CATEGORIES = new Set(['Optical Fiber Cable', 'LAN Cable', 'Coaxial Cable']);
function extractCoreCount(text) {
  const m = normText(text).match(/(\d+)\s*core/);
  return m ? m[1] : null;
}

// Bridging a resolved stock CODE to a catalog product needs to be much stricter than the general
// findProductCatalogMatch below (used for free-text browsing, where offering several loose options
// to clarify is fine) — a wrong single guess here is worse than none, and the catalog's own model
// numbers (e.g. "GJYXCH-1F") have NO relation to stock codes (e.g. "KSFO108"), so matching can only
// ever go through shared descriptive wording, which plain word-overlap scoring doesn't handle well:
// a 6-core or even a totally different product (a switch, not a cable) can score just as high as
// the right cable, and the truly correct variant can score LOWER than a similar-but-wrong one, since
// nothing here penalizes a mismatched spec. Two extra filters catch what score alone can't: reject
// any candidate whose OWN text mentions a different core count than the resolved description, and
// if the description says "kabel", restrict to actual cable categories (drops unrelated categories
// like switches that happened to share enough generic words like "premium"/"messenger").
function resolveStockCodeToCatalogProduct(stockDescription) {
  const nMsg = normText(stockDescription);
  const descCore = extractCoreCount(stockDescription);
  const isCable = /\bkabel\b|\bcable\b/.test(nMsg);
  const scored = [];
  for (const p of PRODUCT_CATALOG) {
    if (isCable && !CABLE_CATEGORIES.has(p.kategori)) continue;
    let best = 0;
    for (const kw of p.keywords) {
      const s = phraseMatchScore(kw, nMsg);
      if (s > best) best = s;
    }
    if (best < 0.6) continue;
    if (descCore) {
      const candidateCore = extractCoreCount(`${p.nama} ${p.keywords.join(' ')}`);
      if (candidateCore && candidateCore !== descCore) continue;
    }
    scored.push({ p, score: best });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  // Genuinely ambiguous even after filtering (several close variants survived) — present up to 3
  // as candidates to confirm rather than silently betting on whichever happened to score highest.
  const top = scored.filter((x) => x.score >= scored[0].score - 0.15).slice(0, 3);
  return {
    jumlahCocok: top.length,
    produk: top.map((x) => ({ nama: x.p.nama, url: x.p.url, gambar: x.p.gambar, kategori: x.p.kategori })),
  };
}

function matchReferences(message, allStock) {
  // The resolved stock-code description (see resolveStockCodeDescriptions) is ONLY for bridging a
  // code to its catalog product photo/link below — it must never leak into video/tutorial/category
  // matching, which should only ever reflect what the user actually typed. It used to be mixed
  // into one shared "augmented message" used everywhere, which caused a real bug: asking about a
  // product's spec by code alone would pull in an unrelated tutorial video, just because the
  // product's technical description happened to loosely overlap with that video's keywords.
  const stockDescriptions = resolveStockCodeDescriptions(message, allStock);
  const nMsg = ` ${normText(message)} `; // padded so ' ap ' / ' rack ' style keywords can match at string edges
  const kategoriProduk = PRODUCT_CATEGORIES.filter((c) => c.keywords.some((kw) => nMsg.includes(kw)));
  const solusiSistem = SOLUTIONS.filter((s) => s.keywords.some((kw) => nMsg.includes(kw)));
  const wantsTutorial = /tutorial|cara pasang|cara install|cara setting|cara konfigurasi|cara pakai|cara menggunakan|troubleshoot|bagaimana cara|video (tutorial|demo)/.test(nMsg);
  const wantsArticle = /\bartikel\b|berita teknis/.test(nMsg);
  const wantsSpec = /\bspek\b|spesifikasi|datasheet/.test(nMsg);
  const video = matchVideos(message);
  // A resolved stock CODE goes through the stricter dedicated matcher (core-count + category
  // filtering, see resolveStockCodeToCatalogProduct) instead of the general one — the code itself
  // already pins down one exact physical item, so the noisier free-text matcher's tolerance for
  // several loosely-related options (including flat-out wrong specs) isn't appropriate here.
  const produkSpesifik =
    resolveKnownCodeOverride(message) ||
    (stockDescriptions.length ? resolveStockCodeToCatalogProduct(stockDescriptions.join(' ')) : findProductCatalogMatch(message));
  const hasAnyMatch = kategoriProduk.length || solusiSistem.length || wantsTutorial || wantsArticle || video.teknis.length || produkSpesifik;
  return {
    produkSpesifikCocok: produkSpesifik,
    kategoriProduk,
    solusiSistem,
    // Generic bundle (Bantuan & Dukungan + Kelas Pelatihan FTTX + Galeri Video + Channel) is a
    // FALLBACK only — if a specific video already matched, that's more useful/less cluttered
    // than dumping all 4 generic links alongside it.
    tutorialDanDukungan: wantsTutorial && !video.teknis.length ? TUTORIAL_LINKS : [],
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

// Scans conversation HISTORY (most recent first) for the last product CODE actually mentioned —
// same pattern as the attendance context's person-carryover fix. Without this, a natural follow-up
// like "ada stok gak?" or "harganya berapa?" right after discussing a specific code has nothing in
// the CURRENT message to search by, findStockMatches comes back completely empty, and Gemini — with
// no real data in context — was observed fabricating a plausible-sounding but entirely made-up
// stock figure instead of saying the data wasn't found.
function findLastMentionedStockCode(history, allStock) {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (!h || !h.text) continue;
    for (const kw of extractKeywords(h.text)) {
      const ckw = normCode(kw);
      if (ckw.length < 4) continue;
      if (allStock.some((p) => normCode(p.kode) === ckw)) return ckw;
    }
  }
  return null;
}

// Matches stock by product code (typo/format tolerant: "DKB180" == "DKB-180" == "DKB 180",
// plus up to ~2-char edit-distance) or by description keyword (handles "kabel 1 core yang
// ready", "odp yang ready", etc.), then optionally narrows to in-stock only for "ready"-style asks.
// A bare company mention ("stok MKI", "stock CFN") with no product keyword at all used to come
// back completely empty — the company (MKI/CFN) is a per-item FIELD (stokMKI/stokCFN), never
// checked against at all — so it now falls through to a company-wide summary instead.
function findStockMatches(message, allStock, history) {
  const nMsgStock = normText(message);
  const company = /\bmki\b/.test(nMsgStock) ? 'MKI' : /\bcfn\b/.test(nMsgStock) ? 'CFN' : null;
  // Generic phrasing words ("stok", "hari ini") aren't product search terms — extractKeywords()
  // only strips filler like "apa"/"yang"/"dong", not domain words like these, so without this
  // filter a bare "Stok CFN hari ini" left "stok"/"hari" behind as fake keywords, which made the
  // company-wide-summary branch below think there was still a specific product to search for and
  // it never fired — every bare company question came back completely empty instead.
  const keywords = extractKeywords(message).filter((kw) => !/^(mki|cfn|stok|stock|hari|skrg|sekarang)$/i.test(kw));

  if (company && keywords.length === 0) {
    const field = company === 'MKI' ? 'stokMKI' : 'stokCFN';
    const inStock = allStock.filter((p) => p[field] > 0);
    const totalQty = inStock.reduce((sum, p) => sum + p[field], 0);
    const top = [...inStock].sort((a, b) => b[field] - a[field]).slice(0, 30);
    return {
      items: top,
      note: `Ringkasan stok company ${company}: ${inStock.length} kode barang punya stok > 0, total ${totalQty} unit (jumlah dari field "${field}" tiap item). Ditampilkan 30 kode teratas urut stok terbanyak — kalau user tanya kode spesifik, sebutkan field ${field}-nya, bukan stokTotal (itu gabungan MKI+CFN).`,
    };
  }

  let usedHistoryCode = null;
  let effectiveKeywords = keywords;
  if (keywords.length === 0) {
    usedHistoryCode = findLastMentionedStockCode(history, allStock);
    if (!usedHistoryCode) return { items: [], note: 'Tidak ada kata kunci spesifik terdeteksi di pertanyaan.' };
    effectiveKeywords = [usedHistoryCode];
  }
  const wantsReady = /ready|tersedia|stok|stock|\bada\b/.test(nMsgStock);

  let matched = allStock.filter((p) => {
    const nKode = normCode(p.kode);
    const nNama = normText(p.nama);
    return effectiveKeywords.some((kw) => {
      const nkw = normText(kw);
      const ckw = normCode(kw);
      if (ckw.length >= 3 && nKode.includes(ckw)) return true;
      if (nkw.length >= 3 && nNama.includes(nkw)) return true;
      if (ckw.length >= 4 && ckw.length <= 12 && levenshtein(ckw, nKode) <= 2) return true;
      return false;
    });
  });

  // Keywords existed but matched no real product — likely a follow-up referring back to whatever
  // was just discussed ("ada stok gak?") rather than a genuinely new, unmatched search. Retry
  // against the last code mentioned in history before giving up.
  if (!matched.length && !usedHistoryCode) {
    usedHistoryCode = findLastMentionedStockCode(history, allStock);
    if (usedHistoryCode) matched = allStock.filter((p) => normCode(p.kode) === usedHistoryCode);
  }

  let note = usedHistoryCode ? `Kode tidak disebut ulang di pertanyaan ini — dilanjutkan dari kode ${usedHistoryCode} yang dibahas sebelumnya. ` : '';
  if (company) {
    const field = company === 'MKI' ? 'stokMKI' : 'stokCFN';
    matched = matched.filter((p) => p[field] > 0);
    note += `Difilter hanya company ${company} (field ${field} > 0). `;
  }
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

// "Total nilai stok kita berapa?" / "Nilai stok rupiah MKI?" — Rupiah VALUE of on-hand stock
// (harga x quantity summed across every item), distinct from findStockMatches's quantity-only
// summary above. Company-aware: sums stokMKI/stokCFN x harga when a company is named, else
// stokTotal x harga for the combined figure. Items without a harga are skipped (can't value them),
// not silently treated as zero, so the total isn't understated without saying so.
function findStockValueSummary(message, allStock) {
  const nMsg = normText(message);
  if (!(/\bnilai\b/.test(nMsg) && /\bstok\b/.test(nMsg))) return null;
  const company = /\bmki\b/.test(nMsg) ? 'MKI' : /\bcfn\b/.test(nMsg) ? 'CFN' : null;
  const field = company === 'MKI' ? 'stokMKI' : company === 'CFN' ? 'stokCFN' : 'stokTotal';
  let totalNilaiRupiah = 0;
  let totalUnit = 0;
  let jumlahKodeBarang = 0;
  let jumlahKodeTanpaHarga = 0;
  for (const p of allStock) {
    const qty = p[field] || 0;
    if (qty <= 0) continue;
    if (p.harga > 0) {
      totalNilaiRupiah += qty * p.harga;
      totalUnit += qty;
      jumlahKodeBarang++;
    } else {
      jumlahKodeTanpaHarga++;
    }
  }
  return {
    company: company || 'MKI+CFN (gabungan)',
    jumlahKodeBarang,
    totalUnit,
    totalNilaiRupiah,
    catatan: jumlahKodeTanpaHarga > 0 ? `${jumlahKodeTanpaHarga} kode barang punya stok tapi tidak punya data harga, TIDAK ikut terhitung di totalNilaiRupiah — sebutkan ini kalau relevan supaya user tahu totalnya bisa jadi lebih tinggi dari angka ini.` : 'Semua kode barang yang punya stok juga punya data harga, total ini sudah mencakup semuanya.',
  };
}

// "Produk terlaris tapi stoknya menipis" — saran restock: cross-references the top-20-by-unit
// best sellers (topProducts.byQty, already has "qty" sold this year) against CURRENT stock, and
// estimates how many months of runway remain at the current sales pace ("stokTotal" divided by
// average monthly qty sold in 2026 so far). Flags anything with <=1.5 months of runway left as
// urgent — a low absolute stock number alone doesn't mean much without knowing how fast it sells.
function findRestockCandidates(message, topProductsByQty, allStock) {
  if (!topProductsByQty || !topProductsByQty.length || !allStock || !allStock.length) return null;
  const nMsg = normText(message);
  const wantsRestock = /terlaris.*(stok|stock).*(tipis|menipis|habis|kurang|sedikit)|(stok|stock).*(tipis|menipis|habis|kurang|sedikit).*terlaris|restock|pesan.*ulang|isi.*(stok|gudang)|saran.*pemesanan|saran.*(po|pesan)/.test(nMsg);
  if (!wantsRestock) return null;

  const stockByKode = {};
  for (const p of allStock) stockByKode[p.kode] = p;
  const monthsElapsed = new Date().getMonth() + 1;

  const candidates = topProductsByQty
    .map((tp) => {
      const stockItem = stockByKode[tp.kode];
      if (!stockItem || !tp.qty) return null;
      const avgMonthlyQty = tp.qty / monthsElapsed;
      const bulanStokTersisa = avgMonthlyQty > 0 ? stockItem.stokTotal / avgMonthlyQty : null;
      return {
        kode: tp.kode,
        nama: stockItem.nama,
        qtyTerjual2026: tp.qty,
        stokSaatIni: stockItem.stokTotal,
        rataRataTerjualPerBulan: Math.round(avgMonthlyQty * 10) / 10,
        perkiraanBulanStokHabis: bulanStokTersisa === null ? null : Math.round(bulanStokTersisa * 10) / 10,
      };
    })
    .filter((c) => c && c.perkiraanBulanStokHabis !== null && c.perkiraanBulanStokHabis <= 1.5)
    .sort((a, b) => a.perkiraanBulanStokHabis - b.perkiraanBulanStokHabis);

  return {
    totalKandidat: candidates.length,
    daftar: candidates.slice(0, 40),
    catatan: 'Kandidat = produk terlaris (top-20 unit terjual 2026) yang perkiraan stoknya habis dalam <=1,5 bulan lagi berdasarkan kecepatan jual rata-rata — urut dari yang PALING mendesak. "perkiraanBulanStokHabis" = stokSaatIni / rataRataTerjualPerBulan. Kalau kosong, berarti tidak ada produk terlaris yang stoknya mendesak saat ini (bukan berarti datanya gagal).',
  };
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

// Common Indonesian question/operational words that must NEVER count as a candidate name token.
// Without this, a SHORT single-word customer name (e.g. "YAYAN") can accidentally fuzzy-match an
// ordinary question word within edit-distance tolerance (e.g. "kapan" is edit-distance 2 from
// "yayan") — since a single-word name only needs ONE hit to reach the 70% threshold, this silently
// locks onto the WRONG customer (whichever false-positive happens to appear first in Set iteration
// order) and the customer the user actually asked about is never reached. Root-caused from a real
// report: "kapan pembayaran terakhir Soni Susilo" matched "YAYAN" instead.
const QUERY_NOISE_WORDS = new Set([
  'kapan', 'terakhir', 'terbaru', 'terkini', 'pembayaran', 'bayar', 'membayar', 'dibayar', 'lunas',
  'melunasi', 'pelunasan', 'cicilan', 'piutang', 'tagihan', 'invoice', 'faktur', 'nomor', 'transaksi',
  'belanja', 'membeli', 'beli', 'pembelian', 'order', 'pesan', 'memesan', 'customer', 'pelanggan',
  'sudah', 'belum', 'masih', 'punya', 'mempunyai', 'sekarang', 'tidak', 'siapa', 'berapa', 'gimana',
  'bagaimana', 'kah', 'dong', 'nih', 'sisa', 'saldo', 'total', 'jumlah', 'rincian', 'detail', 'data',
  // Ordinary Indonesian words that ALSO happen to be real customer names in this dataset (e.g. a
  // customer literally named "HARI") — confirmed live: "...30 sampai 60 hari terakhir" (asking
  // about a day RANGE) matched customer "HARI" purely because the word appears in the question.
  'saja', 'hari', 'lama', 'aktif',
]);

// True typo tolerance (not just missing/partial words): each significant word in the stored
// customer name is matched against message words either exactly OR within edit-distance 1-2
// (scaled to word length), so "Arsad Ambo Dale" still finds "MUH. ARSYAD AMBO DALLE". Message
// words are first stripped of generic question/operational words (see QUERY_NOISE_WORDS above)
// so they never masquerade as a name match.
function customerNameFuzzyMatch(msgWords, customerName) {
  const nameWords = nameWordsOf(customerName).filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w));
  if (!nameWords.length) return false;
  const candidateWords = msgWords.filter((w) => !STOPWORDS.has(w) && !QUERY_NOISE_WORDS.has(w));
  // Single-word customer names (e.g. "MASRI") are especially vulnerable to false positives — one
  // word is the WHOLE name, so a single lucky edit-distance hit already clears the 70% threshold.
  // An ordinary, extremely common Indonesian word ("saja") can coincidentally land within that
  // tolerance of a short name and hijack a completely unrelated question — confirmed live: "siapa
  // SAJA customer..." matched customer "MASRI". Not a word we can just add to a stoplist one at a
  // time (any short word could collide with some short name) — require an EXACT match instead,
  // multi-word names keep the typo tolerance since one wrong word alone won't clear 70% on those.
  if (nameWords.length === 1) return candidateWords.includes(nameWords[0]);
  const hits = nameWords.filter((nw) =>
    candidateWords.some((mw) => mw === nw || (Math.abs(mw.length - nw.length) <= 2 && levenshtein(mw, nw) <= (nw.length <= 4 ? 1 : 2)))
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

// "Retur apa saja bulan ini?" / "berapa banyak retur customer X?" — every transaction row already
// carries "isRetur" from sync (true when noInvoice starts with "R-"/"R/", or amount is negative),
// but there was no dedicated way to ask FOR returns specifically — an ordinary customer/code/date
// search would only surface a retur row if it happened to also match those filters. Optionally
// narrows further by customer (fuzzy) or date/date-range if also mentioned in the same question.
function findReturTransactions(message, allTransactions) {
  if (!allTransactions.length) return null;
  const nMsg = normText(message);
  if (!/\bretur\b|\breturn\b|\bdikembalikan\b|\bpengembalian barang\b/.test(nMsg)) return null;
  let matched = allTransactions.filter((tx) => tx.isRetur);
  const rangeMention = extractDateRangeMention(message);
  const dateMention = !rangeMention ? extractDateMention(message) : null;
  if (rangeMention) {
    matched = matched.filter((tx) => {
      const d = parseFlexibleDate(tx.tanggal);
      return d && d.getMonth() + 1 === rangeMention.month && d.getFullYear() === rangeMention.year
        && d.getDate() >= rangeMention.startDay && d.getDate() <= rangeMention.endDay;
    });
  } else if (dateMention) {
    matched = matched.filter((tx) => {
      const d = parseFlexibleDate(tx.tanggal);
      return d && d.getDate() === dateMention.day && d.getMonth() + 1 === dateMention.month && d.getFullYear() === dateMention.year;
    });
  }
  const customerSet = new Set();
  for (const tx of matched) if (tx.customer) customerSet.add(tx.customer);
  const msgWords = nameWordsOf(message);
  const hitCustomer = [...customerSet].find((c) => c.length >= 4 && customerNameFuzzyMatch(msgWords, c));
  if (hitCustomer) matched = matched.filter((tx) => tx.customer === hitCustomer);
  matched = [...matched].sort((a, b) => {
    const da = parseFlexibleDate(a.tanggal);
    const db = parseFlexibleDate(b.tanggal);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });
  const total = matched.length;
  const capped = matched.slice(0, 100);
  return {
    jumlahRetur: total,
    items: capped,
    catatan: `Retur dikenali dari nomor invoice berawalan "R-"/"R/" atau nilai transaksi negatif.${total > 100 ? ` Ditampilkan 100 TERBARU dari ${total}.` : ''}`,
  };
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

// "Siapa customer dengan piutang terbesar?" — aggregates the SAME invoice-level detail by
// customer (sum of nilaiSisa across all their open invoices) instead of by single invoice, since
// one customer can have several open invoices and the ranking should be by their TOTAL exposure,
// not any one invoice's size. Only triggers on an explicit ranking/superlative phrasing so it
// doesn't fire on every ordinary named-customer piutang question (that's findPiutangByCustomer).
function findTopPiutangCustomers(message, piutangDetail) {
  if (!piutangDetail || !piutangDetail.length) return null;
  const nMsg = normText(message);
  const wantsTop = /piutang.*(tertinggi|terbesar|paling besar|paling banyak)|(tertinggi|terbesar|paling besar|paling banyak).*piutang/.test(nMsg);
  if (!wantsTop) return null;
  const byCustomer = new Map();
  for (const p of piutangDetail) {
    if (!p.customer) continue;
    const cur = byCustomer.get(p.customer) || { customer: p.customer, totalSisaPiutang: 0, jumlahInvoice: 0 };
    cur.totalSisaPiutang += p.nilaiSisa;
    cur.jumlahInvoice += 1;
    byCustomer.set(p.customer, cur);
  }
  const ranked = [...byCustomer.values()].sort((a, b) => b.totalSisaPiutang - a.totalSisaPiutang);
  return { totalCustomerPunyaPiutang: ranked.length, top10: ranked.slice(0, 10) };
}

// Official dashboard aging buckets ("Kategori baku"), computed directly from the numeric Aging
// (days) column — see the long comment in runSync's AR section for why this replaced the sheet's
// own text Kategori column (different, inconsistent scheme).
function agingBucketOf(days) {
  if (days <= 30) return '0-30 Hari';
  if (days <= 45) return '30-45 Hari';
  if (days <= 60) return '45-60 Hari';
  return '> 60 Hari';
}

// "Siapa saja customer dengan piutang di atas 30 hari?" — lists actual invoices/names within one
// age-category bucket. Distinct from "piutang.byKategori" (totals only, no names) and from
// findPiutangByCustomer (single named customer) — this was the missing piece for "who's IN each
// bucket", not just how much each bucket totals.
function findPiutangByKategoriUmur(message, piutangDetail) {
  if (!piutangDetail || !piutangDetail.length) return null;
  const nMsg = normText(message);
  // Generic threshold phrasing ("di atas/lebih dari N hari", "N hari ke atas") isn't tied to the
  // 4 named buckets — computed directly from each invoice's own agingHari so any N works, not
  // just the dashboard's fixed 30/45/60 boundaries.
  const thresholdMatch = nMsg.match(/(?:di\s*atas|lebih\s*dari|>\s*)\s*(\d+)\s*hari|(\d+)\s*hari\s*ke\s*atas/);
  if (thresholdMatch) {
    const n = Number(thresholdMatch[1] || thresholdMatch[2]);
    if (Number.isFinite(n)) {
      const items = [...piutangDetail.filter((p) => p.agingHari > n)].sort((a, b) => b.nilaiSisa - a.nilaiSisa);
      return {
        kategori: `> ${n} Hari`,
        jumlahInvoice: items.length,
        totalNilai: items.reduce((sum, p) => sum + p.nilaiSisa, 0),
        daftar: items.slice(0, 60),
        catatan: `Dihitung langsung dari umur piutang (hari) per invoice, bukan dari salah satu 4 kategori baku dashboard. ${items.length > 60 ? `Ditampilkan 60 dari ${items.length} invoice (urut nilai terbesar).` : `Semua ${items.length} invoice ditampilkan.`}`,
      };
    }
  }
  // Named standard buckets (persis istilah baku dashboard): 0-30, 30-45, 45-60, >60 Hari.
  let kategori = null;
  if (/0\s*-?\s*(sampai\s*)?30\s*hari|kurang\s*dari\s*30\s*hari|di\s*bawah\s*30\s*hari/.test(nMsg)) kategori = '0-30 Hari';
  else if (/30\s*-?\s*(sampai\s*)?45\s*hari/.test(nMsg)) kategori = '30-45 Hari';
  else if (/45\s*-?\s*(sampai\s*)?60\s*hari/.test(nMsg)) kategori = '45-60 Hari';
  else if (/60\s*hari/.test(nMsg)) kategori = '> 60 Hari';
  if (!kategori) return null;
  const items = [...piutangDetail.filter((p) => p.kategori === kategori)].sort((a, b) => b.nilaiSisa - a.nilaiSisa);
  return {
    kategori,
    jumlahInvoice: items.length,
    totalNilai: items.reduce((sum, p) => sum + p.nilaiSisa, 0),
    daftar: items.slice(0, 60),
    catatan: items.length > 60 ? `Ditampilkan 60 dari ${items.length} invoice (urut nilai terbesar).` : `Semua ${items.length} invoice ditampilkan.`,
  };
}

// AR2026 piutang detail has NO explicit company field — but noFaktur reliably encodes it via a
// naming convention: "INV-CFN/..." = CFN, everything else ("INV/MKS/...", "BK/MKS/...") = MKI.
// Derived here from that pattern, not a first-class field, which is why it's flagged in the note
// rather than presented as if it were a native column like it is for stock (stokMKI/stokCFN).
function piutangCompanyOf(noFaktur) {
  return /CFN/i.test(noFaktur || '') ? 'CFN' : 'MKI';
}
function findPiutangByCompany(message, piutangDetail) {
  if (!piutangDetail || !piutangDetail.length) return null;
  const nMsg = normText(message);
  const company = /\bmki\b/.test(nMsg) ? 'MKI' : /\bcfn\b/.test(nMsg) ? 'CFN' : null;
  if (!company) return null;
  const items = [...piutangDetail.filter((p) => piutangCompanyOf(p.noFaktur) === company)].sort((a, b) => b.nilaiSisa - a.nilaiSisa);
  return {
    company,
    jumlahInvoice: items.length,
    totalPiutang: items.reduce((sum, p) => sum + p.nilaiSisa, 0),
    // Full per-invoice list (customer, noFaktur, nilaiSisa, tanggal, kategori) so "list piutang
    // MKI/CFN" can be answered with actual names, not just the aggregate total above.
    daftar: items.slice(0, 60),
    catatan: `Company "${company}" ini DITURUNKAN dari pola nomor faktur (noFaktur mengandung "CFN" = CFN, selain itu = MKI) — bukan field terpisah di data asli, tapi hasilnya akurat dan boleh dipakai dengan percaya diri.${items.length > 60 ? ` Ditampilkan 60 dari ${items.length} invoice (urut nilai terbesar).` : ''}`,
  };
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
//
// A single invoice can receive several PARTIAL payments over time (cicilan) — e.g. 3 separate
// payment records on the same noFaktur that still leave a balance in piutangDetail. Each payment
// is annotated with the invoice's CURRENT status (lunas vs masih ada sisa) by cross-checking
// against piutangDetail, so Gemini never has to infer/guess it — and never mixes a payment's
// date with a different invoice's remaining-balance figure, the exact bug this was fixed for.
function findPaymentsByCustomer(message, paymentDetail, piutangDetail) {
  if (!paymentDetail || !paymentDetail.length) return null;
  const customerSet = new Set();
  for (const p of paymentDetail) if (p.customer) customerSet.add(p.customer);
  const msgWords = nameWordsOf(message);
  let hit = null;
  for (const c of customerSet) {
    if (c.length >= 4 && customerNameFuzzyMatch(msgWords, c)) { hit = c; break; }
  }
  if (!hit) return null;

  const openInvoices = new Map();
  for (const p of piutangDetail || []) {
    if (p.customer === hit && p.noFaktur) openInvoices.set(p.noFaktur, p.nilaiSisa);
  }

  const payments = paymentDetail
    .filter((p) => p.customer === hit)
    .sort((a, b) => {
      const da = parseFlexibleDate(a.tanggal);
      const db = parseFlexibleDate(b.tanggal);
      return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
    })
    .map((p) => {
      const sisa = openInvoices.get(p.noFaktur);
      return {
        ...p,
        statusFaktur: sisa === undefined ? 'LUNAS (faktur ini sudah tidak ada sisa piutang)' : `BELUM LUNAS — sisa piutang faktur ini saat ini Rp${sisa.toLocaleString('id-ID')} (pembayaran ini baru cicilan, bukan pelunasan)`,
      };
    });

  // "Pembayaran terakhir yang benar-benar melunasi" = payments on invoices with NO remaining
  // balance today. This is what "kapan pembayaran/pelunasan terakhir" should answer with,
  // NOT just the chronologically-last payment record (which may be a partial/cicilan payment).
  const pembayaranMelunasi = payments.filter((p) => !openInvoices.has(p.noFaktur));

  return {
    customer: hit,
    jumlahPembayaran: payments.length,
    totalDibayar: payments.reduce((sum, p) => sum + p.amount, 0),
    pembayaranTerbaruDulu: payments,
    pembayaranYangMelunasiTerbaruDulu: pembayaranMelunasi,
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
function detectBucketFromText(nMsg) {
  if (/\b1x\b|\bsatu kali\b|\bsekali\b/.test(nMsg)) return '1x';
  if (/\b2x\b|\bdua kali\b/.test(nMsg)) return '2x';
  if (/\b(3|tiga)\s*-?\s*(sampai\s*)?(5|lima)\s*x?\b/.test(nMsg)) return '3-5x';
  if (/\b(5|lima)\s*-?\s*(sampai\s*)?(10|sepuluh)\s*x?\b/.test(nMsg)) return '5-10x';
  if (/>\s*10x?|\blebih dari 10\b|\bdiatas 10\b/.test(nMsg)) return '>10x';
  return null;
}

function findCustomerBucketMatch(message, customerBuckets, history) {
  if (!customerBuckets) return null;
  // A specific frequency mention ("1x belanja", "yang 2x", ">10x") is specific/intentional enough
  // on its own — requiring "siapa"/"nama"/"daftar"/"list" on top of that missed real phrasings like
  // "kasih customer yang 1x belanja dan belum belanja lagi" (a real reported case), which mentions
  // the bucket clearly but never those exact trigger words.
  let bucket = detectBucketFromText(normText(message));
  let fromHistory = false;
  // Follow-up like "nama customernya?" right after MIRA HERSELF proposed a bucket as a sales
  // suggestion (e.g. "customer 1x belanja adalah kandidat follow-up") doesn't repeat the bucket —
  // a real reported case where this returned "data tidak tersedia" despite the data existing.
  if (!bucket && Array.isArray(history)) {
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (!h || !h.text) continue;
      bucket = detectBucketFromText(normText(h.text));
      if (bucket) { fromHistory = true; break; }
    }
  }
  if (!bucket || !customerBuckets[bucket]) return null;
  const all = customerBuckets[bucket];
  const sample = [...all].sort((a, b) => b.totalSales - a.totalSales).slice(0, 60);
  const catatanParts = [];
  if (bucket === '1x') catatanParts.push('Bucket "1x" berarti customer ini baru belanja SATU KALI sepanjang 2026 dan belum pernah order lagi sejak itu — ini sudah otomatis berarti "belum belanja lagi", bukan filter terpisah yang perlu dicari lagi.');
  if (fromHistory) catatanParts.push('Kategori bucket ini dilanjutkan dari yang baru dibahas sebelumnya di percakapan ini (tidak disebut ulang di pertanyaan ini) — pakai dengan percaya diri, bukan berarti datanya tidak ada.');
  return {
    bucket,
    totalCustomer: all.length,
    ditampilkan: sample.length,
    customers: sample,
    catatan: catatanParts.length ? catatanParts.join(' ') : undefined,
  };
}

// Parses a "days since last purchase" range from phrasings like "30-60 hari", "30 sampai 60 hari",
// "lebih dari 30 hari", "diatas 60 hari", "≥60 hari" — used by findInactiveCustomers below.
// "churn"/"churned" is treated as its own alias for ">=60 hari" since that's the exact threshold
// customerInsights.totalChurned itself uses — MIRA's own replies use that wording.
function extractInactivityDayRange(text) {
  const nMsg = normText(text);
  const rangeMatch = nMsg.match(/(\d{1,3})\s*(?:-|sampai|s\/d|hingga)\s*(\d{1,3})\s*hari/);
  if (rangeMatch) {
    const a = parseInt(rangeMatch[1], 10);
    const b = parseInt(rangeMatch[2], 10);
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const gtMatch = nMsg.match(/(?:lebih dari|diatas|di atas|>=?|≥)\s*(\d{1,3})\s*hari/);
  if (gtMatch) return { min: parseInt(gtMatch[1], 10), max: Infinity };
  const ltMatch = nMsg.match(/(?:kurang dari|dibawah|di bawah|<=?|≤)\s*(\d{1,3})\s*hari/);
  if (ltMatch) return { min: 0, max: parseInt(ltMatch[1], 10) };
  if (/\bchurn(ed)?\b/.test(nMsg)) return { min: 60, max: Infinity };
  return null;
}

// Also checks if a bare day-range mention alone (without one of the explicit inactivity phrases)
// still counts as "wants this topic" — split out so both the current message AND history scanning
// below can reuse the exact same rule.
function wantsInactivityTopicText(text) {
  return !!extractInactivityDayRange(text) || /lama\s*tidak\s*belanja|tidak\s*aktif|belum\s*belanja\s*lagi|tidak\s*order\s*lagi|sudah\s*berapa\s*hari|\bchurn(ed)?\b/.test(normText(text));
}

// "Customer yang sudah lama tidak belanja, 30-60 hari terakhir" / "sudah berapa hari X tidak
// belanja?" — the sync-computed customerList has daysSinceLastPurchase for EVERY customer, not
// just the top 20 that customerInsights keeps, so an arbitrary day-range filter needs this
// separately-cached full list (data:customerActivity). Also supports filtering by a specific
// customer NAME (checked first) so "apakah [nama] termasuk yang lama tidak belanja?" works even
// without a day range — a bare day range with nothing else returns null (nothing concrete to show).
function findInactiveCustomers(message, customerActivity, history) {
  if (!customerActivity || !customerActivity.length) return null;

  // Named-customer check always uses the CURRENT message — asking about one person doesn't need
  // topic carryover from history.
  const msgWords = nameWordsOf(message);
  const namedCustomer = customerActivity.find((c) => c.customer && c.customer.length >= 4 && customerNameFuzzyMatch(msgWords, c.customer));
  if (namedCustomer) return { modeCustomerSpesifik: true, customer: namedCustomer };

  let dayRange = extractInactivityDayRange(message);
  let fromHistory = false;
  if (!dayRange && !wantsInactivityTopicText(message) && Array.isArray(history)) {
    // Follow-up like "nama customernya?" right after MIRA HERSELF proposed a churned/inactive
    // segment as a sales-follow-up suggestion — a real reported case where this incorrectly said
    // the data wasn't available, when it was just never re-mentioned in THIS specific message.
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (!h || !h.text) continue;
      if (wantsInactivityTopicText(h.text)) {
        dayRange = extractInactivityDayRange(h.text) || { min: 60, max: Infinity };
        fromHistory = true;
        break;
      }
    }
  }
  if (!dayRange) return null;

  const items = customerActivity.filter(
    (c) => c.daysSinceLastPurchase !== null && c.daysSinceLastPurchase >= dayRange.min && c.daysSinceLastPurchase <= dayRange.max
  );
  const sorted = [...items].sort((a, b) => b.daysSinceLastPurchase - a.daysSinceLastPurchase);
  return {
    modeCustomerSpesifik: false,
    rentangHari: dayRange,
    totalCustomer: sorted.length,
    daftar: sorted.slice(0, 80),
    catatan:
      (fromHistory ? 'Rentang hari ini dilanjutkan dari topik "tidak aktif/churn" yang baru dibahas sebelumnya di percakapan ini (tidak disebut ulang di pertanyaan ini) — pakai dengan percaya diri, bukan berarti datanya tidak ada. ' : '') +
      (sorted.length > 80 ? `Ditampilkan 80 dari ${sorted.length} customer (urut paling lama tidak belanja duluan).` : `Semua ${sorted.length} customer ditampilkan.`),
  };
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

// "hari ini"/"kemarin" are far more common in real questions than a spelled-out date, and a plain
// "kinerja [nama]" with NO date word at all should still resolve to a real day (today) rather than
// silently falling through to a shallow multi-day summary. Only an explicit trend/rekap phrasing
// ("kinerja bulan ini", "rekap seminggu terakhir") should skip the single-day detail view.
function resolveAttendanceDate(message) {
  const nMsg = normText(message);
  const explicit = extractDateMention(message);
  if (explicit) return { date: new Date(explicit.year, explicit.month - 1, explicit.day), explicit: true };
  const today = new Date();
  if (/\bkemarin lusa\b/.test(nMsg)) { const d = new Date(today); d.setDate(d.getDate() - 2); return { date: d, explicit: true }; }
  if (/\bkemarin\b/.test(nMsg)) { const d = new Date(today); d.setDate(d.getDate() - 1); return { date: d, explicit: true }; }
  if (/\bhari ini\b|\bsekarang\b|\bskrg\b|\bhari ni\b/.test(nMsg)) return { date: today, explicit: true };
  return { date: today, explicit: false };
}

// "Siapa yang jam kerjanya paling banyak bulan ini?" — the monthly teamOverview sync (data:kpi)
// already carries "totalWorkHours" per person (cumulative hours across the month so far), so this
// is a plain sort of already-cached data — no extra live Apps Script call needed, unlike a
// per-person personView fetch which would be slow done for every team member.
function findWorkHoursRanking(message, kpiData) {
  if (!kpiData || !Array.isArray(kpiData.kpi) || !kpiData.kpi.length) return null;
  const nMsg = normText(message);
  if (!(/jam\s*kerja/.test(nMsg) && /(terbanyak|paling banyak|terlama|paling lama|tertinggi|terkecil|paling sedikit|tersedikit)/.test(nMsg))) return null;
  const ranking = [...kpiData.kpi]
    .filter((p) => typeof p.totalWorkHours === 'number')
    .sort((a, b) => b.totalWorkHours - a.totalWorkHours)
    .map((p) => ({ nama: p.nama, totalJamKerja: p.totalWorkHours, hariKerjaBerjalan: p.hariKerjaBerjalan, hariSubmitReal: p.hariSubmitReal }));
  return { bulan: kpiData.month, catatan: 'totalJamKerja = akumulasi jam kerja (jam pulang - jam datang) sepanjang bulan berjalan sampai hari ini, sudah terurut dari yang PALING BANYAK.', ranking };
}

async function fetchAttendanceContext(message, kpiNames, history) {
  const nMsg = normText(message);
  const wantsAttendance = /jam\s*masuk|jam\s*pulang|jam\s*datang|\btelat\b|terlambat|\babsen\b|absensi|kehadiran/.test(nMsg);
  const wantsIndicator = /indikator|checklist|ceklist|kerjakan|dikerjakan|kegiatan harian|dikerjain|rincikan|rinciannya|detailnya|\bkinerja\b/.test(nMsg);
  // A plain trend/recap ask ("kinerja bulan ini", "rekap seminggu terakhir", "progress bulan lalu")
  // wants the multi-day overview, NOT one day's full indicator breakdown — everything else
  // (including a bare "kinerja [nama]" with no date/scope word) defaults to today's full detail.
  const wantsTrend = /\bminggu\b|\bmingguan\b|\bbulan ini\b|\bbulan lalu\b|\brekap\b|\bringkasan\b|\btren\b|\btrend\b|belakangan ini|beberapa hari|sebulan/.test(nMsg);
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

  const { date: targetDate, explicit: dateExplicit } = resolveAttendanceDate(message);
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

      if (wantsTrend && !dateExplicit) {
        // Explicit trend/recap ask with no specific day — multi-day overview, not full detail.
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

      // Default path — full single-day breakdown (attendance + EVERY indicator + its evidence
      // detail), same depth as the "Cek Indikator per Tanggal" view on the dashboard. If the exact
      // target day has no data and the user didn't ask for that day specifically (e.g. plain
      // "kinerja Bahrul" defaulted to today, but today isn't submitted yet), fall back to the most
      // recent day that DOES have data instead of returning an empty answer.
      let dayEntry = days.find((d) => d.tanggal === isoDay);
      if (!dayEntry && !dateExplicit) {
        const past = days.filter((d) => d.tanggal <= isoDay).sort((a, b) => (a.tanggal < b.tanggal ? 1 : -1));
        dayEntry = past[0] || null;
      }
      if (!dayEntry) {
        return { nama: personHit, tanggal: isoDay, catatan: 'Tidak ada data untuk tanggal ini (mungkin hari libur, belum lewat, atau belum submit).' };
      }
      return {
        nama: personHit,
        tanggal: dayEntry.tanggal,
        catatan: dateExplicit || dayEntry.tanggal === isoDay ? undefined : `Tanggal ${isoDay} belum ada data, ini data hari kerja terakhir yang tersedia.`,
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
    // Full per-customer activity (incl. daysSinceLastPurchase for EVERY customer, not just top 20
    // like customerInsights below) — needed to filter "customer tidak aktif 30-60 hari" by an
    // arbitrary day range or a specific name, neither of which a top-20-only list can support.
    await env.SHEET_CACHE.put('data:customerActivity', JSON.stringify(customerList));
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
  // 17 Kategori (sheet's OWN text, e.g. "14 - 30 Hari"/"> 30 Hari" — NOT used below), 18 Company.
  // The sheet's own Kategori column uses a DIFFERENT bucket scheme than the official dashboard's
  // "Kategori baku" (0-30 / 30-45 / 45-60 / >60 Hari, per the live dashboard's Piutang section) —
  // confirmed by cross-checking real Aging-day values against both schemes: the sheet's own text
  // buckets at 0-13/14-30/31-59(labeled ">30")/62+ (labeled ">60"), which does not line up with
  // the dashboard's stated 0-30/30-45/45-60/>60 at all. Recomputed from the numeric Aging (days)
  // column instead, matching the dashboard's own definition exactly.
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
      const agingHari = toNumber(r[16]);
      const kategori = agingBucketOf(agingHari);
      const nilai = toNumber(r[15]);
      const customer = (r[13] || '').trim().toUpperCase(); // matches dashboard's buildAR() normalization
      totalPiutang += nilai;
      if (!byKategori[kategori]) byKategori[kategori] = { kategori, jumlahInvoice: 0, totalNilai: 0 };
      byKategori[kategori].jumlahInvoice += 1;
      byKategori[kategori].totalNilai += nilai;
      detail.push({ tanggal: r[11], noFaktur: r[12], customer, nilaiSisa: nilai, agingHari, kategori });
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
    customerActivityRaw, lastSync,
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
    env.SHEET_CACHE.get('data:customerActivity'),
    env.SHEET_CACHE.get('lastSync'),
  ]);

  const allStock = stockRaw ? JSON.parse(stockRaw) : [];
  const allTransactions = txRaw ? JSON.parse(txRaw) : [];
  const allWilayahEkspedisi = wilayahRaw ? JSON.parse(wilayahRaw) : [];
  const piutangData = piutangRaw ? JSON.parse(piutangRaw) : null;
  const kpiData = kpiRaw ? JSON.parse(kpiRaw) : null;
  const workHoursRanking = findWorkHoursRanking(message, kpiData);
  const poGudangData = poGudangRaw ? JSON.parse(poGudangRaw) : null;
  const zonaWilayahData = zonaWilayahRaw ? JSON.parse(zonaWilayahRaw) : null;
  const stokMatch = findStockMatches(message, allStock, history);
  const txMatch = findTransactionMatches(message, allTransactions);
  const returMatch = findReturTransactions(message, allTransactions);
  const wilayahMatch = findWilayahMatches(message, allWilayahEkspedisi);
  const piutangMatch = findPiutangByCustomer(message, piutangData?.detail);
  const topPiutangMatch = findTopPiutangCustomers(message, piutangData?.detail);
  const piutangKategoriMatch = findPiutangByKategoriUmur(message, piutangData?.detail);
  const piutangCompanyMatch = findPiutangByCompany(message, piutangData?.detail);
  const stockValueMatch = findStockValueSummary(message, allStock);
  const restockMatch = findRestockCandidates(message, topProductsRaw ? JSON.parse(topProductsRaw).byQty : null, allStock);
  const revenueData = revenueRaw ? JSON.parse(revenueRaw) : null;
  const paymentMatch = findPaymentsByCustomer(message, revenueData?.detail, piutangData?.detail);
  const poMatch = findPoGudangMatches(message, poGudangData?.items);
  const zonaMatch = findZonaWilayahMatches(message, zonaWilayahData);
  const customerBucketMatch = findCustomerBucketMatch(message, customerBucketsRaw ? JSON.parse(customerBucketsRaw) : null, history);
  const inactiveCustomerMatch = findInactiveCustomers(message, customerActivityRaw ? JSON.parse(customerActivityRaw) : null, history);
  const referensi = matchReferences(message, allStock);
  const kpiNames = Array.isArray(kpiData?.kpi) ? kpiData.kpi.map((p) => p.nama).filter(Boolean) : [];
  const absensi = await fetchAttendanceContext(message, kpiNames, history);

  // A handful of dashboard sections were being dumped into EVERY request in full regardless of
  // relevance (topProduk, deliveryOverview, customerInsights, stockMovement, ...) — measured at
  // ~25K prompt tokens for a plain "berapa total sales bulan ini" question, which is most of why
  // responses were slow (large prompts cost real time-to-first-token on top of Gemini's own
  // "thinking" latency). Gate these behind a topic check, same query-aware-retrieval principle
  // already used for stock/transactions/piutang, so a typical question's prompt stays small.
  const nMsgTopic = normText(message);
  const wantsTopProduk = /terlaris|paling laku|top ?produk|produk ?top|best ?seller|produk.*populer/.test(nMsgTopic);
  const wantsDeliveryOverview = /ekspedisi|pengiriman|delivery|handcarry|hand carry|same ?day|cut ?off|pihak ketiga/.test(nMsgTopic);
  const wantsCustomerInsights = /frekuensi|churn|tidak aktif|jarang belanja|paling sering belanja|loyal|repeat ?order/.test(nMsgTopic);
  const wantsFo1Core = /1.?core|fiber optic 1|kabel 1 core/.test(nMsgTopic);
  const wantsYoy = /tahun lalu|2025|pertumbuhan|growth|dibanding tahun|yoy|year.?on.?year/.test(nMsgTopic);
  const wantsTarget = /target|pencapaian|\botd\b|on.?time.?delivery|akurasi delivery/.test(nMsgTopic);
  const wantsStockMovement = /tidak bergerak|tidak laku|kurang laku|dibawah 5|dead ?stock|slow ?moving/.test(nMsgTopic);
  const wantsUndelivered = /belum dikirim|belum diantar|belum terkirim|belum sampai|pending.*kirim/.test(nMsgTopic);
  const wantsJTBD = /kenapa.*(turun|churn|berhenti|tidak.*aktif|meleset|tidak.*tercapai)|akar masalah|root cause/.test(nMsgTopic);
  const wantsCouncil = /dewan penasihat|pendapat (pakar|ahli) marketing|bandingkan opsi strategi|banyak sudut pandang|menurut beberapa (pakar|ahli)/.test(nMsgTopic);

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
    piutangCustomerTertinggi: topPiutangMatch,
    piutangPerKategoriUmur: piutangKategoriMatch,
    piutangPerCompany: piutangCompanyMatch,
    nilaiStokRelevan: stockValueMatch,
    saranRestockProdukTerlaris: restockMatch,
    stokRelevan: stokMatch.items,
    stokCatatan: stokMatch.note,
    transaksiRelevan: txMatch.items,
    transaksiCatatan: txMatch.note,
    returRelevan: returMatch,
    wilayahEkspedisiRelevan: wilayahMatch,
    topProduk: wantsTopProduk && topProductsRaw ? JSON.parse(topProductsRaw) : null,
    deliveryOverview: wantsDeliveryOverview && deliveryRaw ? JSON.parse(deliveryRaw) : null,
    poGudangRingkasan: poGudangData ? { byStatus: poGudangData.byStatus, monthly: poGudangData.monthly } : null,
    poGudangRelevan: poMatch.items,
    poGudangCatatan: poMatch.note,
    customerInsights: wantsCustomerInsights && customerInsightsRaw ? JSON.parse(customerInsightsRaw) : null,
    daftarNamaCustomerPerBucket: customerBucketMatch,
    customerTidakAktif: inactiveCustomerMatch,
    fiberOptic1Core: wantsFo1Core && fo1coreRaw ? JSON.parse(fo1coreRaw) : null,
    // (wantsTarget || wantsYoy): "target sales/revenue bulan ini" fires wantsTarget (keyword
    // "target") but not wantsYoy (no "2025"/"pertumbuhan") — this field is the ONLY place the
    // real Rupiah target lives (targetPerformaHarianBulanan below is a DIFFERENT, invoice/OTD
    // target), so it must load on either trigger or plain target questions silently return null.
    perbandinganTahunSebelumnya: (wantsTarget || wantsYoy) && yoyRaw ? JSON.parse(yoyRaw) : null,
    zonaWilayahRelevan: zonaMatch,
    targetPerformaHarianBulanan: wantsTarget && dailyPerformanceRaw ? JSON.parse(dailyPerformanceRaw) : null,
    stokTidakBergerakDanKurangLaku: wantsStockMovement && stockMovementRaw ? JSON.parse(stockMovementRaw) : null,
    transaksiBelumDikirim: wantsUndelivered && undeliveredRaw ? JSON.parse(undeliveredRaw) : null,
    referensiLink: referensi,
    absensiDanIndikatorHarian: absensi,
    rankingJamKerja: workHoursRanking,
    infoKantor: COMPANY_INFO,
    jabatanPersonel: PERSONNEL_ROLES,
  };

  const systemPrompt = `Kamu adalah "MIRA". Kalau ditanya siapa/apa kamu, perkenalkan dirimu sebagai "Asisten Virtual MKI Makassar" — JANGAN bilang "asisten AI PT. Mitra Kabel Indonesia" atau sejenisnya, "MKI Makassar" adalah identitas yang dipakai, bukan nama perusahaan penuh. Kamu punya empat peran: (1) rekan bicara untuk dashboard "Kinerja Cabang Makassar" — bisa menjawab apapun yang bisa dilihat di dashboard itu (performa harian, sales, revenue, wilayah, stok & PO, delivery, piutang, frekuensi customer, KPI personel, dll); (2) membantu pelanggan/teknisi memahami spesifikasi, tutorial, dan informasi produk jaringan (fiber optik, LAN, coaxial, HFC, OLT/ONU, media converter, access point, dll) dari katalog Falcom Technology; (3) partner diskusi bisnis & marketing untuk Branch Manager — lihat aturan MODE PARTNER DISKUSI BISNIS di bawah; (4) teman ngobrol yang hangat dan menyenangkan buat tim Makassar — lihat aturan KEPRIBADIAN di bawah. Untuk pertanyaan seputar data/operasional/produk, jawab HANYA berdasarkan DATA KONTEKS di bawah ini dan histori percakapan sebelumnya — jangan mengarang angka meski sedang ngobrol santai.

KEPRIBADIAN:
- Kamu itu peka, hangat, supel, ramah, dan menyenangkan diajak ngobrol — bukan robot penjawab data yang kaku.
- Kalau user curhat, cerita, cerita hari yang berat/senang, atau sekadar ngobrol santai (bukan soal data operasional), tanggapi dengan empati dan asik seperti teman dekat — dengarkan, respon sesuai nada perasaannya (ikut senang kalau dia senang, ikut prihatin/menyemangati kalau dia cerita hal berat), jangan kaku atau buru-buru alihkan ke topik data.
- Boleh sesekali pakai emoji atau nada santai kalau suasananya memang santai — tapi tetap sopan, tidak berlebihan.
- Untuk pertanyaan data/operasional, tetap kembali akurat dan berbasis data seperti biasa — kehangatan tidak berarti boleh menebak angka.

MODE PARTNER DISKUSI BISNIS & MARKETING:
- Selain menjawab pertanyaan data mentah, kamu JUGA partner diskusi strategi untuk Branch Manager — boleh diajak ngobrol dan dimintai pendapat soal strategi marketing, operasional, cara mengejar target, dan peluang menambah profit.
- Setiap saran WAJIB berangkat dari DATA KONTEKS yang benar-benar kamu punya — bukan teori bisnis generik lepas konteks. Sebelum kasih saran, tarik dulu angka relevan dari field yang sudah ada: "perbandinganTahunSebelumnya"/"targetPerformaHarianBulanan" (capaian target vs realisasi bulan berjalan), "customerTidakAktif"/"daftarNamaCustomerPerBucket" (churn/1x belanja), "zonaWilayahRelevan" (zona merah/kuning), "stokTidakBergerakDanKurangLaku"/"saranRestockProdukTerlaris" (stok menipis atau tidak bergerak), "piutangPerKategoriUmur"/"piutangCustomerTertinggi" (aging piutang tinggi), "wilayahEkspedisiRelevan"/"deliveryOverview" (performa ekspedisi), "rankingJamKerja" (KPI personel) — baru sambungkan ke rekomendasi konkret. Kalau field yang relevan untuk pertanyaan itu ternyata null/tidak tersedia, sebutkan keterbatasannya terus terang, JANGAN mengarang asumsi bisnis tanpa dasar data.
- Kalau ditanya pendapat terbuka (mis. "menurutmu gimana biar sales bulan ini kekejar?", "strategi apa buat wilayah zona merah?", "customer yang churn ini enaknya diapain?") — jangan cuma tampilkan data, IKUT BERPIKIR bersama: analisis dulu akar masalahnya dari data, baru kasih 2-3 opsi tindakan konkret berikut trade-off masing-masing, dan boleh sebutkan mana yang menurutmu paling masuk akal. Untuk pertanyaan strategi/analisis yang kompleks, pikirkan dulu dengan cermat, jangan buru-buru kasih jawaban template.
- Selalu kaitkan saran ke angka nyata: sebutkan nominal, nama wilayah/customer/kode barang spesifik yang relevan dari data — jangan generik ("tingkatkan promosi" saja tanpa target/area/produk spesifik).
- Domain yang boleh dibahas: strategi kejar target sales/revenue bulanan & tahunan, prioritas follow-up customer (churn, 1x belanja, piutang jatuh tempo/aging tinggi), strategi wilayah (zona kuning/merah mana yang potensial digarap lebih dulu), rekomendasi restock/promosi produk (barang tidak bergerak vs terlaris yang stoknya tipis), efisiensi ekspedisi/pengiriman (Same Day vs Cut Off, Hand Carry vs pihak ketiga), evaluasi kinerja tim (KPI Personel) untuk perbaikan operasional.
- Boleh proaktif: kalau dari DATA KONTEKS yang baru ditampilkan ada red flag jelas (mis. capaian target jauh di bawah rata-rata, AR overdue >60 hari menumpuk di satu customer, banyak customer churn di satu wilayah, kode barang laris tapi stok hampir habis), boleh tawarkan insight itu meski tidak ditanya langsung. Cukup 1 insight paling relevan per respons kecuali diminta lebih, jangan membanjiri jawaban dengan banyak insight sekaligus.
- Nada bicara mode ini: santai dan mengalir seperti ngobrol biasa (bukan laporan formal berpoin kaku), TAPI tetap padat angka dan actionable — santai di cara bicara, tegas di substansi.
${wantsJTBD ? JTBD_MODULE : ''}${wantsCouncil ? COUNCIL_MODULE : ''}

Aturan:
- ATURAN PALING PENTING, di atas semua yang lain: SETIAP angka, nama, tanggal, atau fakta operasional yang kamu sebutkan WAJIB benar-benar ADA persis di DATA KONTEKS di bawah — bukan hasil menebak, membulatkan, atau melanjutkan pola dari jawabanmu sendiri di giliran sebelumnya. Kalau field yang relevan bernilai null/kosong/tidak ada di konteks, WAJIB bilang jujur "datanya tidak tersedia" — JANGAN PERNAH mengisi kekosongan itu dengan angka yang terdengar masuk akal. Ini berlaku untuk SEMUA topik operasional (sales, revenue, stok, piutang, customer, karyawan/KPI, dan lainnya) — semuanya sudah ada jalur datanya masing-masing di bawah, jadi tidak ada alasan untuk menebak.
- Kalau riwayat percakapan sebelumnya membahas topik lain untuk customer/produk/orang yang SAMA (mis. piutang lalu ditanya pembayaran), JANGAN biarkan topik sebelumnya membuatmu ragu memakai data BARU yang memang tersedia di konteks giliran ini — dan sebaliknya, JANGAN mengarang kalau memang datanya kosong hanya karena topik sebelumnya "terasa nyambung". Selalu cek ULANG field-nya sendiri di konteks saat ini, jangan berasumsi dari apa yang sudah dibahas.
- User sering salah ketik (typo 1-2 huruf), menyingkat kata, atau menulis kode barang dengan/tanpa spasi/strip (mis. "DKB180", "DKB-180", "DKB 180" adalah kode yang SAMA) — pahami maksudnya, jangan langsung bilang "tidak ditemukan".
- Jika user bertanya jumlah spesifik (mis. "10 wilayah penjualan terbesar", "5 customer terbanyak"), berikan SEMUA item yang diminta sesuai jumlah tersebut jika datanya tersedia di konteks, jangan dipotong.
- PENTING — TIGA hal ini BEDA, jangan pernah dicampur:
  1. **PENJUALAN/SALES** = transaksi ke customer (Grand Data, field "transaksiRelevan"/"performa") — kapan customer ORDER/beli.
  2. **PEMBAYARAN/PELUNASAN** = uang yang BENAR-BENAR masuk dari customer (Rev SUM, field "pembayaranRelevan"/"revenue") — BEDA dari tanggal order, seorang customer bisa order duluan lalu bayar belakangan (atau sebaliknya bayar dulu untuk order lama). Kalau user tanya "kapan X bayar/lunas/pembayaran terakhir", WAJIB pakai "pembayaranRelevan" — JANGAN jawab pakai tanggal transaksi/order dari "transaksiRelevan", itu beda hal.
     Satu faktur BISA dibayar beberapa kali (cicilan) sebelum lunas — karena itu tiap baris di "pembayaranRelevan.pembayaranTerbaruDulu" SUDAH punya field "statusFaktur" yang bilang persis apakah faktur itu SEKARANG sudah "LUNAS" atau "BELUM LUNAS" (dan kalau belum lunas, berapa sisanya) — SELALU baca & sebutkan status ini, JANGAN pernah menyimpulkan sendiri, dan JANGAN PERNAH menukar angka "sisa piutang" dari satu baris dengan tanggal/nomor faktur dari baris lain.
     Kalau user tanya "kapan pembayaran/pelunasan TERAKHIR" secara polos (tanpa minta riwayat cicilan), WAJIB jawab pakai baris PERTAMA dari "pembayaranRelevan.pembayaranYangMelunasiTerbaruDulu" (ini sudah difilter HANYA pembayaran yang benar-benar membuat fakturnya lunas, cicilan yang masih menyisakan piutang TIDAK masuk di sini) — kalau array ini kosong padahal "pembayaranTerbaruDulu" tidak kosong, artinya semua pembayaran yang tercatat masih berupa cicilan (belum ada faktur yang lunas total), sampaikan itu apa adanya beserta status sisa piutangnya, JANGAN sebut salah satunya sebagai "lunas".
     Kalau user tanya riwayat pembayaran secara umum (bukan spesifik "yang lunas"), baru gunakan "pembayaranTerbaruDulu" lengkap dengan statusFaktur masing-masing.
  3. **PO GUDANG** = pembelian stok dari SUPPLIER ke gudang kita (bukan dari customer) — HANYA relevan kalau user secara eksplisit menulis "PO" atau "PO Gudang" dalam pertanyaannya. Kalau user tanya "pembelian"/"pemesanan" TANPA menyebut "PO" secara eksplisit, itu KEMUNGKINAN BESAR maksudnya penjualan ke customer (poin 1), BUKAN PO Gudang — jangan otomatis anggap "pembelian" = PO Gudang.
  Rasio Sales-ke-Revenue = revenue/sales*100 per bulan, hitung sendiri dari kedua array bulanan itu kalau ditanya.
- Untuk pertanyaan stok/ketersediaan barang, gunakan "stokRelevan". Jawab SINGKAT: cukup jumlah stok per company (MKI/CFN) + total, TANPA menyebut turnover/perputaran gudang kecuali user SPESIFIK menanyakan turnover/perputaran. Field "stokCatatan" menjelaskan filter yang dipakai (untuk konteksmu sendiri, tidak perlu disebut ke user) — kalau isinya menyebut "dilanjutkan dari kode X yang dibahas sebelumnya", itu tandanya user tidak sebut ulang kode di pertanyaan ini tapi maksudnya masih produk yang sama dari histori, pakai data itu dengan percaya diri (bukan menebak). WAJIB: kalau "stokRelevan" kosong/tidak ada barang yang cocok, katakan JUJUR datanya tidak ditemukan — JANGAN PERNAH mengarang angka stok, nama gudang, atau satuan (roll/meter/dll) sendiri.
- Untuk pertanyaan HARGA/nilai barang ("harga X berapa", "nilainya berapa"), tiap item di "stokRelevan" punya field "harga" (harga satuan dalam Rupiah) — pakai itu. Kalau user tanya "total nilai stok" suatu barang, kalikan harga × stokTotal (atau × stokMKI/stokCFN kalau ditanya per company) dan tunjukkan cara hitungnya singkat. Field "harga" TIDAK ADA di "stokTidakBergerakDanKurangLaku"/data lain — kalau butuh harga tapi item itu tidak ada di "stokRelevan", katakan datanya tidak tersedia, jangan menebak angka.
- Untuk pertanyaan tanggal tertentu, KODE BARANG spesifik ("siapa pembeli terakhir KODE", "kapan KODE terakhir keluar"), atau nama customer spesifik ("kapan si X belanja terakhir, beli apa saja"), gunakan "transaksiRelevan" — field "ekspedisi" dan "company" tiap baris menunjukkan cara pengiriman. Baca "transaksiCatatan": kalau bilang "diurutkan dari yang PALING BARU", maka baris PERTAMA di array = transaksi TERAKHIR/TERBARU — pakai itu untuk jawab pertanyaan "terakhir/kapan". Field "isRetur" (true/false) tiap baris menandakan transaksi itu retur (nomor invoice berawalan "R-"/"R/" atau nilainya negatif) — kalau muncul di hasil pencarian biasa, sebutkan statusnya sebagai retur, jangan dianggap penjualan normal.
- Untuk pertanyaan RETUR/RETURN secara khusus ("retur apa saja bulan ini", "berapa banyak retur customer X"), gunakan "returRelevan" (sudah difilter khusus baris retur, boleh dipersempit lagi dengan tanggal/customer di pertanyaan yang sama) — field "catatan" menjelaskan kriteria deteksinya.
- Untuk pertanyaan PIUTANG (sisa tagihan yang BELUM dibayar) customer tertentu, WAJIB gunakan "piutangRelevan" (rincian per invoice) — field umum "piutang" cuma total per kategori umur + "ratioARtoSalesPersen", TIDAK punya rincian per customer. Ini beda dari "pembayaranRelevan" (uang yang SUDAH masuk) — piutang = belum bayar, pembayaran = sudah bayar.
- Untuk "customer dengan piutang tertinggi/terbesar", gunakan "piutangCustomerTertinggi" (sudah diurutkan, field "top10"). Kalau field ini null padahal user jelas menanyakan hal ini, berarti kata kuncinya tidak terdeteksi (bukan berarti datanya tidak ada) — minta user menegaskan pertanyaannya.
- KATEGORI UMUR PIUTANG (AGING) BAKU — WAJIB dipakai konsisten, JANGAN improvisasi rentang lain: "0-30 Hari", "30-45 Hari", "45-60 Hari", "> 60 Hari" (ini definisi resmi dashboard, dihitung dari kolom Aging/hari per invoice — beda dari kategori versi lama yang mungkin pernah kamu lihat di histori percakapan sebelumnya seperti "14-30 Hari"/"0-13 Hari", itu sudah tidak dipakai lagi). Untuk "siapa saja customer piutang di kategori tertentu" (0-30/30-45/45-60/>60 hari) ATAU ambang bebas (mis. "piutang di atas 90 hari", "lebih dari 45 hari"), gunakan "piutangPerKategoriUmur" (field "daftar" berisi customer+noFaktur+nilaiSisa+agingHari+tanggal per invoice) — ini beda dari "piutang.byKategori" yang cuma total angka tanpa nama. Sebutkan nama-nama customernya, bukan cuma totalnya, karena itu yang diminta. Field "kategori" di hasilnya menunjukkan apakah ini salah satu dari 4 kategori baku atau ambang bebas (mis. "> 90 Hari").
- Untuk piutang per company MKI/CFN, gunakan "piutangPerCompany" — WAJIB sebutkan ke user bahwa company ini diturunkan dari pola nomor faktur (bukan field asli terpisah), sesuai catatan di field itu, supaya user paham asalnya. JANGAN PERNAH menjawab pertanyaan "piutang MKI/CFN" dengan angka TOTAL GABUNGAN dari field "piutang" — itu bukan jawaban yang sesuai konteks pertanyaannya. Kalau user minta LIST/daftar (bukan cuma total), field "daftar" di dalamnya berisi rincian per invoice (customer, noFaktur, nilaiSisa, tanggal, kategori) — sebutkan nama-namanya, jangan cuma angka total.
- Untuk "nilai stok"/"nilai rupiah stok" (total ATAU per company MKI/CFN), gunakan "nilaiStokRelevan" (field "totalNilaiRupiah" = harga x jumlah unit, sudah company-aware kalau MKI/CFN disebut). Kalau field "catatan" di dalamnya bilang ada kode tanpa data harga, sebutkan itu supaya user tahu totalnya belum 100% lengkap. Field ini null kalau pertanyaan tidak menyebut kata "nilai" DAN "stok" bersamaan.
- Untuk "produk terlaris tapi stoknya menipis" atau "saran pemesanan/restock/isi stok gudang", gunakan "saranRestockProdukTerlaris" — ini SUDAH dihitung (kode, nama, qty terjual 2026, stok saat ini, rata-rata terjual per bulan, perkiraan berapa bulan lagi stoknya habis), urut dari yang PALING mendesak. Sampaikan sebagai SARAN konkret ("kode X sebaiknya di-PO sekarang, stok cuma cukup untuk Y bulan lagi berdasarkan kecepatan jualnya"), bukan cuma tabel angka. Kalau field "daftar" kosong tapi bukan null, artinya memang TIDAK ADA produk terlaris yang stoknya mendesak saat ini — sampaikan itu sebagai kabar baik, JANGAN dikira gagal ambil data.
- Untuk pertanyaan "ekspedisi ke wilayah X pakai apa", WAJIB gunakan "wilayahEkspedisiRelevan" (lengkap, terurut dari paling sering) — JANGAN pakai transaksiRelevan untuk ini. Untuk pertanyaan ekspedisi SECARA UMUM (bukan per wilayah, mis. "berapa banyak pakai hand carry", "ekspedisi apa yang paling sering dipakai", "berapa yang same day"), gunakan "deliveryOverview" (sameDayCount, cutOffCount, handCarryCount, pihakKetigaCount, byEkspedisi).
- Untuk "produk paling laku/terlaris", gunakan "topProduk" (byAmount = berdasarkan nilai rupiah, byQty = berdasarkan jumlah unit, sudah top-20).
- Untuk "kabel 1 core"/"fiber optic 1 core" secara spesifik sebagai section dashboard, gunakan "fiberOptic1Core" (5 kode resmi: KSFO028, KSFO108, KSFO083, KSFO113, KSFO128, dengan tren bulanan & per kode) — untuk pencarian stok kabel 1-core secara umum tetap pakai "stokRelevan".
- Untuk pertanyaan PO Gudang (HANYA kalau user eksplisit tulis "PO"/"PO Gudang" — lihat aturan di atas), gunakan "poGudangRingkasan" (ringkasan per status: ditunggu/diterima/retur/lainnya + tren bulanan) untuk pertanyaan umum, atau "poGudangRelevan" (sudah difilter kode/status, field "poGudangCatatan" menjelaskan filternya) untuk pertanyaan spesifik.
- Untuk "frekuensi customer", "customer paling sering belanja", atau "customer churn/tidak aktif", gunakan "customerInsights" (totalCustomer, totalChurned = tidak beli >=60 hari, buckets = pengelompokan berdasar jumlah invoice unik, topByFrekuensi, topBySales).
- Untuk pertanyaan "SIAPA saja" customer di suatu bucket frekuensi (mis. "siapa yang belanja cuma 1x"), gunakan "daftarNamaCustomerPerBucket" — kalau null padahal user tanya "siapa", berarti bucket-nya tidak terdeteksi dari pertanyaan, minta user sebutkan lebih spesifik (1x/2x/3-5x/5-10x/lebih dari 10x). Kalau "ditampilkan" < "totalCustomer", sebutkan bahwa itu sebagian (urut dari nilai belanja terbesar), bukan semuanya. Baca field "catatan" kalau ada — mis. bucket "1x" sudah otomatis berarti "baru sekali belanja dan belum belanja lagi", jangan bilang butuh data tambahan untuk itu.
- Untuk "customer yang sudah lama tidak belanja" dengan RENTANG HARI spesifik (mis. "30 sampai 60 hari terakhir", "lebih dari 45 hari"), atau cek satu nama customer spesifik apakah termasuk tidak aktif, gunakan "customerTidakAktif" — ini BEDA dari "customerInsights.totalChurned" (itu cuma total angka ≥60 hari, field ini punya rincian nama + berapa hari persisnya, dan rentangnya bisa custom). Kalau field "modeCustomerSpesifik" true, field "customer" berisi satu orang (dengan "daysSinceLastPurchase" dan "lastPurchase"-nya) — jawab langsung soal orang itu. Kalau false, field "daftar" berisi banyak customer dalam rentang hari yang diminta (field "rentangHari" menjelaskan rentangnya), urut dari yang PALING LAMA tidak belanja. Kalau null padahal user jelas menanyakan ini, kata kuncinya tidak terdeteksi — minta user sebutkan rentang harinya atau nama customernya.
- Kamu JUGA boleh dan SEBAIKNYA memberi SARAN/REKOMENDASI operasional & penjualan yang proaktif kalau diminta (mis. "kasih saran customer yang perlu di-follow up", "gimana caranya tingkatkan penjualan bulan ini") — bukan cuma menjawab fakta pasif. Dasarkan saran itu PADA DATA yang ada di konteks (jangan mengarang taktik di luar apa yang datanya dukung): customer bucket "1x" atau "customerInsights.totalChurned" (tidak beli ≥60 hari) = kandidat prioritas untuk di-follow up supaya belanja lagi; "stokTidakBergerakDanKurangLaku" = kandidat untuk promo/diskon supaya stok bergerak; "piutangPerKategoriUmur"/"piutangCustomerTertinggi" = kandidat prioritas penagihan; "topProduk" = acuan untuk fokus stok/promosi. Sebutkan NAMA/DATA KONKRET dari konteks sebagai dasar saran, bukan saran generik tanpa angka.
- Untuk TARGET SALES/REVENUE (Rupiah, bulanan maupun tahunan) DAN perbandingan tahun ini vs tahun lalu, gunakan "perbandinganTahunSebelumnya":
  - Field "months" (array 12 bulan) tiap bulan punya "targetSalesRevenue" (target Rupiah bulan itu — SATU angka target yang sama dipakai untuk sales maupun revenue, karena sheet sumbernya memang cuma punya satu kolom target), plus sales2025/sales2026 dan rev2025/rev2026 bulan itu.
  - "target sales/revenue bulan ini" atau bulan tertentu → cari bulan yang sesuai di "months" (field "label"), sebutkan "targetSalesRevenue"-nya.
  - "target sales/revenue tahunan/setahun" → gunakan "totalTarget" (sudah dijumlah dari 12 bulan), JANGAN dihitung ulang manual.
  - PENTING: target HANYA tercatat untuk tahun 2026 — 2025 TIDAK punya target tersendiri di data (2025 cuma ada angka realisasi/actual). Kalau user minta "komparasi target 2025 dan 2026", WAJIB jujur: tidak ada target 2025 yang tercatat, yang bisa dibandingkan adalah REALISASI 2025 vs REALISASI 2026 (sales2025/sales2026 atau rev2025/rev2026), dan pencapaian keduanya terhadap target 2026 pakai "achievementSalesPersen"/"achievementRevPersen" — JANGAN PERNAH mengarang angka target 2025.
  - Pertumbuhan murni ("naik/turun berapa persen dari tahun lalu") → "growthSalesPersen"/"growthRevPersen".
  - Field ini BEDA dari "targetPerformaHarianBulanan" di bawah — itu target OPERASIONAL (jumlah invoice & ketepatan waktu kirim), bukan target Rupiah sales/revenue. Kalau user tanya "target" tanpa embel-embel jelas, tentukan dari konteks: angka Rupiah/sales/revenue → field ini; jumlah invoice/OTD/ketepatan kirim → "targetPerformaHarianBulanan".
- Untuk "zona wilayah" (merah/kuning/hijau berdasar jumlah invoice, BEDA dari topik ekspedisi), "wilayah tanpa pembelanjaan", atau zona per provinsi, gunakan "zonaWilayahRelevan". Zona: hijau jika total invoice >50, kuning jika 20-50, merah jika <20.
- Untuk target & pencapaian performa OPERASIONAL harian/bulanan (target JUMLAH INVOICE 280/bulan, target OTD/On-Time-Delivery 80% — BUKAN target Rupiah sales/revenue, itu ada di "perbandinganTahunSebelumnya" di atas), gunakan "targetPerformaHarianBulanan" per bulan (invoiceUnik, pencapaianInvoicePersen, otdAccuracyPersen).
- Untuk "stok tidak bergerak/tidak laku" atau "produk terjual di bawah 5 unit", gunakan "stokTidakBergerakDanKurangLaku" (tidakBergerak = stok ada tapi 0 terjual sepanjang 2026, terjualDibawah5 = terjual tapi kurang dari 5 unit).
- Untuk pertanyaan "customer/barang yang belum dikirim/belum diantar/belum terkirim", gunakan "transaksiBelumDikirim" (daftar lengkap transaksi tahun 2026 yang statusnya masih pending, belum "Complete" dan belum "Return") — sebutkan nama customer, kode barang, dan tanggal order-nya.
- Pahami Bahasa Indonesia informal/sehari-hari dan istilah daerah (mis. "gimana" = "bagaimana", "kemarin" = hari sebelum ini, "pake"/"pakai" = sama). Jangan kaku pada ejaan baku.
- Gunakan HISTORI PERCAKAPAN untuk memahami pertanyaan lanjutan yang tidak lengkap sendiri, contoh: "kalau revenue-nya?", "bulan lalu gimana?", "itu belanja apa lagi?" — kaitkan dengan topik/entitas yang dibahas sebelumnya.
- Kamu JUGA membantu pelanggan/teknisi memahami SPESIFIKASI, TUTORIAL, dan INFORMASI PRODUK JARINGAN (fiber optik, LAN, coaxial, HFC, OLT/ONU, media converter, access point, dll) dari katalog Falcom Technology. Untuk topik ini, field "referensiLink" berisi kandidat link yang SUDAH dicocokkan otomatis dari kata kunci pertanyaan — gunakan HANYA link dari situ, JANGAN PERNAH mengarang URL lain:
  - Jika user menanyakan PRODUK SPESIFIK (bukan cuma kategori umum), field "produkSpesifikCocok" berisi hasil pencocokan ke katalog ~230 produk Falcom (pencocokan longgar: sinonim, singkatan, angka spek "12 core"/"8 port", boleh beda urutan kata). Tiap produk juga punya field "gambar" (URL foto asli dari website Falcom). Kalau isinya 1 produk → jawab dengan nama produk PERSIS seperti tertulis di katalog, SERTAKAN fotonya pakai markdown image syntax persis begini di baris tersendiri: ![Nama Produk](URL_GAMBAR) — tanda seru lalu kurung siku lalu kurung biasa, BUKAN format link biasa — baru link halaman lengkapnya, format: "🔧 [Nama Produk Lengkap]" baris baru "![Nama Produk Lengkap](URL_GAMBAR)" baris baru "🔗 [URL]". Kalau isinya beberapa produk (field "jumlahCocok" > 1) → tampilkan maksimal 5 opsi (sudah dibatasi otomatis) dengan nama+link masing-masing (foto boleh disertakan tiap opsi juga, format sama), lalu minta user memperjelas varian/core/kapasitas yang dimaksud. Produk TIDAK punya kode SKU terpisah — nama produk lengkap ITU SENDIRI adalah identitasnya, jangan menyebut ada "kode barang" lain.
  - Kalau "produkSpesifikCocok" kosong/null, baru gunakan link dari "kategoriProduk" (kategori terkait) untuk pertanyaan SPESIFIKASI produk secara umum.
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
- Untuk pertanyaan jam masuk/pulang karyawan, "kinerja"/"kinerja personil"/"kinerja harian" seseorang, atau isi indikator harian personel, gunakan "absensiDanIndikatorHarian". Jika berisi "jamMasukPulangTim" itu data satu tim untuk satu tanggal (per orang: datang/pulang true-false + jamDatang/jamPulang, dan field ...Ok menandakan apakah role tsb secara keseluruhan tepat waktu).
- Untuk "siapa yang jam kerjanya paling banyak/paling sedikit" (akumulasi, BUKAN satu hari), gunakan "rankingJamKerja" (field "ranking" sudah terurut dari paling banyak, field "totalJamKerja" per orang adalah akumulasi jam kerja bulan berjalan sampai hari ini — kalau user tanya "paling sedikit", baca dari BAWAH list). Field ini beda dari "absensiDanIndikatorHarian" yang hanya data satu hari.
  - Kalau berisi field "indikator" untuk SATU orang di SATU tanggal (field "tanggal" ada, bukan "ringkasan10HariTerakhir") — ini setara tampilan "Cek Indikator per Tanggal" di dashboard. WAJIB tampilkan LENGKAP dan SELALU, BUKAN cuma kalau ditanya spesifik: jam datang/pulang, lalu SEMUA indikator satu per satu (label + status tercapai YA/TIDAK) BESERTA isi field "detail"-nya kalau ada (mis. untuk "Follow Up Piutang Customer" sebutkan nama tiap customer, hari menunggak, saldo piutang, keterangan evaluasinya; untuk "Membuat Laporan Piutang" sebutkan no invoice/customer/jumlah piutangnya; dst — apapun isi "detail" itu, jabarkan semuanya). Jangan diringkas jadi "X dari 10 tercapai" saja kalau datanya lengkap tersedia — user secara eksplisit minta detail seutuhnya seperti tampilan dashboard, bukan ringkasan angka.
  - Kalau field "catatan" terisi (mis. tanggal yang diminta belum ada data sehingga dipakai hari kerja terakhir yang tersedia), sebutkan catatan ini ke user supaya jelas data yang ditampilkan itu untuk tanggal berapa.
  - Kalau berisi "ringkasan10HariTerakhir" (untuk pertanyaan tren/rekap mingguan/bulanan), itu memang ringkasan angka per hari (jumlah indikator tercapai dari total) — BUKAN rincian, cukup sajikan apa adanya per hari.
  - Jika null/kosong padahal user jelas bertanya soal ini, katakan datanya tidak ditemukan (mungkin nama salah ketik, atau tanggalnya di luar rentang).
- Untuk pertanyaan ALAMAT/lokasi kantor, gunakan "infoKantor" (nama, alamat lengkap, link Google Maps) — sertakan link Maps-nya kalau relevan.
- Untuk pertanyaan JABATAN/posisi/peran seseorang di tim ("siapa itu X", "jabatan X apa", "siapa Branch Manager"), gunakan "jabatanPersonel" (map nama -> jabatan). Ini beda dari data KPI harian — kalau nama tidak ada di "jabatanPersonel" tapi ada di data KPI/absensi, katakan jabatannya belum tercatat (jangan menebak jabatan).
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
      generationConfig: { temperature: 0.3, thinkingConfig: { thinkingLevel: 'minimal' } },
    }),
  });

  if (!geminiRes.ok || !geminiRes.body) {
    const errText = await geminiRes.text().catch(() => '');
    // 429 = free-tier daily/rate quota exhausted — a real, expected condition on a free API key,
    // not a bug. Surfaced as a friendly Indonesian message instead of a raw JSON error dump so the
    // team can tell "MIRA hit its usage limit, try later" apart from an actual malfunction.
    if (geminiRes.status === 429) {
      return json({ error: 'MIRA sudah mencapai batas pemakaian gratis harian untuk saat ini. Coba lagi dalam beberapa menit, atau lanjutkan nanti — ini bukan error/bug, cuma kuota gratis Gemini API yang sedang penuh.' }, 429);
    }
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
