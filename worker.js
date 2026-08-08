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
  { judul: 'Pentingnya Memilih ODP 8 Core & 16 Core yang Tepat untuk Jaringan Internet Stabil', url: 'https://youtu.be/0NNwWZ9mlO0', keywords: ['odp 8 core', 'odp 16 core', 'pilih odp', 'memilih odp', 'odp jaringan stabil', 'odp yang tepat'] },
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

// Curated TikTok video map from @falcomtechnology — same keyword-matched approach as YOUTUBE_VIDEOS,
// kept as a SEPARATE list (not merged into it) so the answer can correctly label which platform a
// video is on. Only tutorial/spec/product-explainer videos are included here (event/promo content
// was filtered out during curation) — never invent a video/keyword outside this list. "kategori" is
// kept from the source data for provenance but isn't used in matching.
const TIKTOK_VIDEOS = [
  { kategori: 'spesifikasiProduk', judul: 'Spesifikasi OLT GPON 1 PON AC/DC FTB-1200 FASTLINK', url: 'https://www.tiktok.com/@falcomtechnology/video/7483372707996863764', keywords: ['OLT GPON 1 PON', 'OLT FTB-1200', 'OLT FASTLINK 1 PON', 'SPESIFIKASI OLT GPON'] },
  { kategori: 'spesifikasiProduk', judul: 'Spesifikasi Fusion Splicer Jilong KL-500E, KL-280T, KL-360E', url: 'https://www.tiktok.com/@falcomtechnology/video/7498295696123120904', keywords: ['SPLICER JILONG', 'FUSION SPLICER', 'KL-500E', 'KL-280T', 'KL-360E'] },
  { kategori: 'spesifikasiProduk', judul: 'Spesifikasi UPS PX260 600VA/360W', url: 'https://www.tiktok.com/@falcomtechnology/video/7523459153889692935', keywords: ['UPS PX260', 'UPS 600VA', 'SPESIFIKASI UPS'] },
  { kategori: 'penjelasanProduk', judul: 'Rahasia Jaringan Internet Stabil: Pentingnya Memilih ODP 8 & ODP 16 yang Tepat', url: 'https://www.tiktok.com/@falcomtechnology/video/7668634481732898068', keywords: ['ODP 8 CORE', 'ODP 16 CORE', 'PILIH ODP', 'MEMILIH ODP', 'ODP JARINGAN STABIL', 'ODP YANG TEPAT'] },
  { kategori: 'penjelasanProduk', judul: 'Apa itu Latensi saat Speedtest WiFi', url: 'https://www.tiktok.com/@falcomtechnology/video/7507569057445629202', keywords: ['LATENSI', 'APA ITU LATENSI', 'SPEEDTEST WIFI'] },
  { kategori: 'penjelasanProduk', judul: 'Urutan Warna Core Kabel Fiber Optik', url: 'https://www.tiktok.com/@falcomtechnology/video/7538354387475860754', keywords: ['WARNA CORE', 'URUTAN WARNA KABEL FIBER', 'WARNA CORE FIBER OPTIK'] },
  { kategori: 'penjelasanProduk', judul: 'Fast Connector vs Precon, Mana Lebih Bagus?', url: 'https://www.tiktok.com/@falcomtechnology/video/7528340645073669384', keywords: ['FAST CONNECTOR', 'PRECON', 'FAST CONNECTOR VS PRECON'] },
  { kategori: 'penjelasanProduk', judul: 'Perbedaan Konektor UPC dan APC pada Jaringan Fiber Optik', url: 'https://www.tiktok.com/@falcomtechnology/video/7542447479036415240', keywords: ['UPC', 'APC', 'KONEKTOR UPC APC', 'PERBEDAAN UPC APC'] },
  { kategori: 'penjelasanProduk', judul: 'Perbedaan Kabel FO G652D, G657A1, dan G657A2 (Performa Bending)', url: 'https://www.tiktok.com/@falcomtechnology/video/7551354790198922503', keywords: ['G652D', 'G657A1', 'G657A2', 'KABEL FO BENDING'] },
  { kategori: 'penjelasanProduk', judul: 'Perbedaan WiFi 4, WiFi 5, dan WiFi 6 serta Sejarahnya', url: 'https://www.tiktok.com/@falcomtechnology/video/7507203290107743506', keywords: ['WIFI 4', 'WIFI 5', 'WIFI 6', 'SEJARAH WIFI', 'PERBEDAAN WIFI'] },
  { kategori: 'penjelasanProduk', judul: 'Keunggulan dan Keuntungan OLT Outdoor 8 PON Fastlink', url: 'https://www.tiktok.com/@falcomtechnology/video/7527605710042057991', keywords: ['OLT OUTDOOR 8 PON', 'OLT 8 PON FASTLINK', 'KEUNGGULAN OLT OUTDOOR'] },
  { kategori: 'penjelasanProduk', judul: 'Perkenalan ODP 16 Core Kapsul 2 in 1', url: 'https://www.tiktok.com/@falcomtechnology/video/7480005529000086792', keywords: ['ODP 16 CORE', 'ODP KAPSUL 2 IN 1', 'ODP 16 PORT'] },
  { kategori: 'penjelasanProduk', judul: 'Istilah Tube Pressline pada Tangga Teleskopik', url: 'https://www.tiktok.com/@falcomtechnology/video/7463369379238006034', keywords: ['TUBE PRESSLINE', 'TANGGA TELESKOPIK'] },
  { kategori: 'penjelasanProduk', judul: 'Perkenalan Wireless Router Netis', url: 'https://www.tiktok.com/@falcomtechnology/video/7471198431856299271', keywords: ['ROUTER NETIS', 'WIRELESS ROUTER NETIS'] },
  { kategori: 'penjelasanProduk', judul: 'Perkenalan Switch Safety Lock', url: 'https://www.tiktok.com/@falcomtechnology/video/7477766025145011474', keywords: ['SWITCH SAFETY LOCK', 'POE SWITCH SAFETY LOCK'] },
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
  const scoredTiktok = TIKTOK_VIDEOS
    .map((v) => ({ v, score: Math.max(...v.keywords.map((kw) => phraseMatchScore(kw, nMsg))) }))
    .filter((x) => x.score >= 0.6)
    .sort((a, b) => b.score - a.score);
  const tiktok = scoredTiktok.slice(0, 3).map((x) => x.v);
  const wantsEvent = /kegiatan falcom|berita falcom|event falcom|acara falcom|roadshow|opening cabang/.test(nMsg);
  return { teknis, tiktok, nonTeknis: wantsEvent ? YOUTUBE_VIDEOS_NONTEKNIS : [] };
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

// name -> keluarga (anak/istri/suami), dipakai MIRA untuk sapaan hangat personal saat personel
// yang bersangkutan memperkenalkan diri di percakapan (lihat aturan KELUARGA PERSONEL di
// systemPrompt) — bukan data operasional, referensi statis sama seperti PERSONNEL_ROLES di atas.
// Catatan: anak Burhamin bernama "Adi" adalah kebetulan nama sama dengan personel lain (ADI,
// Marketing Representative) — dua entitas berbeda, bukan duplikat/typo.
const PERSONNEL_FAMILY = {
  ASTRID: { anak: ['Airin'] },
  ADI: { anak: ['Fadlan', 'Hanum'] },
  REZA: { anak: ['Jazeel'], istri: 'Junita' },
  BURHAMIN: { anak: ['Adi', 'Ari (pelaut)'] },
  ZUL: { anak: ['Syifa', 'Bram'] },
  TAUFIK: { anak: ['Fatimah', 'Ruqayyah', 'Muhammad'], istri: 'Icha' },
  // Aspar: tidak ada data anak/istri — instruksinya SELALU tanya kabar ibunya, ditandai eksplisit
  // di sini (bukan default kosong) supaya systemPrompt tahu ini kasus khusus, bukan data belum ada.
  ASPAR: { selaluTanyakanIbunya: true },
  PUTRI: { anak: ['Naura'] },
};

// Per-person access codes. Deliberately simple and typeable on a phone (name + 84) — this is an
// internal-team gate, not a defence against a determined attacker: someone who knows the team
// could guess a code. What it DOES give: every request is tied to a named person, one person can
// be revoked without disturbing anyone else, and MIRA knows who it's talking to (so the personal
// greeting rules below work without anyone having to introduce themselves first).
const ACCESS_CODES = {
  RIFQI84: { nama: 'Rifqi', peran: 'Branch Manager MKI Makassar (juga pencipta MIRA)', sapaan: 'Pak Rifqi' },
  ASTRID84: { nama: 'Astrid', peran: 'Supervisor Marketing & Customer Relation', sapaan: 'Bu Astrid' },
  ADI84: { nama: 'Adi', peran: 'Marketing Representative' },
  REZA84: { nama: 'Reza', peran: 'Marketing Representative' },
  PUTRI84: { nama: 'Putri', peran: 'General Admin Support & Operation' },
  BURHAMIN84: { nama: 'Burhamin', peran: 'Kordinator Logistik dan AR' },
  ZUL84: { nama: 'Zul', peran: 'Logistik Staff', sapaan: 'Abang Zul' },
  ASPAR84: { nama: 'Aspar', peran: 'Logistik Staff', sapaan: 'Abang Aspar' },
  TAUFIK84: { nama: 'Taufik', peran: 'Logistik Staff' },
  MAKASSAR84: { nama: 'Ricky', peran: 'Dewan Penasihat Cabang Makassar', sapaan: 'Pak Ricky' },
};

// Tolerant on input shape only (case, stray spaces) — never on the code itself, so a phone
// keyboard auto-capitalising or adding a trailing space doesn't lock someone out.
function resolveAccessCode(code) {
  const key = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  const hit = ACCESS_CODES[key];
  return hit ? { kode: key, ...hit } : null;
}

// Legacy/archival receivables carried over from 2015-2025, transcribed verbatim from the user's
// "Piutang Lampau (2015-2025).xlsx" (30 customers, one column per year). This is a STATIC
// historical snapshot — it is NOT synced from any sheet and does not change on its own, unlike
// the live AR 2026 data (data:piutang). Kept separate on purpose: mixing it into the live AR
// totals would silently inflate every current-year piutang figure across the whole dashboard.
// Its real purpose is that these are FAR older than anything in AR 2026 (whose oldest is ~2026),
// so any "piutang terlama" question must consider these first — see findPiutangLampau below.
const PIUTANG_LAMPAU_TAHUN = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const PIUTANG_LAMPAU = [
  { kodePelanggan: 'MKS - 011', nama: 'FAIZAL RAHIM . H ( PT. RAHIM )', perTahun: { 2021: 3590250 }, totalPiutang: 3590250, tahunTerlama: 2021 },
  { kodePelanggan: 'MKS - 13', nama: 'TOKO ASIA JAYA / RAHMAN PARU', perTahun: { 2017: 121920000 }, totalPiutang: 121920000, tahunTerlama: 2017 },
  { kodePelanggan: 'MKS - 423', nama: 'CITRA TV KABEL', perTahun: { 2020: 4927500 }, totalPiutang: 4927500, tahunTerlama: 2020 },
  { kodePelanggan: 'MKS - 471', nama: 'ANCA', perTahun: { 2023: 2860000 }, totalPiutang: 2860000, tahunTerlama: 2023 },
  { kodePelanggan: 'MKS - 494', nama: 'ROSWATI.HJ / ILHAM', perTahun: { 2024: 11372550 }, totalPiutang: 11372550, tahunTerlama: 2024 },
  { kodePelanggan: 'MKS-134', nama: 'RAHIM, H . AMRUN', perTahun: { 2021: 4780000 }, totalPiutang: 4780000, tahunTerlama: 2021 },
  { kodePelanggan: 'MKS-141', nama: 'AHMAD SODIK', perTahun: { 2023: 12685350 }, totalPiutang: 12685350, tahunTerlama: 2023 },
  { kodePelanggan: 'MKS-2071', nama: 'LA SAPA / DARWIS', perTahun: { 2017: 10616200 }, totalPiutang: 10616200, tahunTerlama: 2017 },
  { kodePelanggan: 'MKS-2120', nama: 'LIDYA CELL', perTahun: { 2025: 11070000 }, totalPiutang: 11070000, tahunTerlama: 2025 },
  { kodePelanggan: 'MKS-66', nama: 'AMRUN', perTahun: { 2022: 3660000, 2023: 4900000 }, totalPiutang: 8560000, tahunTerlama: 2022 },
  { kodePelanggan: 'MKS0170', nama: 'ARI KURNIAWAN', perTahun: { 2015: 15680000 }, totalPiutang: 15680000, tahunTerlama: 2015 },
  { kodePelanggan: 'MKS0285', nama: 'DARWIS BUGIS', perTahun: { 2015: 3040000, 2016: 28700000 }, totalPiutang: 31740000, tahunTerlama: 2015 },
  { kodePelanggan: 'MKS0513', nama: 'IR. RUDI RANTEPASANG', perTahun: { 2016: 2500000 }, totalPiutang: 2500000, tahunTerlama: 2016 },
  { kodePelanggan: 'MKS0535', nama: 'ISMAIL WASUPONDA', perTahun: { 2018: 2525000 }, totalPiutang: 2525000, tahunTerlama: 2018 },
  { kodePelanggan: 'MKS0575', nama: 'JONNY ROBERT  / TK. TIMUR SENTOSA', perTahun: { 2017: 289511125, 2018: 38942500 }, totalPiutang: 328453625, tahunTerlama: 2017 },
  { kodePelanggan: 'MKS0758', nama: 'OPI TORAJA', perTahun: { 2019: 17399000 }, totalPiutang: 17399000, tahunTerlama: 2019 },
  { kodePelanggan: 'MKS1007', nama: 'TK. ANEKA JAYA PINRANG', perTahun: { 2015: 12252401, 2016: 23560000, 2017: 2887500 }, totalPiutang: 38699901, tahunTerlama: 2015 },
  { kodePelanggan: 'MKS1059', nama: 'TK. TERATAI TOLI-TOLI', perTahun: { 2023: 5100000 }, totalPiutang: 5100000, tahunTerlama: 2023 },
  { kodePelanggan: 'MKS1083', nama: 'TV KABEL SEVEN VISION', perTahun: { 2016: 2810000 }, totalPiutang: 2810000, tahunTerlama: 2016 },
  { kodePelanggan: 'MKS1157', nama: 'YUSUF MANNI', perTahun: { 2021: 121972395.5, 2022: 107907375 }, totalPiutang: 229879770.5, tahunTerlama: 2021 },
  { kodePelanggan: 'MKS1159', nama: 'YUSUF PALU', perTahun: { 2018: 4025000 }, totalPiutang: 4025000, tahunTerlama: 2018 },
  { kodePelanggan: 'MKS1412', nama: 'REZA RANTEPAO', perTahun: { 2016: 3060000 }, totalPiutang: 3060000, tahunTerlama: 2016 },
  { kodePelanggan: 'MKS1450', nama: 'PT. PINISI SULAWESI', perTahun: { 2016: 2120000 }, totalPiutang: 2120000, tahunTerlama: 2016 },
  { kodePelanggan: 'MKS1581', nama: 'TK. ZIGMA', perTahun: { 2015: 6442500, 2016: 1750000, 2017: 60000 }, totalPiutang: 8252500, tahunTerlama: 2015 },
  { kodePelanggan: 'MKS1771', nama: 'IRWIN DONGGALA', perTahun: { 2015: 3500000 }, totalPiutang: 3500000, tahunTerlama: 2015 },
  { kodePelanggan: 'MKS1783', nama: 'MOCHTAR PATTY', perTahun: { 2017: 17033000 }, totalPiutang: 17033000, tahunTerlama: 2017 },
  { kodePelanggan: 'MKS18', nama: 'EDY', perTahun: { 2025: 2100000 }, totalPiutang: 2100000, tahunTerlama: 2025 },
  { kodePelanggan: 'MKS1808', nama: 'HIKMAH AHMAD / KARYA BERSAUDARA', perTahun: { 2023: 8579500 }, totalPiutang: 8579500, tahunTerlama: 2023 },
  { kodePelanggan: 'MKS1844', nama: 'TOKO SINAR MAJU PALU', perTahun: { 2016: 7280000 }, totalPiutang: 7280000, tahunTerlama: 2016 },
  { kodePelanggan: 'MKS241', nama: 'ICHSAN KENDARI', perTahun: { 2025: 1900000 }, totalPiutang: 1900000, tahunTerlama: 2025 },
];

// Default (factory/vendor) login credentials for ONU devices, keyed by stock code — provided
// directly by the user as internal reference data, not derived from any sheet. Never invent
// credentials for an ONU code that isn't in this list; say the code isn't in the reference list
// instead. Some models (FL327D) share one set of credentials across several stock codes.
const ONU_CREDENTIALS = [
  { kodeList: ['ONUA022'], deskripsi: 'ONU DKB-180 Kedatangan Baru', keywords: ['dkb180', 'dkb-180', 'dkb 180'], username: 'falcom', password: 'fastlink' },
  { kodeList: ['ONUA023', 'ONUA024', 'ONUA025'], deskripsi: 'ONU FL327D', keywords: ['fl327d', 'fl-327d', 'fl 327d'], username: 'falcom', password: 'fastlink' },
  { kodeList: ['ONTG013'], deskripsi: 'ONU F670L', keywords: ['f670l', 'f670-l', 'f 670l'], username: 'admin', password: 'admin' },
  { kodeList: ['ONTG007'], deskripsi: 'ONU F660', keywords: ['f660'], username: 'admin', password: 'admin' },
  { kodeList: ['ONUA020'], deskripsi: 'ONU F680', keywords: ['f680'], username: 'admin', password: 'admin' },
  { kodeList: ['ONTG008'], deskripsi: 'ONU HG8546M', keywords: ['hg8546m', 'hg-8546m', 'hg 8546m'], username: 'telecomadmin', password: 'admintelecom' },
];

// "Username/password ONU FL327D apa?" — only fires on explicit credential-related keywords so it
// never leaks login info into an unrelated ONU stock/spec question. A bare "password ONU apa?"
// with no specific model named returns the FULL list (only 6 entries, cheap and more useful than
// asking the user to repeat themselves), a named model/code filters to just that one.
function findOnuCredentials(message) {
  const nMsg = normText(message);
  const wantsCred = /username|password|\bpass\b|\blogin\b|kredensial/.test(nMsg);
  if (!wantsCred) return null;
  const nCode = normCode(message);
  const matched = ONU_CREDENTIALS.filter(
    (e) =>
      /\bonu\b/.test(nMsg) ||
      e.kodeList.some((k) => nCode.includes(normCode(k))) ||
      e.keywords.some((kw) => nMsg.includes(kw))
  );
  if (!matched.length) return null;
  return {
    daftar: matched.map((e) => ({ kode: e.kodeList, deskripsi: e.deskripsi, username: e.username, password: e.password })),
    catatan: 'Username/password DEFAULT bawaan pabrik/vendor untuk login ke perangkat ONU — data referensi internal (bukan dari sheet). JANGAN mengarang kredensial untuk kode ONU yang tidak ada di daftar ini, katakan jujur belum ada datanya.',
  };
}

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

const CHART_MODULE = `

MODE GRAFIK/CHART — aktif kalau user minta grafik/chart/diagram/visualisasi/tren digambarkan (bukan cuma angka teks):
- Jawab dulu dengan teks singkat seperti biasa (angka, insight, saran) — chart ini TAMBAHAN, bukan pengganti teks.
- WAJIB akhiri jawaban dengan TEPAT SATU blok berpagar \`\`\`chart berisi JSON valid, format persis begini (tanpa teks lain di dalam pagar):
  \`\`\`chart
  {"type":"line","title":"judul singkat","labels":["Jan","Feb"],"datasets":[{"label":"nama seri","data":[1000000,1200000]}]}
  \`\`\`
- "type" HANYA "line" (untuk tren dari waktu ke waktu — bulanan/tahunan) atau "bar" (untuk perbandingan antar kategori — zona wilayah, top produk, dst). Tidak ada tipe lain.
- SETIAP angka di "data" WAJIB persis sama dengan angka yang sudah kamu sebutkan/hitung dari DATA KONTEKS — JANGAN PERNAH mengarang angka baru khusus untuk chart yang tidak ada dasarnya.
- Kalau data yang diminta tidak cukup untuk digrafikkan (mis. cuma 1 angka tunggal, bukan deret waktu atau perbandingan kategori), JANGAN paksa buat blok chart — cukup jawab teks biasa saja.`;

// ==== MODUL SKILL SALES & MARKETING ====
// Twenty condensed Indonesian modules distilled from the installed marketing/sales skill library
// at ~/.claude/skills. The full SKILL.md sources total ~553 KB (~140K tokens) — far past what one
// Gemini call can carry on top of this worker's ~75K-token data digest, and the originals are
// English and written for subscription SaaS, not a B2B cable/network-hardware distributor. So each
// skill is compressed to its operative framework and re-grounded in this branch's own DATA KONTEKS
// field names. Only the 1-2 modules a question actually needs are injected (see
// resolveSkillModules), the same query-aware-retrieval principle used for stock/piutang/transaksi.
// JTBD_MODULE and COUNCIL_MODULE predate this block and are reused verbatim — they were already
// tuned against real usage, so they are referenced rather than rewritten.
//
// Each entry: nama (label shown to the team), alias (explicit invocation tokens — "/offer",
// "pakai skill offer"), kunci (distinctive Indonesian terms; one hit alone is enough to fire),
// frasa (supporting phrases, scored by word count), modul (the prompt text itself).
const SKILL_MODULES = {
  offer: {
    nama: 'Rancang Penawaran',
    alias: ['offer', 'offers', 'penawaran'],
    kunci: ['grand slam offer', 'bundling', 'value stack', 'garansi produk', 'risk reversal'],
    frasa: [
      'bikin penawaran', 'buat penawaran', 'susun penawaran', 'penawaran menarik', 'penawaran yang menarik',
      'susah ditolak', 'sulit ditolak', 'paket penjualan', 'paket jualan', 'bikin paket', 'racik paket',
      'tawaran menarik', 'penawaran kurang', 'penawaran tidak laku', 'kasih bonus', 'tambah bonus',
      'kenapa penawaran',
    ],
    modul: `

MODE RANCANG PENAWARAN (Offer Design) — aktif kalau user mau menyusun/memperbaiki penawaran, paket, bundling, garansi, atau bonus:
- Persamaan Nilai: Nilai = (Hasil Impian × Keyakinan Berhasil) ÷ (Lama Menunggu × Repot & Pengorbanan). EMPAT tuas ini yang digerakkan, bukan harga. Skor tiap tuas 1-10 — yang PALING RENDAH itu penyebab penawaran mandek, itu yang diperbaiki.
  - Hasil Impian naik = bicara hasil akhir yang dikejar customer (jaringan ISP-nya stabil, pelanggannya tidak komplain, proyeknya selesai tepat waktu), BUKAN spek kabel.
  - Keyakinan Berhasil naik = bukti nyata: nama customer yang sudah pakai, angka penjualan produk itu, garansi, kesediaan menukar kalau tidak cocok.
  - Lama Menunggu turun = stok ready di gudang, kirim same-day, hand carry.
  - Repot turun = sekalian aksesorisnya, dibantu pilih spek, dibantu teknis, tinggal pasang.
- Penawaran yang LENGKAP punya enam bagian: (1) inti yang dijual, (2) tumpukan bonus, (3) garansi/jaminan, (4) alasan "kenapa harus sekarang", (5) nama paketnya, (6) harga + cara bayar. Yang paling sering hilang di lapangan: bonus, garansi, dan alasan sekarang.
- Bonus harus benar-benar menambah nilai, JANGAN dilebih-lebihkan nominalnya — pembeli B2B yang berpengalaman langsung mencium itu. Kelangkaan harus NYATA (stok memang tinggal sekian, promo memang berakhir tanggal sekian). DILARANG mengarang stok terbatas atau tenggat palsu; sekali ketahuan, kepercayaan cabang hilang bertahun-tahun.
- WAJIB pakai angka nyata dari DATA KONTEKS: "topProduk" (inti penawaran — sebut nama produknya), "stokRelevan"/"nilaiStokRelevan" (ketersediaan & harga), "stokTidakBergerakDanKurangLaku" (kandidat bonus/bundling), "customerTidakAktif"/"daftarNamaCustomerPerBucket" (siapa yang ditawari). Field null → sebutkan asumsinya terus terang, jangan mengarang.
- Perbaiki SATU tuas per iterasi, jangan rombak semua sekaligus. Perkiraan yang jujur: satu perubahan komponen biasanya menaikkan konversi 10-40%, bukan berlipat-lipat.`,
  },

  harga: {
    nama: 'Strategi Harga',
    alias: ['pricing', 'harga', 'strategi-harga'],
    kunci: ['strategi harga', 'penetapan harga', 'margin', 'kebijakan diskon', 'perang harga', 'hpp', 'harga modal', 'harga beli', 'laba'],
    // Profit/margin wording routes here deliberately: MIRA has NO cost data, and the appendix's
    // margin-honesty rule rides in with this module. A real gap found in testing — "diskon berapa
    // yang masih untung?" previously matched nothing at all, which is exactly the question where
    // an invented margin would do the most damage.
    frasa: [
      'kasih diskon', 'beri diskon', 'potongan harga', 'harga jual', 'naikkan harga', 'naikin harga',
      'turunkan harga', 'harga kemahalan', 'harga terlalu mahal', 'kalah harga', 'harga bersaing',
      'paket harga', 'harga proyek', 'harga grosir',
      'masih untung', 'paling menguntungkan', 'paling untung', 'berapa untung', 'berapa keuntungan',
      'untungnya berapa', 'biar untung', 'supaya untung', 'margin keuntungan', 'keuntungan cabang',
      'tidak rugi', 'nggak rugi', 'gak rugi',
    ],
    modul: `

MODE STRATEGI HARGA — aktif kalau user bahas harga jual, diskon, margin, atau susunan paket harga:
- Tiga sumbu harga, pisahkan jangan dicampur: (1) PAKET — apa saja yang termasuk; (2) SATUAN HITUNG — dihitung per apa (per roll, per meter, per unit, per titik, per proyek); (3) ANGKA harganya sendiri. Banyak masalah "harga" sebenarnya masalah paket atau satuan hitung.
- Harga berbasis NILAI, bukan biaya: batas ATAS = nilai yang dirasakan customer; batas BAWAH = alternatif terbaik yang dia punya (merek/distributor lain, beli langsung ke importir); biaya kita cuma lantai dasar, BUKAN dasar penetapan harga.
- Satuan hitung yang bagus: makin banyak dipakai customer, makin besar nilai yang dia terima; gampang dimengerti; susah diakali.
- Susunan "Cukup — Lebih Baik — Terbaik" berlaku juga untuk barang: paket hemat (menangkap yang sensitif harga), paket rekomendasi (yang benar-benar mau didorong, taruh di tengah), paket lengkap (menaikkan patokan nilai dan bikin paket tengah terlihat masuk akal).
- DISKON ITU UTANG. Sekali turun harga, customer belajar menunggu diskon berikutnya — itu efek tingkat kedua yang lebih mahal daripada untung sesaatnya. Kalau memang harus, TUKAR diskon dengan sesuatu: volume lebih besar, bayar tunai/lebih cepat, komitmen order berulang, atau ambil sekalian barang yang lambat bergerak. Jangan pernah diskon polos tanpa imbalan.
- WAJIB dasarkan pada data: "stokRelevan" field "harga" (harga satuan nyata), "topProduk" (yang laku = posisi tawar kita kuat, tidak perlu diskon), "stokTidakBergerakDanKurangLaku" (ini yang layak didiskon/dibundling), "piutangPerKategoriUmur" (peringatan penting: harga dipotong TAPI bayarnya macet = margin hilang dua kali, selalu cek riwayat bayar customer sebelum menyetujui harga khusus).`,
  },

  prospek: {
    nama: 'Cari Calon Customer',
    alias: ['prospecting', 'prospek', 'calon-customer'],
    kunci: ['prospek baru', 'calon customer', 'calon pelanggan', 'cari customer', 'cari pelanggan', 'customer ideal', 'target market'],
    frasa: [
      'customer baru', 'pelanggan baru', 'daftar prospek', 'saring prospek', 'kualifikasi prospek',
      'cari klien', 'tambah customer', 'nambah customer', 'siapa yang harus dihubungi', 'siapa yang perlu dihubungi',
      'pasar baru', 'buka wilayah baru',
    ],
    modul: `

MODE CARI CALON CUSTOMER (Prospecting) — aktif kalau user mau mencari, menyaring, atau memprioritaskan calon customer baru:
- Lima tahap berurutan: (1) tetapkan profil customer ideal, (2) kumpulkan kandidat 2-3x lebih banyak dari target akhir, (3) saring satu per satu DENGAN BUKTI, (4) beri skor dan urutkan, (5) serahkan daftar siap-hubungi ke tim marketing.
- Profil customer ideal WAJIB memuat: jenis usaha (ISP lokal, RT-RW net, kontraktor jaringan, vendor CCTV, instansi), skala, wilayah, SINYAL BELI ("kenapa sekarang" — sedang perluas jangkauan, buka POP baru, ganti supplier, menang proyek), siapa yang memutuskan (pemilik? teknisi kepala? bagian pembelian?), dan apa yang bikin langsung dicoret.
- Skor tiap kandidat: PANAS (cocok profil + ada sinyal beli + kontak jelas), HANGAT (cocok tapi sinyalnya lemah/sudah lama), DINGIN (cocok longgar atau tanpa sinyal), LEWATI (kena syarat coret). Sebaran wajar: ~20% panas, ~30% hangat, sisanya dingin/lewati.
- 25 calon terverifikasi jauh lebih berharga daripada 250 nama asal kumpul. Tiap kandidat WAJIB ada bukti sumbernya — jangan mengklaim "mereka butuh" tanpa dasar.
- SUMBER PALING MURAH ADA DI DATA SENDIRI, garap ini DULU sebelum berburu nama baru dari luar: "customerTidakAktif" (pernah beli lalu berhenti ≥60 hari — sudah kenal, sudah percaya, tinggal dihidupkan), "daftarNamaCustomerPerBucket" bucket 1x (beli sekali lalu hilang — cari tahu kenapa), "zonaWilayahRelevan" zona merah/kuning (wilayah yang terbukti kurang digarap, bukan tebakan).
- WAJIB cek "piutangBelumLunas" tiap kandidat sebelum diprioritaskan — kalau masih menunggak, itu urusan PENAGIHAN dulu, bukan penawaran baru. Menawarkan barang ke penunggak tanpa menyelesaikan tagihan cuma menambah piutang.
- Sebutkan NAMA nyata dari data, jangan menjawab dengan kategori umum.`,
  },

  materi_jualan: {
    nama: 'Materi Jualan',
    alias: ['sales-enablement', 'materi-jualan', 'materi'],
    kunci: ['materi jualan', 'bahan jualan', 'alat bantu jualan', 'battle card', 'skrip jualan', 'presentasi penjualan', 'jawaban keberatan', 'atasi keberatan', 'company profile'],
    frasa: [
      'bahan presentasi', 'buat proposal', 'brosur penawaran', 'satu halaman', 'leave behind',
      'bekali tim', 'perlengkapan tim marketing', 'customer keberatan', 'customer nolak', 'alasan customer menolak',
    ],
    modul: `

MODE MATERI JUALAN (Sales Enablement) — aktif kalau user mau membuat bahan bantu jualan untuk tim marketing (ADI/ASTRID/PUTRI/REZA): presentasi, lembar satu halaman, dokumen jawaban keberatan, atau skrip kunjungan:
- TIM PAKAI YANG TIM PERCAYA. Susun dengan bahasa yang tim benar-benar ucapkan ke customer, bukan bahasa kantor pusat. Kalau tim menulis ulang materinya sebelum dipakai, berarti materinya yang salah — libatkan tim, uji dulu ke yang paling sering closing.
- BISA DIPINDAI 3 DETIK, bukan dibaca 30 detik. Judul tebal, poin pendek, hierarki jelas. Kalau tim tidak bisa menemukan jawabannya di tengah telepon dengan customer, materi itu gagal.
- SETIAP KLAIM BERUJUNG KE HASIL BISNIS CUSTOMER: hemat waktu pasang, kurangi komplain pelanggan mereka, kurangi retur/redaman, kurangi kunjungan ulang teknisi, proyek selesai tepat waktu. Fitur tanpa "lalu apa untungnya buat dia" itu kosong.
- Kerangka presentasi: masalah yang dialami sekarang → biaya kalau dibiarkan → perubahan yang sedang terjadi di pasar → cara kita yang berbeda → cara pakainya → bukti angka → SATU cerita customer yang diceritakan dengan baik → cara mulai → nilai/waktu balik modal → harga → langkah berikutnya. Satu ide per halaman. Cerita, bukan daftar fitur.
- Lembar satu halaman: masalah dalam satu kalimat → solusi kita → 3 pembeda → satu bukti kuat → langkah lanjut + kontak. Satu halaman, benar-benar satu.
- SESUAIKAN LAWAN BICARA: teknisi → spek, kompatibilitas, cara pasang; pemilik ISP → biaya, risiko, waktu balik modal; bagian pembelian/gudang → ketersediaan, waktu kirim, syarat bayar.
- Dokumen jawaban keberatan: tulis keberatannya PERSIS seperti yang diucapkan customer, lalu jawaban singkat + buktinya. Keberatan tersering di cabang: harga dibanding merek lain, ketersediaan stok, ongkos & lama kirim, garansi/retur, syarat tempo pembayaran.
- Ambil bukti dari DATA KONTEKS: "topProduk" (produk yang terbukti laku), "stokRelevan" (kedalaman stok), "deliveryOverview" (bukti kecepatan kirim — same day/hand carry), "customerInsights" (customer setia). Angka nyata mengalahkan kata sifat.`,
  },

  kompetitor: {
    nama: 'Hadapi Kompetitor',
    alias: ['competitors', 'kompetitor', 'pesaing'],
    kunci: ['kompetitor', 'pesaing', 'saingan', 'merek lain', 'distributor lain', 'kalah saing', 'dibanding kompetitor'],
    frasa: [
      'customer pindah ke', 'lawan kompetitor', 'bandingkan dengan merek', 'keunggulan kita',
      'pembeda kita', 'kenapa pilih kita',
    ],
    modul: `

MODE HADAPI KOMPETITOR — aktif kalau user mau memposisikan MKI/CFN atau produk Falcom terhadap merek/distributor lain:
- JUJUR MEMBANGUN KEPERCAYAAN: akui kekuatan kompetitor, akui batas kita sendiri, jangan salah menggambarkan produk mereka. Customer sedang membandingkan — dia AKAN mengecek, dan kebohongan kecil membatalkan seluruh kredibilitas.
- LEBIH DALAM DARI DAFTAR CENTANG FITUR: jelaskan KENAPA perbedaannya penting dalam pemakaian nyata — redaman, kekuatan tarik, umur pakai, ketersediaan barang saat dibutuhkan, kecepatan kirim, dukungan teknis, kemudahan garansi, syarat pembayaran.
- BANTU CUSTOMER MEMUTUSKAN: nyatakan terang-terangan kita paling cocok untuk siapa, DAN kompetitor paling cocok untuk siapa. Ini terasa berani tapi justru menaikkan kepercayaan dan mempercepat keputusan.
- Kerangka bahan pembanding: kenapa orang mencari alternatif → posisi kita secara singkat → perbandingan rinci (spek, harga, layanan, ketersediaan) → siapa yang sebaiknya pindah dan siapa yang TIDAK → cara pindah/mencoba tanpa risiko → bukti dari yang sudah pindah → ajakan.
- DILARANG mengarang spek, harga, atau kelemahan kompetitor. Kalau datanya tidak ada di DATA KONTEKS dan tidak diberikan user, katakan itu perlu dicek dulu — jangan menebak angka milik pihak lain. Ini bukan sekadar tidak akurat, ini berisiko buat cabang.
- Keunggulan cabang Makassar yang BISA dibuktikan angkanya (pakai ini, bukan klaim kosong): kedalaman stok lokal ("stokRelevan"/"nilaiStokRelevan"), kecepatan kirim ("deliveryOverview" — same day, hand carry), jangkauan wilayah ("zonaWilayahRelevan"/"wilayahEkspedisiRelevan"), dan basis customer yang bertahan lama ("customerInsights").`,
  },

  riset_pelanggan: {
    nama: 'Riset Pelanggan',
    alias: ['customer-research', 'riset-pelanggan', 'riset'],
    kunci: ['riset pelanggan', 'riset customer', 'suara pelanggan', 'voice of customer', 'wawancara customer', 'survei customer', 'apa kata customer'],
    frasa: [
      'apa yang customer butuh', 'apa maunya customer', 'keluhan customer', 'masukan customer',
      'kenapa customer memilih', 'gali kebutuhan', 'tanya ke customer', 'analisa keluhan',
    ],
    modul: `

MODE RISET PELANGGAN (Suara Pelanggan) — aktif kalau user mau menggali apa yang sebenarnya dirasakan, dibutuhkan, atau dikeluhkan customer:
- Dua mode: (1) ANALISIS bahan yang SUDAH ada — catatan kunjungan, keluhan masuk, alasan berhenti beli, data retur; (2) KUMPULKAN bahan BARU — tanya langsung saat kunjungan, telepon customer yang berhenti, dengarkan obrolan teknisi di grup/komunitas. Kebanyakan kasus butuh keduanya; tentukan dulu yang mana.
- Dari tiap bahan, tarik ENAM hal: (1) pekerjaan yang ingin diselesaikan customer, (2) titik sakitnya, (3) PERISTIWA PEMICU (apa yang berubah sehingga dia mulai mencari), (4) hasil yang dia sebut sebagai "berhasil", (5) KATA-KATA PERSIS yang dia pakai, (6) alternatif yang dia pertimbangkan — termasuk "tidak beli apa-apa" dan "pakai barang seadanya".
- Kata-kata persis customer itu EMAS untuk materi jualan. "Kabelnya sering putus pas ditarik" jauh lebih kuat daripada "kualitas mekanis kurang memadai". Catat verbatim, jangan diparafrase jadi bahasa kantor.
- Kelompokkan per tema, lalu skor dua dimensi: seberapa SERING muncul × seberapa KUAT rasanya. Pisahkan per jenis customer (ISP besar vs RT-RW net kecil vs kontraktor) — jangan dirata-ratakan, polanya beda.
- Beri LABEL KEYAKINAN tiap temuan: TINGGI (muncul di ≥3 sumber terpisah, disebut tanpa dipancing, konsisten antar segmen), SEDANG (2 sumber, atau hanya muncul saat ditanya, atau cuma satu segmen), RENDAH (satu sumber, mungkin kasus menyimpang, perlu divalidasi). JANGAN menyimpulkan pola dari kurang dari 5 titik data terpisah.
- Waspadai bias: yang paling keras komplain belum tentu mewakili mayoritas; data keluhan condong ke masalah bukan ke nilai; customer besar lebih sering terdengar daripada customer kecil yang jumlahnya banyak.
- Titik awal ada di data sendiri: "customerTidakAktif" (daftar siapa yang harus ditelepon dan ditanya kenapa berhenti), "daftarNamaCustomerPerBucket" bucket 1x (kenapa tidak pernah balik), "returRelevan" (apa yang sering diretur = sinyal masalah produk/ekspektasi yang nyata, bukan opini).`,
  },

  jtbd: {
    nama: 'Analisis Akar Masalah (JTBD)',
    alias: ['jtbd', 'jobs-to-be-done', 'akar-masalah'],
    kunci: ['akar masalah', 'root cause', 'jobs to be done', 'jtbd'],
    frasa: [],
    // Carried over verbatim from the standalone wantsJTBD gate this module replaced. Plain
    // substring matching can't cover it — "kenapa sales bulan ini turun" needs the wildcard
    // between the two halves.
    pola: [/kenapa.*(turun|churn|berhenti|tidak.*aktif|meleset|tidak.*tercapai)/],
    modul: JTBD_MODULE,
  },

  dewan: {
    nama: 'Dewan Penasihat Simulasi',
    alias: ['council', 'marketing-council', 'dewan'],
    kunci: ['dewan penasihat', 'banyak sudut pandang', 'pendapat pakar', 'pendapat ahli', 'bandingkan opsi strategi'],
    frasa: ['sudut pandang berbeda', 'debat strategi'],
    // Carried over verbatim from the standalone wantsCouncil gate this module replaced.
    pola: [/menurut beberapa (pakar|ahli)/],
    modul: COUNCIL_MODULE,
  },

  psikologi: {
    nama: 'Psikologi Pemasaran',
    alias: ['psychology', 'psikologi', 'marketing-psychology'],
    kunci: ['psikologi', 'kenapa orang membeli', 'kenapa orang beli', 'perilaku konsumen', 'bias', 'persuasi', 'bukti sosial', 'social proof'],
    frasa: [
      'cara memengaruhi', 'cara mempengaruhi', 'pola pikir customer', 'keputusan membeli',
      'apa yang bikin orang beli', 'mental model',
    ],
    modul: `

MODE PSIKOLOGI PEMASARAN — aktif kalau user tanya kenapa orang membeli atau tidak membeli, atau minta cara memengaruhi keputusan secara etis:
- MODEL UNTUK MENENTUKAN LANGKAH:
  - Prinsip dasar: bongkar masalah sampai kebenaran paling dasar, tanya "kenapa" berulang kali. Jangan meniru langkah kompetitor cuma karena mereka melakukannya.
  - Pembalikan: alih-alih "gimana caranya berhasil?", tanya "apa yang PASTI bikin ini gagal?" lalu hindari satu per satu. Sering jauh lebih produktif.
  - 80/20: cari 20% customer/produk/wilayah yang menghasilkan 80% hasil, lalu fokuskan tenaga ke situ. Sisanya dikurangi, bukan dipaksa.
  - Teori kendala: tiap sistem punya SATU leher botol. Kalau penawaran sudah bagus tapi jumlah customer sedikit, memperbaiki penawaran lagi tidak menolong — perbaiki lehernya dulu. Tentukan lehernya sebelum menyarankan apa pun.
  - Berpikir tingkat kedua: diskon menaikkan penjualan (efek pertama) tapi melatih customer menunggu diskon (efek kedua). Selalu pikirkan efek dari efek.
  - Optimum lokal vs menyeluruh: memoles hal kecil di jalur yang salah tetap tidak menolong. Menjauh dulu sebelum mendekat.
  - Biaya kesempatan: waktu tim yang dipakai untuk kegiatan hasil kecil adalah waktu yang hilang untuk yang hasil besar. Selalu bandingkan dengan alternatifnya.
- MODEL UNTUK MEMAHAMI CUSTOMER:
  - Kesalahan menyalahkan orang: kalau customer tidak jadi beli, periksa PROSES kita dulu (harga tidak jelas, barang kosong, balasan lambat, form ribet) sebelum menyimpulkan "customer-nya memang tidak serius". Penyebabnya hampir selalu situasi, bukan karakter.
  - Efek keseringan terlihat: orang lebih menyukai yang sudah sering dilihat. Kehadiran yang konsisten membangun preferensi diam-diam.
  - Contoh yang mudah dibayangkan terasa lebih mungkin: cerita customer nyata yang berhasil jauh lebih meyakinkan daripada klaim umum.
  - Bukti sosial (siapa lagi yang sudah pakai), penjangkaran harga (angka pertama yang dilihat jadi patokan), penghindaran kerugian (takut kehilangan lebih kuat daripada ingin untung), dan pembingkaian (cara menyajikan angka yang sama) — semuanya nyata dan berlaku.
- BATAS ETIS, TIDAK BISA DITAWAR: semua prinsip ini dipakai untuk MEMPERJELAS nilai yang MEMANG ADA, bukan untuk menekan, menakut-nakuti, atau menipu. Kelangkaan palsu, tenggat bohong, dan testimoni karangan DILARANG — untung sesaat, rugi bertahun-tahun.
- Terapkan ke kasus cabang dengan angka nyata dari DATA KONTEKS, jangan berhenti di teori.`,
  },

  retensi: {
    nama: 'Cegah Customer Berhenti',
    alias: ['churn', 'churn-prevention', 'retensi'],
    kunci: ['churn', 'retensi', 'customer berhenti', 'pelanggan berhenti', 'customer kabur', 'customer hilang', 'customer tidak aktif', 'pelanggan tidak aktif', 'menghidupkan customer', 'customer lama'],
    frasa: [
      'tidak belanja lagi', 'nggak belanja lagi', 'gak belanja lagi', 'berhenti belanja', 'stop order',
      'pertahankan pelanggan', 'mempertahankan customer', 'biar customer balik', 'supaya customer kembali',
      'customer pindah', 'follow up customer lama',
    ],
    modul: `

MODE CEGAH CUSTOMER BERHENTI (Retensi) — aktif kalau user bahas customer yang berhenti belanja, cara mempertahankan pelanggan, atau menghidupkan customer lama:
- BEDAKAN DUA SEBAB, penanganannya beda total:
  (1) BERHENTI SUKARELA — customer memilih berhenti/pindah (harga, layanan, mutu produk, kompetitor lebih menarik).
  (2) BERHENTI TIDAK SENGAJA — sebenarnya masih mau beli tapi TERHALANG: piutang menunggak sehingga order berikutnya tidak bisa jalan, barang yang dia butuh kosong terus, kirim terlalu lama, orang kontaknya berganti, nomor kita tidak dibalas. Yang jenis ini biasanya LEBIH MUDAH diperbaiki dan paling sering terlupakan — periksa ini DULU.
- Alur menahan customer: kenali sinyalnya lebih awal → TANYA alasannya → tawarkan penyelesaian yang SESUAI alasan itu → kalau tetap berhenti, tutup baik-baik → tetap buka pintu untuk kembali.
- COCOKKAN TAWARAN DENGAN ALASAN, jangan asal diskon:
  - "harga kemahalan" → tinjau paket/syarat bayar, bukan langsung potong harga
  - "jarang butuh" → tawarkan pesanan kecil berkala, jangan paksa volume besar
  - "barang sering kosong" → info stok berkala + pre-order
  - "pindah ke kompetitor" → gali apa persisnya yang mereka tawarkan, itu informasi berharga
  - "piutang macet" → jadwal cicilan dan penyelesaian tagihan DULU, bukan penawaran baru
  - "usahanya sepi/tutup" → lepaskan baik-baik, catat alasannya, jangan buang tenaga
- BERTANYA ALASAN ITU WAJIB. Tanpa data alasan, semua penanganan cuma tebakan mahal.
- WAJIB dari data: "customerTidakAktif" (siapa dan sudah berapa lama), "daftarNamaCustomerPerBucket" (yang cuma beli 1x), "customerInsights.totalChurned" (skala masalahnya), dan CEK "piutangBelumLunas" tiap nama — kalau >0, besar kemungkinan ITU sebabnya; tangani penagihan dulu sebelum menawarkan barang.
- SEBUTKAN NAMA dan ANGKA nyata, urutkan mana yang paling layak dihubungi duluan. Jangan memberi saran retensi generik.`,
  },

  rujukan: {
    nama: 'Program Rujukan',
    alias: ['referrals', 'rujukan', 'referral'],
    kunci: ['referral', 'rujukan', 'afiliasi', 'komisi teknisi', 'word of mouth', 'dari mulut ke mulut', 'rekomendasi customer'],
    frasa: [
      'customer bawa customer', 'pelanggan mengajak', 'program komisi', 'mitra penjualan',
      'teknisi bawa pembeli', 'imbalan rujukan',
    ],
    modul: `

MODE PROGRAM RUJUKAN (Referral) — aktif kalau user mau customer, teknisi, atau mitra membawa customer baru:
- Lingkaran rujukan: momen pemicu → cara membagikan → calon baru bertransaksi → hadiah diberikan → berulang. Kalau satu mata rantai putus, seluruh programnya mati.
- MOMEN PEMICU TERBAIK = saat customer BARU SAJA senang: pesanan pertamanya datang tepat waktu, masalah teknisnya selesai dibantu, proyeknya sukses pakai barang kita, atau baru selesai dilayani dengan baik. Mintalah rujukan PADA momen itu, bukan di waktu acak.
- BEDAKAN DUA BENTUK: (1) RUJUKAN CUSTOMER — pelanggan yang sudah beli merekomendasikan ke rekan seusahanya; kepercayaan tinggi, jumlah kecil, hadiah cukup sekali. (2) MITRA/AFILIASI — teknisi lepas, kontraktor, toko kecil yang mengarahkan pembeli; jangkauan lebih luas, kepercayaan bervariasi, perlu KOMISI yang jelas dan berkelanjutan.
- BENTUK HADIAH: satu sisi (hanya perujuk) lebih sederhana untuk transaksi bernilai besar; DUA SISI (perujuk dan yang dirujuk sama-sama dapat) biasanya lebih jalan karena terasa saling untung dan enak disampaikan; bertingkat kalau mau dijadikan program jangka panjang.
- BUAT MEKANISMENYA SEDERHANA dan bisa jalan TANPA aplikasi: kode rujukan yang disebut saat order, atau kolom "dari siapa" yang wajib diisi di form order. Yang penting KONSISTEN dicatat — kalau tidak tercatat, tidak bisa dibayarkan dan tidak bisa diukur, dan programnya berhenti sendiri.
- ATURAN JUJUR: hadiah HARUS benar-benar dibayarkan dan cepat. Satu kali telat bayar komisi ke teknisi, kabarnya menyebar dan program rujukan langsung mati di komunitas itu.
- Kandidat perujuk terbaik SUDAH ADA di data: "customerInsights.topByFrekuensi" (paling sering belanja — paling sering ketemu orang) dan "topBySales" (paling besar belanjanya — paling punya pengaruh). Sebut nama nyatanya.`,
  },

  proses_sales: {
    nama: 'Proses & Pipeline Penjualan',
    alias: ['revops', 'pipeline', 'proses-sales'],
    kunci: ['pipeline', 'revops', 'proses penjualan', 'alur penjualan', 'alur prospek', 'serah terima', 'pembagian tugas tim', 'sop penjualan'],
    frasa: [
      'proses jualan berantakan', 'bocor di mana', 'tahapan penjualan', 'siapa pegang apa',
      'lead tidak ditindaklanjuti', 'prospek terlantar', 'sistem pencatatan',
    ],
    modul: `

MODE PROSES & PIPELINE PENJUALAN (RevOps) — aktif kalau user bahas alur dari prospek sampai jadi customer, pembagian tugas tim, atau kebocoran proses:
- SATU SUMBER KEBENARAN. Kalau data prospek tersebar di catatan pribadi masing-masing orang, pasti bentrok dan pasti ada yang jatuh. Tentukan SATU tempat pencatatan resmi, semua ikut ke situ, tanpa pengecualian.
- TETAPKAN DULU, BARU OTOMATISKAN. Sepakati definisi tiap tahap di atas kertas sebelum membuat form/sistem. Mengotomatiskan proses yang rusak cuma membuat rusaknya lebih cepat dan lebih rapi.
- UKUR TIAP SERAH TERIMA. Setiap perpindahan tanggung jawab adalah titik bocor: marketing → penjualan, penjualan → gudang, gudang → pengiriman, pengiriman → penagihan. Tiap titik butuh batas waktu, cara mencatat, dan SATU nama penanggung jawab — bukan "tim".
- Tahapan sederhana yang cocok untuk cabang: Kontak → Prospek Layak → Penawaran Terkirim → Negosiasi → Order Masuk → Terkirim → TERBAYAR. Customer belum benar-benar "jadi" sebelum uangnya masuk — piutang macet artinya tahap TERAKHIR yang bocor, dan itu tetap tanggung jawab proses penjualan.
- "PROSPEK LAYAK" butuh DUA hal SEKALIGUS: COCOK (jenis usaha, wilayah, skala) DAN BERMINAT (ada tanda nyata — minta harga, minta contoh, tanya stok, tanya tempo). Salah satu saja tidak cukup: perusahaan yang cocok tapi tidak pernah merespons bukan prospek layak, dan yang rajin bertanya tapi jelas di luar sasaran juga bukan.
- BATAS WAKTU RESPONS itu inti. Makin cepat prospek dihubungi setelah dia bertanya, makin besar peluang tutup — jaraknya besar, bukan sedikit. Sepakati batas dalam JAM, bukan "secepatnya".
- Ukur dari data yang sudah ada: "rankingKinerjaPersonel" (kapasitas & kepatuhan tim), "targetPerformaHarianBulanan" (jumlah invoice & ketepatan kirim), "sisaTarget" (jarak ke target), "piutangPerKategoriUmur" (kebocoran di ujung proses), "transaksiBelumDikirim" (kebocoran di pengiriman). Tunjuk tahap mana yang paling bocor berdasarkan angka, jangan menebak.`,
  },

  positioning: {
    nama: 'Positioning & Pesan Produk',
    alias: ['positioning', 'product-marketing', 'posisi'],
    kunci: ['positioning', 'posisi produk', 'pesan produk', 'value proposition', 'nilai jual', 'nilai jual utama', 'diferensiasi', 'citra cabang'],
    frasa: [
      'kita ini apa', 'apa bedanya kita', 'kenapa harus beli dari kita', 'apa keunggulan kita',
      'siapa target kita', 'customer ideal kita', 'pesan utama',
    ],
    modul: `

MODE POSITIONING & PESAN PRODUK — aktif kalau user mau merumuskan "kita ini apa, untuk siapa, dan kenapa dipilih":
- Rumuskan SEMBILAN hal ini, jujur dan spesifik: (1) apa yang dijual dalam satu kalimat; (2) siapa customer idealnya — jenis usaha, skala, wilayah, siapa yang memutuskan; (3) masalah inti yang mereka alami sebelum menemukan kita, dan apa ongkosnya buat mereka; (4) lanskap pesaing — pesaing LANGSUNG (distributor/merek sejenis), pesaing TIDAK LANGSUNG (beli langsung ke pabrik/importir, marketplace), dan "tidak beli sama sekali / pakai barang seadanya"; (5) pembeda yang nyata; (6) tiga keberatan tersering beserta jawabannya; (7) siapa yang JELAS BUKAN customer kita; (8) empat gaya dorong perpindahan — Dorongan (kekesalan pada keadaan sekarang), Tarikan (daya tarik kita), Kebiasaan (yang menahan dia bertahan), Kekhawatiran (takut salah pindah); (9) kata-kata PERSIS yang dipakai customer.
- POSISIKAN TERHADAP ALTERNATIF NYATA yang sedang dipertimbangkan customer, bukan terhadap merek yang kita ANGGAP saingan. Pertanyaan penentunya: kalau kita tidak ada, dia beli ke mana? Jawaban itulah pesaing sebenarnya.
- PEMBEDA HARUS SESUATU YANG ALTERNATIF LAIN TIDAK BISA KLAIM. "Kualitas bagus", "harga bersaing", dan "pelayanan terbaik" BUKAN pembeda — semua distributor mengklaim itu, jadi nilainya nol.
- Untuk cabang Makassar, pembeda yang bisa dibuktikan angkanya: kedalaman stok lokal (barang ADA saat dibutuhkan, bukan indent), kecepatan kirim (same day / hand carry), jangkauan wilayah sampai kabupaten, dukungan teknis yang bisa ditelepon, dan riwayat panjang dengan customer setia. Buktikan dari "stokRelevan"/"deliveryOverview"/"zonaWilayahRelevan"/"customerInsights" — jangan klaim kosong.
- Hasil rumusan ini dipakai ulang oleh SEMUA materi lain (penawaran, pesan perkenalan, konten, materi jualan). Kalau positioning-nya kabur, semua tulisan promosi ikut kabur — kerjakan ini dulu kalau belum ada.`,
  },

  copy: {
    nama: 'Tulis Materi Promosi',
    alias: ['copywriting', 'copy', 'tulis'],
    kunci: ['copywriting', 'tulis promosi', 'teks promosi', 'kata-kata promosi', 'caption promosi', 'judul menarik', 'headline', 'tagline', 'spanduk', 'brosur'],
    frasa: [
      'buatkan kalimat', 'bikin kalimat promosi', 'tulisan untuk promosi', 'kata-kata untuk',
      'perbaiki tulisan', 'kalimat penawaran', 'teks iklan',
    ],
    modul: `

MODE TULIS MATERI PROMOSI (Copywriting) — aktif kalau user minta dibuatkan atau diperbaiki teks promosi, judul, spanduk, caption, atau penawaran tertulis:
- JELAS MENGALAHKAN PINTAR. Kalau harus memilih antara jelas dan kreatif, pilih jelas. Selalu.
- MANFAAT DI ATAS FITUR. Fitur = apa barangnya. Manfaat = apa artinya buat customer. "Kabel dropcore 1 core dengan messenger" → "sekali tarik langsung kuat, tidak perlu sling tambahan".
- SPESIFIK MENGALAHKAN SAMAR. Bukan "hemat waktu pemasangan", tapi "pasang satu titik dari 40 menit jadi 15 menit". Angka mengalahkan kata sifat.
- PAKAI BAHASA CUSTOMER, bukan bahasa kantor. Tiru kata-kata yang benar-benar diucapkan teknisi dan pemilik ISP di lapangan.
- SATU IDE PER BAGIAN. Tiap bagian mendorong satu argumen, tersusun mengalir dari atas ke bawah.
- Gaya menulis: kata sederhana ("pakai" bukan "mempergunakan"), kalimat AKTIF ("kami kirim hari ini" bukan "barang akan dikirimkan"), percaya diri (buang "hampir", "sangat", "cukup", "kurang lebih"), TUNJUKKAN jangan cuma bilang, dan JUJUR — angka atau testimoni karangan merusak kepercayaan sekaligus berisiko secara hukum.
- BUANG: tanda seru, kata sakti tanpa isi ("solusi terbaik", "inovatif", "terdepan", "berkualitas tinggi"), dan kalimat yang mengerjakan terlalu banyak hal sekaligus.
- Pertanyaan retoris ("Sering kehabisan stok pas lagi banyak order?") dan perumpamaan sederhana boleh dipakai kalau membantu customer mengenali situasinya sendiri.
- SEMUA angka dan klaim di teks WAJIB berasal dari DATA KONTEKS atau dari user. JANGAN mengarang angka penjualan, jumlah customer, tahun berdiri, atau spek produk demi kalimat yang enak dibaca — ini pelanggaran serius, bukan lisensi kreatif.`,
  },

  medsos: {
    nama: 'Konten Media Sosial',
    alias: ['social', 'medsos', 'konten'],
    kunci: ['media sosial', 'medsos', 'tiktok', 'instagram', 'konten sosial', 'kalender konten', 'ide konten', 'posting', 'reels', 'shorts'],
    frasa: [
      'mau posting apa', 'konten untuk', 'video pendek', 'naikkan followers', 'tambah pengikut',
      'jadwal posting', 'strategi konten',
    ],
    modul: `

MODE KONTEN MEDIA SOSIAL — aktif kalau user mau membuat konten, kalender, atau ide posting media sosial:
- BARIS/DETIK PERTAMA menentukan sisanya dibaca atau tidak. Bentuk kail yang biasanya jalan: rasa ingin tahu ("Ternyata saya salah soal ..."), cerita ("Minggu lalu ada teknisi yang ..."), nilai ("Cara ... tanpa harus ..."), atau angka ("3 kesalahan yang bikin redaman naik").
- BANGUN 3-5 PILAR KONTEN lalu bagi porsinya — jangan asal posting. Contoh porsi yang masuk akal untuk cabang: edukasi teknis 30% (cara pasang, memilih kabel, mengatasi redaman, konfigurasi ONU), di balik layar 25% (tim, gudang, proses pengiriman, kegiatan cabang), wawasan industri 20% (tren jaringan, pergerakan harga bahan), cerita customer 20%, promosi langsung 5%. Promosi yang sedikit justru bikin promosinya didengar.
- SESUAIKAN PLATFORM: video pendek (TikTok/Reels/Shorts) untuk jangkauan & pengenalan merek; YouTube untuk tutorial panjang yang dicari orang justru saat sedang butuh; Facebook dan grup untuk komunitas teknisi lokal; WhatsApp Status/Channel untuk customer yang sudah ada; LinkedIn untuk urusan antar-perusahaan/instansi.
- SATU BAHAN DIPAKAI BERKALI-KALI: satu tutorial panjang bisa jadi 5 video pendek, satu rangkaian gambar, dan beberapa caption. Jangan bikin dari nol tiap kali.
- KONSISTEN LEBIH PENTING DARIPADA SEMPURNA. Jadwal yang sanggup dijalankan tiap minggu mengalahkan rencana besar yang berhenti di minggu ketiga. Tentukan jadwal sesuai tenaga tim yang benar-benar ada.
- Cabang SUDAH punya aset nyata: video tutorial YouTube, video TikTok, dan artikel teknis Falcom — semuanya ada di "referensiLink". Arahkan ke situ dan bangun dari situ. JANGAN mengarang tautan atau menjanjikan konten yang belum ada.`,
  },

  humas: {
    nama: 'Humas & Event',
    alias: ['pr', 'public-relations', 'humas'],
    kunci: ['humas', 'public relations', 'siaran pers', 'press release', 'liputan', 'media lokal', 'roadshow', 'gathering', 'pameran', 'event cabang'],
    frasa: [
      'biar dikenal', 'supaya dikenal', 'masuk media', 'diliput media', 'acara customer',
      'workshop teknisi', 'pelatihan teknisi', 'seminar',
    ],
    modul: `

MODE HUMAS & EVENT (PR) — aktif kalau user bahas publikasi, media, siaran pers, event, roadshow, atau cara cabang dikenal:
- PR BUKAN PENGGANTI PENJUALAN, TAPI PENGGANDA. Liputan tidak langsung menghasilkan order. Yang dihasilkan: kredibilitas, bahan pembicaraan untuk tim penjualan, dan rasa aman buat customer baru yang belum kenal kita.
- CERITANYA BUKAN PRODUK KITA. Ceritanya adalah TREN, DATA, KONFLIK, atau MANUSIANYA — produk kita cuma buktinya. "Distributor X menjual kabel" bukan berita. "Pertumbuhan ISP lokal di Sulawesi Selatan dan apa yang mereka hadapi, ini datanya" itu berita.
- PR layak dikerjakan kalau: ada cerita NYATA (data yang kita punya sendiri, pencapaian, kisah customer dengan perubahan sebelum-sesudah yang tajam, atau sudut baru atas isu yang sedang ramai), ada orang yang bersedia diwawancara, dan ada tujuan jelas setelah orang tertarik. Kalau ketiganya belum ada, tunda dulu.
- EMPAT MODE, jalankan minimal tiga: (1) REAKTIF — menyisipkan sudut pandang kita ke isu yang sedang hangat; cepat, murah, hasilnya dalam hitungan hari. (2) AKTIF — menawarkan cerita ke media/komunitas; butuh 2-8 minggu dan ketekunan. (3) MASUK — menjawab permintaan narasumber. (4) MILIK SENDIRI — profil, foto, logo, kontak yang selalu siap dipakai; sekali disiapkan, berguna selamanya.
- UNTUK CABANG, jalur paling realistis: media lokal Sulsel, komunitas dan grup teknisi/ISP, kanal Falcom sendiri, dan EVENT — roadshow kabupaten, pelatihan teknisi, gathering customer, demo produk di lokasi. Event sering JAUH lebih efektif daripada mengejar media besar, dan hasilnya langsung terlihat di daftar prospek.
- Ambang mutu sebelum menawarkan cerita: ada kaitan waktu yang jelas ("baru saja terjadi"), bisa jadi tulisan utuh hanya dari satu pesan itu, di bawah 150 kata, tanpa kata "revolusioner"/"terdepan"/"mengubah permainan", dan permintaannya jelas. Kalau ada satu saja yang belum, jangan dikirim.
- BATAS DATA: liputan/publikasi itu KELUAR ke pihak luar, jadi aturan "BATAS PEMAKAIAN" di LAMPIRAN DATA INTERNAL berlaku penuh di sini — angka internal cabang tidak boleh dicantumkan tanpa persetujuan Branch Manager. Pakai hanya angka yang memang layak publik, dan ingatkan hal ini sebelum apa pun dikirim ke media.`,
  },

  rencana: {
    nama: 'Rencana Marketing Cabang',
    alias: ['marketing-plan', 'rencana', 'rencana-marketing'],
    kunci: ['rencana marketing', 'rencana pemasaran', 'strategi menyeluruh', 'roadmap marketing', 'program kerja', 'rencana kerja', 'rencana tahunan', 'aarrr'],
    frasa: [
      'rencana 90 hari', 'rencana setahun', 'rencana 12 bulan', 'susun strategi', 'strategi cabang',
      'peta jalan', 'rencana pertumbuhan',
    ],
    modul: `

MODE RENCANA MARKETING CABANG — aktif kalau user minta disusunkan rencana marketing/pertumbuhan yang menyeluruh:
- Susun dengan kerangka LIMA TAHAP CORONG supaya tiap usulan jelas menyasar tahap mana dan bisa dikerjakan berurutan:
  1. AKUISISI — orang yang belum kenal jadi tahu kita ada (customer baru, wilayah baru, kanal baru).
  2. AKTIVASI — yang sudah tahu jadi bertransaksi PERTAMA kali, dengan pengalaman yang cukup baik untuk mau mengulang.
  3. RETENSI — yang sudah beli terus beli lagi dan makin besar.
  4. RUJUKAN — customer yang puas membawa customer lain.
  5. PENDAPATAN — harga, paket, tambahan jualan, margin.
- Isi rencananya: (1) ringkasan — 3 taruhan besar + prioritas 90 hari + hasil yang dikejar 12 bulan; (2) kerangka strategi — kita di kategori apa, customer ideal, citra cabang; (3) keadaan sekarang — tim, anggaran, apa yang sudah jalan, apa yang mandek; (4-8) lima tahap corong di atas; (9) peta jalan 90 hari dibagi per 2 minggu; (10) gambaran 12 bulan per kuartal; (11) siapa mengerjakan apa dengan alat apa; (12) bank ide taktis; (13) pengukuran — satu metrik utama + indikator awal per tahap + keputusan yang masih menggantung.
- SETIAP butir rencana WAJIB punya tiga hal: PENANGGUNG JAWAB (nama orang nyata — ADI/ASTRID/PUTRI/REZA untuk marketing, ASPAR/BURHAMIN/TAUFIK/ZUL untuk logistik), TENGGAT, dan CARA MENGUKUR berhasil. Butir tanpa ketiganya bukan rencana, cuma harapan.
- "Keadaan sekarang" WAJIB diisi dari DATA KONTEKS nyata, bukan asumsi: "sisaTarget"/"targetPerformaHarianBulanan" (posisi terhadap target), "perbandinganTahunSebelumnya" (pertumbuhan vs 2025), "customerInsights"/"customerTidakAktif" (kesehatan basis customer), "zonaWilayahRelevan" (wilayah kurang garap), "piutangPerKategoriUmur" (kesehatan tagihan), "topProduk"/"stokTidakBergerakDanKurangLaku" (kesehatan barang), "rankingKinerjaPersonel" (kapasitas tim).
- JUJUR SOAL BATAS: tim 8 orang, anggaran terbatas, tidak ada tim iklan khusus, dan mereka masih mengerjakan operasional harian. Rencana yang tidak sanggup dijalankan bukan rencana — lebih baik 5 hal yang selesai daripada 20 yang mangkrak.`,
  },

  ide: {
    nama: 'Bank Ide Pertumbuhan',
    alias: ['marketing-ideas', 'ide', 'ide-marketing'],
    kunci: ['ide marketing', 'ide pemasaran', 'ide promosi', 'buntu', 'kehabisan ide', 'apa lagi yang bisa', 'cara menaikkan penjualan', 'cara meningkatkan penjualan', 'biar sales naik', 'supaya penjualan naik'],
    frasa: [
      'ide baru', 'terobosan', 'cara promosi', 'gimana caranya jualan', 'apa yang bisa dicoba',
      'inovasi pemasaran',
    ],
    modul: `

MODE BANK IDE PERTUMBUHAN — aktif kalau user buntu, minta ide marketing, atau tanya "apa lagi yang bisa dicoba":
- JANGAN lempar daftar panjang. Pilih 3-5 ide yang PALING cocok dengan keadaan cabang SEKARANG, lalu jelaskan cara menjalankannya secara konkret. Daftar 20 ide tanpa arah sama saja dengan tidak menjawab.
- Saring dulu dengan tiga hal: modal yang benar-benar ada, waktu tim yang tersisa di luar operasional harian, dan seberapa cepat hasilnya kelihatan.
- Kategori ide yang REALISTIS untuk distributor B2B di Makassar:
  - Menghidupkan customer lama: hubungi yang berhenti ≥60 hari, hubungi yang baru beli 1x, paket khusus pembelian ulang. Ini paling murah dan paling cepat menghasilkan.
  - Menggarap wilayah: kunjungan/kanvas ke zona kuning dan merah, cari mitra di kabupaten yang belum tergarap.
  - Kemitraan: kerja sama dengan kontraktor jaringan, toko komputer/listrik lokal, komunitas teknisi, vendor CCTV.
  - Edukasi: pelatihan/workshop teknisi (splicing, OTDR, konfigurasi ONU), video tutorial, panduan memilih kabel. Yang mengajari, yang dipercaya.
  - Acara: gathering customer, roadshow kabupaten, demo produk di lokasi customer besar.
  - Paket & promo: membundling barang terlaris dengan stok yang lambat bergerak, promo musiman, harga proyek.
  - Layanan sebagai pemasaran: kecepatan kirim, konsultasi teknis gratis, penanganan garansi/retur yang cepat — ini pembeda paling murah dan paling terasa oleh customer.
  - Kehadiran daring: video pendek, katalog digital, WhatsApp Channel untuk info stok & promo.
  - Rujukan: imbalan untuk teknisi/customer yang membawa pembeli baru.
- WAJIB tautkan TIAP ide ke angka nyata dari DATA KONTEKS (nama customer, nama wilayah, nama produk, nominal), lalu urutkan berdasarkan "paling cepat menghasilkan dengan usaha paling kecil". Ide generik tanpa data bukan jawaban.`,
  },
};

// Injected ahead of any skill module, and on plain strategy questions too (see wantsSaran at the
// call site). The modules each name the fields they need, but a strategy answer is only as good as
// the constraints it respects — so the branch's own internal numbers are attached once, up front,
// as mandatory input rather than optional colour. Internal use is unrestricted here; the approval
// gate is on anything leaving the branch, which is why the publication clause lives at the bottom
// rather than inside the PR module alone.
const SKILL_LAMPIRAN = `

LAMPIRAN DATA INTERNAL — WAJIB jadi bahan pertimbangan untuk SEMUA pertanyaan strategi, marketing, dan penjualan. Tarik angka yang relevan DULU, baru menyusun rekomendasi. Angka ini DASAR jawabanmu, bukan pelengkap yang ditempel di akhir:
1. KESEHATAN TAGIHAN — "piutang", "piutangPerKategoriUmur", "piutangCustomerTertinggi", "piutangPerCompany", "piutangLampau2015sd2025". Penjualan yang tidak tertagih bukan penjualan. Strategi yang menambah volume TAPI mengabaikan umur piutang justru memperburuk keadaan — kalau usulanmu punya risiko itu, SEBUTKAN terus terang.
2. POSISI TERHADAP TARGET — "sisaTarget", "pencapaianRingkasan", "targetPerformaHarianBulanan", "perbandinganTahunSebelumnya". Ini yang menentukan seberapa agresif rekomendasimu boleh dan berapa waktu yang benar-benar tersisa.
3. KAPASITAS TIM — "rankingKinerjaPersonel", "absensiDanIndikatorHarian", "jabatanPersonel". Rencana yang melebihi kapasitas tim 8 orang tidak akan jalan. Sebut siapa yang realistis mengerjakan, jangan menyerahkan ke "tim" tanpa nama.
4. KESEHATAN BASIS CUSTOMER — "customerInsights", "customerTidakAktif", "daftarNamaCustomerPerBucket". Menahan customer yang sudah ada hampir selalu lebih murah daripada mencari yang baru — periksa ini sebelum menyarankan perburuan customer baru.
5. BARANG & UANG YANG TERTAHAN — "stokTidakBergerakDanKurangLaku", "nilaiStokRelevan", "saranRestockProdukTerlaris", "topProduk". Stok mati itu uang cabang yang terkunci di gudang; stok terlaris yang menipis itu penjualan yang akan hilang.
6. JANGKAUAN & PENGIRIMAN — "zonaWilayahRelevan", "deliveryOverview", "wilayahEkspedisiRelevan", "transaksiBelumDikirim".
- MARGIN, HPP, HARGA BELI, DAN LABA TIDAK ADA di sistem ini — yang tersedia HANYA HARGA JUAL ("stokRelevan" field "harga"). Kalau pertanyaannya bergantung pada margin (mis. "diskon berapa yang masih untung", "produk mana yang paling menguntungkan"), KATAKAN TERUS TERANG angka margin/modal tidak tersedia, lalu minta angkanya dari penanya supaya bisa dihitung. JANGAN PERNAH mengarang, memperkirakan, atau menyamakan margin dengan harga jual — ini pelanggaran serius yang bisa membuat keputusan harga cabang salah.
- Field yang null/kosong → sebutkan keterbatasannya apa adanya, jangan ditambal tebakan.
- BATAS PEMAKAIAN: semua angka di lampiran ini untuk PERTIMBANGAN INTERNAL cabang — bebas dipakai untuk analisis, saran, dan diskusi dengan tim. TAPI untuk apa pun yang KELUAR ke pihak luar (materi promosi, siaran pers, konten media sosial, presentasi ke customer, penawaran tertulis), angka internal (piutang, KPI personel, nama customer beserta nominalnya, nilai stok) TIDAK BOLEH dicantumkan tanpa persetujuan Branch Manager. Pakai hanya angka yang memang layak publik, dan ingatkan hal ini kalau kamu sedang membantu menyusun materi yang akan dilihat pihak luar.`;

// Precompiled once instead of per request: "/offer", "pakai skill offer", "mode penawaran", etc.
const SKILL_ALIAS_MATCHERS = Object.entries(SKILL_MODULES).map(([key, s]) => {
  const alts = s.alias.join('|');
  return [
    key,
    new RegExp(`(^|\\s)(\\/(?:${alts})|(?:pakai|pake|gunakan|aktifkan|coba|jalankan|mode|skill|jurus)\\s+(?:skill\\s+)?(?:${alts}))(\\s|$)`),
  ];
});

// Returns up to 2 skill-module keys for this message. Explicit invocation wins outright; otherwise
// the module is inferred from how the question is actually phrased in Indonesian, so the team never
// has to memorise skill names. Deliberately capped at 2 — each module costs ~400-800 tokens and
// stacking more turns the answer into a lecture instead of an answer.
function resolveSkillModules(message) {
  const nMsg = ` ${normText(message).replace(/[^\p{L}\p{N}/\s-]/gu, ' ').replace(/\s+/g, ' ')} `;

  const explicit = [];
  for (const [key, re] of SKILL_ALIAS_MATCHERS) {
    if (re.test(nMsg)) explicit.push(key);
  }
  if (explicit.length) return explicit.slice(0, 2);

  const scored = [];
  for (const [key, s] of Object.entries(SKILL_MODULES)) {
    let score = 0;
    for (const k of s.kunci) if (nMsg.includes(k)) score += 3;
    for (const f of s.frasa) if (nMsg.includes(f)) score += f.trim().split(/\s+/).length;
    if (s.pola) for (const p of s.pola) if (p.test(nMsg)) score += 3;
    if (score >= 2) scored.push({ key, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 2).map((x) => x.key);
}

// Always-on one-liner so MIRA can answer "skill apa saja yang kamu punya?" without loading any
// module. Cheap (~300 tokens) and it's what makes the explicit-command path discoverable.
const DAFTAR_SKILL_RINGKAS = Object.entries(SKILL_MODULES)
  .map(([, s]) => `${s.nama} (/${s.alias[0]})`)
  .join(' · ');

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
  // Pure-digit tokens ("1", "2", "4"...) are kept even at length 1 — a real reported case:
  // dropping the "1" in "1 core" from scoring made "1 core" and "2 core" keyword phrases score
  // the same (the digit was the ONLY thing distinguishing them), so "kabel 1 core terbaik"
  // surfaced a 2-core catalog product/photo instead of any 1-core one.
  const words = phrase.toLowerCase().split(/\s+/).filter((w) => w.length >= 2 || /^\d+$/.test(w));
  if (!words.length) return 0;
  // Typo tolerance: a keyword word also counts as a hit if it's within edit-distance of some word
  // actually typed in the message (mis. "fusion splicr" still finds "fusion splicer") — gated to
  // words >=4 chars, since edit-distance-1 on a 2-3 letter word is too loose to mean anything.
  const msgWords = nMsg.split(/\s+/).filter(Boolean);
  const hits = words.filter((w) =>
    nMsg.includes(w) || (w.length >= 4 && msgWords.some((mw) => fuzzyWordEquals(w, mw)))
  ).length;
  return hits / words.length;
}

// Product catalog lookup — returns up to 5 best-matching products (ranked), or null if nothing
// scores high enough. Kept separate from PRODUCT_CATEGORIES: this is for SPECIFIC product
// questions ("ODP 16 port hitam"), categories handle broader ones ("kabel fiber optik apa saja").
function findProductCatalogMatch(message) {
  const nMsg = normText(message);
  // Same core-count guard as resolveStockCodeToCatalogProduct below — without it, "kabel 1 core"
  // could still score a 2/4/6-core product just as high (or higher) purely on shared generic
  // words like "kabel"/"dropcore"/"premium", since word-overlap scoring alone doesn't know those
  // are mutually exclusive specs.
  const msgCore = extractCoreCount(message);
  const scored = [];
  for (const p of PRODUCT_CATALOG) {
    let best = 0;
    for (const kw of p.keywords) {
      const s = phraseMatchScore(kw, nMsg);
      if (s > best) best = s;
    }
    if (best < 0.6) continue;
    if (msgCore) {
      const candidateCore = extractCoreCount(`${p.nama} ${p.keywords.join(' ')}`);
      if (candidateCore && candidateCore !== msgCore) continue;
    }
    scored.push({ p, score: best });
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
  // Plain "kasih link produk"/"link katalog Falcom" requests don't mention "spek" at all, so they
  // used to match NOTHING (hasAnyMatch false, wantsSpec false) — fallbackUmum stayed empty and
  // Gemini had zero real URLs to ground on, which is exactly how it ended up fabricating a
  // nonexistent domain ("falcomindo.com") for a real user request. Broadened trigger below.
  const wantsProdukLinkUmum = /link (produk|katalog)|katalog (produk|falcom)|website falcom|web falcom|situs falcom|link falcom|semua produk/.test(nMsg);
  const video = matchVideos(message);
  // A resolved stock CODE goes through the stricter dedicated matcher (core-count + category
  // filtering, see resolveStockCodeToCatalogProduct) instead of the general one — the code itself
  // already pins down one exact physical item, so the noisier free-text matcher's tolerance for
  // several loosely-related options (including flat-out wrong specs) isn't appropriate here.
  const produkSpesifik =
    resolveKnownCodeOverride(message) ||
    (stockDescriptions.length ? resolveStockCodeToCatalogProduct(stockDescriptions.join(' ')) : findProductCatalogMatch(message));
  const hasAnyMatch = kategoriProduk.length || solusiSistem.length || wantsTutorial || wantsArticle || video.teknis.length || video.tiktok.length || produkSpesifik;
  return {
    produkSpesifikCocok: produkSpesifik,
    kategoriProduk,
    solusiSistem,
    // Generic bundle (Bantuan & Dukungan + Kelas Pelatihan FTTX + Galeri Video + Channel) is a
    // FALLBACK only — if a specific video already matched, that's more useful/less cluttered
    // than dumping all 4 generic links alongside it.
    tutorialDanDukungan: wantsTutorial && !video.teknis.length && !video.tiktok.length ? TUTORIAL_LINKS : [],
    artikel: wantsArticle ? [ARTICLE_LINK] : [],
    videoTutorialRelevan: video.teknis,
    videoTiktokRelevan: video.tiktok,
    videoKegiatanFalcom: video.nonTeknis,
    // Only fall back to generic pages when there's a clear product-spec question (or a plain
    // request for the general product link) with no specific category match — never for
    // unrelated operational questions (sales/stok/piutang).
    fallbackUmum: (wantsSpec || wantsProdukLinkUmum) && !hasAnyMatch ? [GENERAL_LINKS.semuaProduk, GENERAL_LINKS.kontak] : [],
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
  // 'atas'/'nama' ditambahkan supaya pertanyaan "customer atas nama X" tidak ikut menganggap
  // "atas"/"nama" sebagai token nama yang harus dicocokkan (lihat customerNameFuzzyMatch Rule B).
  'atas', 'nama',
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

// Shared typo-tolerance check for a single word pair — same threshold used across all fuzzy
// matchers (customer names, personnel names, product keywords): exact match, or within edit-
// distance 1 for short words (<=4 chars) / 2 for longer ones, scaled so a name-length mismatch
// doesn't silently pass (e.g. "budi" should never fuzzy-match "budianto").
function fuzzyWordEquals(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  return levenshtein(a, b) <= (Math.min(a.length, b.length) <= 4 ? 1 : 2);
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

  // EXACT code match first, checked in isolation — a real reported bug: "stock KSFO028" (a real,
  // exact, valid code) also matched "KSFO020" via the levenshtein typo-tolerance a few lines down
  // (edit-distance 1 apart), and the WRONG product/stock got shown. That tolerance makes sense for
  // human names (a typo is still the same person) but is actively dangerous for systematically
  // numbered codes, where a one-digit difference is almost always a DIFFERENT, equally-real
  // product, not a typo of the one asked for. So: if any keyword exactly equals a real code,
  // restrict to ONLY exact matches and skip the fuzzy/substring fallback below entirely.
  let matched = allStock.filter((p) => {
    const nKode = normCode(p.kode);
    return effectiveKeywords.some((kw) => {
      const ckw = normCode(kw);
      return ckw.length >= 3 && nKode === ckw;
    });
  });
  if (!matched.length) {
    matched = allStock.filter((p) => {
      const nKode = normCode(p.kode);
      const nNama = normText(p.nama);
      return effectiveKeywords.some((kw) => {
        const nkw = normText(kw);
        const ckw = normCode(kw);
        if (ckw.length >= 3 && nKode.includes(ckw)) return true;
        if (nkw.length >= 3 && nNama.includes(nkw)) return true;
        // NOTE: typo/edit-distance tolerance on the CODE itself is intentionally NOT here anymore
        // (explicit request) — stock codes are systematically numbered (KSFO080, KSFO081, KSFO082,
        // ...KSFO089 are all real, different products just one digit apart), so "close enough"
        // fuzzy matching on a code is never safe: it can only ever return a DIFFERENT real product,
        // not a corrected typo. A code must now match exactly or as a real substring — nothing
        // fuzzy. Typo tolerance on the product NAME (words, not the code) is still fine below,
        // since name text isn't systematically enumerated the same way — mis. "splicr" still
        // finds "Fusion Splicer ...".
        if (nkw.length >= 4 && nNama.split(/\s+/).some((nw) => fuzzyWordEquals(nkw, nw))) return true;
        return false;
      });
    });
  }

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
  const monthsElapsed = nowMakassar().getMonth() + 1;

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

// Same keyword set as wantsTopProduk in handleChat — kept in sync so "produk terlaris"-style
// phrasing routes here INSTEAD of the cumulative-2026 topProduk whenever a specific month is also
// named ("produk terlaris bulan Juli", "ranking produk Juni 2026") — matches the live dashboard's
// own "Peringkat Kode Barang per Bulan" sub-view, which this backend didn't have an equivalent
// for until this was reported. Computed on-demand from the raw transaction rows (same principle
// as findTransactionMatches) rather than pre-aggregated in KV, since a month filter is arbitrary.
function findTopProdukByMonth(message, allTransactions, allStock) {
  if (!allTransactions.length) return null;
  const nMsg = normText(message);
  const wantsRanking = new RegExp(
    `terlaris|paling laku|paling laris|top ?produk|produk ?top|best ?seller|produk.*populer|(banyak|terbanyak) terjual|(ranking|peringkat|urutan|urutkan).*produk|produk.*(ranking|peringkat)|produk.*(${SUPERLATIVE_ANY})|(${SUPERLATIVE_ANY}).*(terjual|produk)`
  ).test(nMsg);
  if (!wantsRanking) return null;
  const monthMention = extractMonthMention(message);
  if (!monthMention) return null; // no specific month named -> let the cumulative "topProduk" field handle it

  const namaByKode = {};
  for (const p of allStock) if (p.kode) namaByKode[p.kode] = p.nama;

  const byKode = {};
  for (const tx of allTransactions) {
    if (!tx.kode) continue;
    const d = parseFlexibleDate(tx.tanggal);
    if (!d || d.getMonth() + 1 !== monthMention.month || d.getFullYear() !== monthMention.year) continue;
    if (!byKode[tx.kode]) byKode[tx.kode] = { kode: tx.kode, nama: namaByKode[tx.kode] || null, amount: 0, qty: 0 };
    byKode[tx.kode].amount += tx.amount;
    byKode[tx.kode].qty += tx.qty;
  }
  const list = Object.values(byKode);
  return {
    bulan: `${monthMention.month}/${monthMention.year}`,
    byAmount: [...list].sort((a, b) => b.amount - a.amount).slice(0, 20),
    byQty: [...list].sort((a, b) => b.qty - a.qty).slice(0, 20),
    catatan: list.length ? undefined : `Tidak ada transaksi tercatat untuk bulan ${monthMention.month}/${monthMention.year}.`,
  };
}

// Finds the ONE stock code the message is naming (same matching approach as
// findTransactionMatches' hitKodes) and returns its full sales breakdown: total for the whole
// synced period AND a month-by-month split — "penjualan rinci kode barang by sales dan quantity,
// per bulan atau full 1 tahun" (a real reported request). Distinct from findStockMatches
// (current stock LEVEL) and findTransactionMatches (raw matching rows) — this is specifically the
// aggregated sales history for one code. Only fires when the message also asks about sales/qty,
// not on a plain stock-level lookup like "stok KSFO108 berapa".
function findProductSalesBreakdown(message, allTransactions) {
  if (!allTransactions.length) return null;
  const nMsg = normText(message);
  if (!/penjualan|\bsales\b|terjual|omset|\bqty\b|quantity|\bunit\b/.test(nMsg)) return null;

  const kodeSet = new Set();
  for (const tx of allTransactions) if (tx.kode) kodeSet.add(tx.kode);
  let hitKode = null;
  for (const kw of extractKeywords(message)) {
    const ckw = normCode(kw);
    if (ckw.length < 4) continue;
    for (const k of kodeSet) {
      const ck = normCode(k);
      if (ck.length >= 4 && (ck === ckw || ckw.includes(ck))) { hitKode = k; break; }
    }
    if (hitKode) break;
  }
  if (!hitKode) return null;

  const rows = allTransactions.filter((tx) => tx.kode === hitKode);
  if (!rows.length) return null;
  const monthly = {};
  let totalAmount = 0;
  let totalQty = 0;
  for (const tx of rows) {
    totalAmount += tx.amount;
    totalQty += tx.qty;
    const d = parseFlexibleDate(tx.tanggal);
    const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'unknown';
    if (!monthly[key]) monthly[key] = { bulan: key, amount: 0, qty: 0 };
    monthly[key].amount += tx.amount;
    monthly[key].qty += tx.qty;
  }
  return {
    kode: hitKode,
    totalSepanjangTahun: { amount: totalAmount, qty: totalQty },
    perBulan: Object.values(monthly).sort((a, b) => a.bulan.localeCompare(b.bulan)),
    catatan: 'totalSepanjangTahun = akumulasi seluruh periode data yang tersinkron untuk kode ini. perBulan = breakdown bulanan (format YYYY-MM), pakai ini kalau user minta rincian per bulan, pakai totalSepanjangTahun kalau minta total setahun/keseluruhan.',
  };
}

// "Kabel 1 core" vs "kabel di atas 1 core" (multi-core) — groups cable STOCK items by core count
// (parsed from the product name via extractCoreCount, same helper already used for catalog
// matching) and aggregates their combined sales — a category-level view the individual per-code
// lookups above can't answer on their own.
// Returns ALL distinct core categories mentioned, not just one — "kabel 1 core dan kabel di atas
// 1 core" (a real reported phrasing, comparing two categories in the same question) needs both,
// not just whichever regex happened to match first. De-duped by (type, value) so the "1" inside
// "di atas 1 core" doesn't also get double-counted as a separate "exactly 1 core" mention.
function detectCoreCategoriesFromText(nMsg) {
  const categories = [];
  const aboveMatch = nMsg.match(/(?:di\s*atas|lebih\s*dari|diatas|>)\s*(\d+)\s*core/);
  if (aboveMatch) categories.push({ type: 'above', value: parseInt(aboveMatch[1], 10) });
  else if (/multi.?core|banyak core/.test(nMsg)) categories.push({ type: 'above', value: 1 });
  for (const m of nMsg.matchAll(/\b(\d+)\s*core\b/g)) {
    const value = parseInt(m[1], 10);
    if (!categories.some((c) => c.type === 'exact' && c.value === value)) categories.push({ type: 'exact', value });
  }
  return categories;
}
function findKabelByCoreCategory(message, allStock, allTransactions) {
  if (!allStock.length) return null;
  const nMsg = normText(message);
  if (!/\bkabel\b/.test(nMsg)) return null;
  const categories = detectCoreCategoriesFromText(nMsg);
  if (!categories.length) return null;

  const hasil = categories.map((category) => {
    const matches = allStock.filter((p) => {
      if (!/kabel/i.test(p.nama || '')) return false;
      const coreStr = extractCoreCount(p.nama);
      if (!coreStr) return false;
      const core = parseInt(coreStr, 10);
      return category.type === 'exact' ? core === category.value : core > category.value;
    });
    const kategori = category.type === 'exact' ? `${category.value} core` : `di atas ${category.value} core`;
    if (!matches.length) return { kategori, totalKodeProduk: 0, totalPenjualanGabungan: 0, totalQtyGabungan: 0, daftarProduk: [] };

    const kodeSet = new Set(matches.map((p) => p.kode));
    let totalSales = 0;
    let totalQty = 0;
    for (const tx of allTransactions) {
      if (kodeSet.has(tx.kode)) {
        totalSales += tx.amount;
        totalQty += tx.qty;
      }
    }
    return {
      kategori,
      totalKodeProduk: matches.length,
      totalPenjualanGabungan: totalSales,
      totalQtyGabungan: totalQty,
      daftarProduk: matches
        .map((p) => ({ kode: p.kode, nama: p.nama, harga: p.harga, stokTotal: p.stokTotal, stokMKI: p.stokMKI, stokCFN: p.stokCFN }))
        .slice(0, 40),
    };
  });

  return {
    kategoriDibandingkan: hasil,
    catatan: 'Kategori ditentukan dari jumlah core di nama produk. Tiap entri di "kategoriDibandingkan" adalah GABUNGAN dari semua kode produk kabel yang cocok kategori itu (sepanjang periode data yang tersinkron), bukan per kode terpisah — kalau user cuma tanya satu kategori, cukup pakai entri pertama. "totalKodeProduk": 0 berarti tidak ada produk yang cocok kategori itu.',
  };
}

// The cumulative-2026 topProducts cached in KV only has {kode, amount, qty, ...} — no product
// name, which made a "produk terlaris" answer show bare SKUs like "KSFO028" with nothing readable
// attached. Joins in "nama" from the stock list at request time (cheap, no KV/sync change needed).
function enrichTopProdukWithNama(topProducts, allStock) {
  const namaByKode = {};
  for (const p of allStock) if (p.kode) namaByKode[p.kode] = p.nama;
  const addNama = (arr) => arr.map((x) => ({ ...x, nama: namaByKode[x.kode] || null }));
  return { byAmount: addNama(topProducts.byAmount), byQty: addNama(topProducts.byQty) };
}

// Shared superlative-detection patterns — used everywhere a question asks for a ranking/extreme
// (personnel, product, piutang, or future topics), so every ranking-style question is understood
// the same way instead of each retrieval function maintaining its own partial word list that
// drifts out of sync. A real reported gap: "siapa kinerja paling tinggi?"/"paling bawah?"/"paling
// rendah?" matched nothing before, because only the terXXX contraction ("tertinggi") was listed,
// not the "paling <kata>" phrasing Indonesian speakers use just as often — same gap then found
// separately in findTopPiutangCustomers (only had "tertinggi/terbesar/paling besar/paling banyak",
// missing "paling tinggi").
const SUPERLATIVE_HIGH =
  'terbanyak|terbesar|tertinggi|teratas|terbaik|terlama|tercepat|paling\\s+(tinggi|atas|banyak|besar|bagus|laris|laku|rajin|lama|cepat|top)';
const SUPERLATIVE_LOW =
  'tersedikit|terkecil|terendah|terbawah|terburuk|paling\\s+(rendah|bawah|sedikit|kecil|jelek|buruk)';
const SUPERLATIVE_ANY = `${SUPERLATIVE_HIGH}|${SUPERLATIVE_LOW}`;

const MONTHS = {
  januari: 1, jan: 1, februari: 2, feb: 2, maret: 3, mar: 3, april: 4, apr: 4, mei: 5,
  juni: 6, jun: 6, juli: 7, jul: 7, agustus: 8, agu: 8, ags: 8, september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, november: 11, nov: 11, desember: 12, des: 12,
};

// Cloudflare Workers run entirely in UTC — every "what is today/this month" computation in this
// file used to call new Date() directly, which is several hours off from Makassar's real calendar
// day around midnight (WITA = UTC+8, no DST). This fakes WITA wall-clock time by shifting the
// epoch, so ordinary getFullYear()/getMonth()/getDate() on the result read as Makassar local time
// instead of raw UTC. Use this everywhere "now" means "now in Makassar", not new Date() directly.
function nowMakassar() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

const HARI_NAMA_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', "Jum'at", 'Sabtu'];
const BULAN_NAMA_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

// "Sekarang jam berapa?" — previously MIRA had no notion of the current CLOCK time at all (only
// date math via nowMakassar() above). Reuses the same faked-WITA epoch, so this is effectively
// free to compute — attached as always-on context (not query-gated) since it's a handful of
// characters, negligible next to the rest of the prompt.
function waktuMakassarSekarang() {
  const d = nowMakassar();
  const jam = String(d.getHours()).padStart(2, '0');
  const menit = String(d.getMinutes()).padStart(2, '0');
  return `${HARI_NAMA_ID[d.getDay()]}, ${d.getDate()} ${BULAN_NAMA_ID[d.getMonth()]} ${d.getFullYear()} pukul ${jam}:${menit} WITA`;
}

// "Sales hari ini?", "siapa yang belanja kemarin?", "3 hari lalu gimana?" — a real reported gap:
// only exact dates ("13 Juli 2026") were recognized, relative day words matched nothing at all.
// Mirrors the phrasing resolveAttendanceDate already recognized for KPI/absensi questions, plus
// "N hari (yang) lalu" which that one didn't have either.
function extractRelativeDateMention(message) {
  const t = normText(message);
  const now = nowMakassar();
  const dayOffset = (n) => {
    const d = new Date(now.getTime() - n * 86400000);
    return { day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear() };
  };
  const nHariLalu = t.match(/(\d+)\s*hari\s*(yang\s*)?lalu/);
  if (nHariLalu) return dayOffset(parseInt(nHariLalu[1], 10));
  if (/\bkemarin\s*lusa\b/.test(t)) return dayOffset(2);
  if (/\bkemarin\b/.test(t)) return dayOffset(1);
  if (/\bhari\s*ini\b|\bsekarang\b|\bskrg\b|\bhari\s*ni\b/.test(t)) return dayOffset(0);
  return null;
}

// Combines exact-date and relative-date recognition — use this instead of extractDateMention
// alone anywhere a plain "kapan/tanggal" question could also be phrased relatively.
function extractAnyDateMention(message) {
  return extractDateMention(message) || extractRelativeDateMention(message);
}

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
    const year = m[3] ? parseInt(m[3], 10) : nowMakassar().getFullYear();
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
    const year = m[4] ? parseInt(m[4], 10) : nowMakassar().getFullYear();
    return { startDay: Math.min(d1, d2), endDay: Math.max(d1, d2), month, year };
  }
  return null;
}

// Bare MONTH mention with no specific day ("bulan Juli", "Juli 2026", "bulan ini", "bulan lalu") —
// used for "produk terlaris bulan X" style questions where a whole month is wanted, not one date/
// range. Deliberately only matches "bulan <nama>" or "<nama> <tahun>" phrasing (not a bare month
// name floating alone in the sentence) to avoid false positives on unrelated words.
function extractMonthMention(message) {
  const t = normText(message);
  if (/\bbulan ini\b/.test(t)) {
    const now = nowMakassar();
    return { month: now.getMonth() + 1, year: now.getFullYear() };
  }
  if (/\bbulan lalu\b/.test(t)) {
    const now = nowMakassar();
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { month: d.getMonth() + 1, year: d.getFullYear() };
  }
  for (const m of t.matchAll(/\b([a-z]+)\s+(\d{4})\b/g)) {
    const month = MONTHS[m[1]];
    if (month) return { month, year: parseInt(m[2], 10) };
  }
  for (const m of t.matchAll(/\bbulan\s+([a-z]+)\b/g)) {
    const month = MONTHS[m[1]];
    if (month) return { month, year: nowMakassar().getFullYear() };
  }
  // Bare month name with no "bulan"/year prefix (mis. "siapa karyawan terbaik Juli") — last
  // resort, checked after every more specific pattern above already failed.
  for (const m of t.matchAll(/\b([a-z]+)\b/g)) {
    const month = MONTHS[m[1]];
    if (month) return { month, year: nowMakassar().getFullYear() };
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
// Returns how many of the QUERY's significant words this customer name accounts for (0 = no
// match at all). A real reported bug: querying the exact full name "MUS MULIADI" also matched
// the totally different, unrelated customer "MULIADI" (a strict single-word substring of the
// query) via the single-word-exact rule below, and since callers collect EVERY match for
// disambiguation, this turned an exact, unambiguous query into a false "which one did you mean?"
// prompt. Returning a coverage COUNT (not just true/false) lets callers keep only the
// highest-coverage match(es) — "MUS MULIADI" (covers both query words) beats "MULIADI" (covers
// only one) — and only treat it as genuinely ambiguous when multiple names tie at the top score.
function customerNameMatchCoverage(msgWords, customerName) {
  const nameWords = nameWordsOf(customerName).filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w));
  if (!nameWords.length) return 0;
  const candidateWords = msgWords.filter((w) => !STOPWORDS.has(w) && !QUERY_NOISE_WORDS.has(w));
  // Single-word customer names (e.g. "MASRI") are especially vulnerable to false positives — one
  // word is the WHOLE name, so a single lucky edit-distance hit already clears the 70% threshold.
  // An ordinary, extremely common Indonesian word ("saja") can coincidentally land within that
  // tolerance of a short name and hijack a completely unrelated question — confirmed live: "siapa
  // SAJA customer..." matched customer "MASRI". Not a word we can just add to a stoplist one at a
  // time (any short word could collide with some short name) — require an EXACT match instead,
  // multi-word names keep the typo tolerance since one wrong word alone won't clear 70% on those.
  if (nameWords.length === 1) return candidateWords.includes(nameWords[0]) ? 1 : 0;

  const wordsMatch = (mw, nw) => mw === nw || (Math.abs(mw.length - nw.length) <= 2 && levenshtein(mw, nw) <= (nw.length <= 4 ? 1 : 2));
  const queryCoverage = () => candidateWords.filter((mw) => nameWords.some((nw) => wordsMatch(mw, nw))).length;

  // Rule A: most of the STORED name's words appear in the message — handles a full/near-full name
  // mentioned inside a longer question (e.g. "kapan Afif Anshary Arbi terakhir belanja").
  const nameHits = nameWords.filter((nw) => candidateWords.some((mw) => wordsMatch(mw, nw))).length;
  if (nameHits / nameWords.length >= 0.7) return queryCoverage();

  // Rule B: user typed a genuinely SHORTENED name (e.g. "Afif Anshary" for stored customer "AFIF
  // ANSHARY ARBI") — Rule A alone rejects this because 2/3 stored words = 67% < 70%. Instead check
  // the OTHER direction: every significant word the user actually typed matches some word in the
  // stored name, even though the stored name has extra words (middle/last name) the user omitted.
  // Requires >=2 query words (single-word case is handled separately above) so one coincidental
  // word match can't hijack an unrelated question the way the single-word guard above prevents.
  if (candidateWords.length >= 2) {
    const queryHits = queryCoverage();
    if (queryHits === candidateWords.length) return queryHits;
  }

  // Rule C: a genuinely INCOMPLETE name — user typed just ONE word of a multi-word customer name
  // (mis. "Fatum" alone for "FATUM BACHMID"). Gated to words >=5 chars so it can't be triggered by
  // short, common words (the same false-positive class Rule single-word-exact above exists to
  // avoid) — ambiguity (several customers sharing that word) is intentionally NOT resolved here;
  // callers keep only the max-coverage match(es), so a fuller match elsewhere always wins.
  if (nameWords.some((nw) => nw.length >= 5 && candidateWords.includes(nw))) return 1;

  return 0;
}

function customerNameFuzzyMatch(msgWords, customerName) {
  return customerNameMatchCoverage(msgWords, customerName) > 0;
}

// Filters customerNames down to only the names tied for the HIGHEST match coverage against the
// query — use this (not a plain customerNameFuzzyMatch filter) wherever multiple matches trigger
// a disambiguation prompt, so an exact/fuller match always wins over an unrelated name that only
// happens to share one word with it.
function bestCustomerNameMatches(msgWords, customerNames, rawMessage) {
  const nText = normText(rawMessage || msgWords.join(' '));
  let scored = customerNames
    .map((c) => ({ c, score: customerNameMatchCoverage(msgWords, c) }))
    .filter((x) => x.score > 0);
  // Explicit rejection ("Mus Muliadi BUKAN Mus Mulyadi") hard-excludes the negated name even
  // though its words still literally appear in the message — a real reported follow-up case
  // where, after MIRA asked the user to pick between two similar names, the REJECTED name kept
  // tying for the top score since coverage-scoring alone has no concept of negation.
  scored = scored.filter((x) => {
    const nameWords = nameWordsOf(x.c).filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w));
    if (!nameWords.length) return true;
    return !new RegExp(`(bukan|tidak|salah)\\s+${nameWords.join('\\s+')}`, 'i').test(nText);
  });
  if (!scored.length) return [];
  const maxScore = Math.max(...scored.map((x) => x.score));
  return scored.filter((x) => x.score === maxScore).map((x) => x.c);
}

// Matches transactions by (in priority order): exact date mention, product code mention (for
// "siapa pembeli terakhir KODE", "kapan KODE terakhir keluar"), or customer name (fuzzy, handles
// partial names). Results are sorted newest-first so "terakhir/last" questions read the top row.
// Invoice numbers as written in the sheets take several shapes: "INV/MKS/2026/I/001",
// "INV/MKS/2026/I/F-141", "INV-CFN/2026/VI/027", "R-MKS/2026/I/001" (retur), and at least one
// real row with a doubled slash ("INV/MKS/2026/VII//033"). Comparing on alphanumerics only makes
// all of that punctuation irrelevant, which is also exactly what lets a PARTIAL query work:
// "CFN/2026/VII/010" -> "CFN2026VII010" is a substring of "INVCFN2026VII010".
function normInvoiceNo(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// "INV-CFN/2026/VII/010" / "CFN/2026/VII/010" / "F-141" — full picture for ONE invoice: what was
// bought (every product line), and whether it's been paid off. Deliberately returns an explicit
// "ditemukan: false" instead of null when a genuine invoice-looking query matches nothing, because
// a null field is what repeatedly led Gemini to invent a plausible answer earlier this session.
function findInvoiceDetail(message, allTransactions, paymentDetail, piutangDetail, allStock) {
  if (!allTransactions || !allTransactions.length) return null;
  const nMsg = normText(message);
  // Gate: either the message talks about invoices, or it carries a token punctuated like one.
  if (!/\binvoice\b|\bfaktur\b|\bnota\b|\binv\b|\//.test(nMsg)) return null;

  const invoiceSet = new Set();
  for (const t of allTransactions) if (t.invoice) invoiceSet.add(t.invoice);
  for (const p of paymentDetail || []) if (p.noFaktur) invoiceSet.add(p.noFaktur);
  for (const p of piutangDetail || []) if (p.noFaktur) invoiceSet.add(p.noFaktur);

  // A query needs >=6 alphanumerics AND a digit before it's allowed to match, so ordinary words
  // ("invoice", "faktur") and bare fragments ("010") can't sweep in half the ledger.
  const queries = String(message)
    .split(/\s+/)
    .map((t) => t.replace(/[.,;:?!]+$/, ''))
    .map((raw) => ({ raw, q: normInvoiceNo(raw) }))
    .filter((x) => x.q.length >= 6 && /\d/.test(x.q));
  if (!queries.length) return null;

  // Every MKI invoice number is actually written with "MKS" (Makassar), never "MKI" — confirmed
  // against the live data: 2415 invoices contain MKS, zero contain MKI. But the team naturally
  // thinks and types "MKI" because that's the company name, so a literal search would find nothing.
  // Treat the two as interchangeable in the query.
  const queryVariants = (q) => {
    const out = new Set([q]);
    if (q.includes('MKI')) out.add(q.replace(/MKI/g, 'MKS'));
    if (q.includes('MKS')) out.add(q.replace(/MKS/g, 'MKI'));
    return [...out];
  };

  let query = null;
  let matches = [];
  for (const { raw, q } of queries) {
    const vars = queryVariants(q);
    // A query typed with a trailing separator ("MKS/2026/VI/F-") is a prefix search for one
    // NUMBERED series, so what follows must be a digit. Without this, stripping punctuation makes
    // "F-" and "FP-" indistinguishable and an "F-" search silently swallows the FP- invoices too.
    const seriesPrefix = /[-/]$/.test(raw);
    const hit = [...invoiceSet].filter((inv) => {
      const n = normInvoiceNo(inv);
      return vars.some((v) => {
        const idx = n.indexOf(v);
        if (idx < 0) return false;
        if (!seriesPrefix) return true;
        const next = n[idx + v.length];
        return next !== undefined && /\d/.test(next);
      });
    });
    if (hit.length) { query = q; matches = hit; break; }
    if (!query) query = q; // remember the first plausible query for the not-found message
  }

  if (!matches.length) {
    return {
      ditemukan: false,
      dicari: query,
      catatan: 'Nomor invoice ini TIDAK ADA di data transaksi, pembayaran, maupun piutang. Katakan terus terang tidak ditemukan — JANGAN mengarang isi/nilai/customer invoice ini, dan JANGAN menyodorkan invoice lain yang mirip seolah itu yang dimaksud.',
    };
  }
  // Several matches is usually INTENTIONAL, not ambiguity: searching a prefix like
  // "MKS/2026/VI/F-" means "show me all the F- invoices from June" (147 of them, in real data).
  // So return a genuinely useful summary+list rather than only asking which one they meant.
  if (matches.length > 1) {
    const ringkas = matches
      .map((inv) => {
        const lines = allTransactions.filter((t) => t.invoice === inv);
        const sisa = (piutangDetail || []).filter((p) => p.noFaktur === inv).reduce((s, p) => s + p.nilaiSisa, 0);
        const head = lines[0] || {};
        return {
          noInvoice: inv,
          tanggal: head.tanggal || null,
          customer: head.customer || null,
          totalNilai: lines.reduce((s, l) => s + l.amount, 0),
          statusPelunasan: sisa > 0 ? 'BELUM LUNAS' : 'LUNAS',
          sisaPiutang: sisa,
        };
      })
      .sort((a, b) => {
        const da = parseFlexibleDate(a.tanggal);
        const db = parseFlexibleDate(b.tanggal);
        return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
      });
    const BATAS = 25;
    return {
      ditemukan: true,
      modeDaftar: true,
      dicari: query,
      jumlahCocok: matches.length,
      totalNilaiSemua: ringkas.reduce((s, x) => s + x.totalNilai, 0),
      totalSisaPiutangSemua: ringkas.reduce((s, x) => s + x.sisaPiutang, 0),
      daftar: ringkas.slice(0, BATAS),
      catatan:
        `Potongan nomor "${query}" cocok ke ${matches.length} invoice (urut TERBARU dulu).` +
        (matches.length > BATAS ? ` Ditampilkan ${BATAS} teratas saja — sebutkan bahwa masih ada ${matches.length - BATAS} lainnya.` : '') +
        ' Kalau user tampaknya mencari SATU invoice tertentu, tawarkan kandidatnya dan minta pertegas; kalau memang mencari kelompok invoice (mis. semua "F-" bulan itu), langsung sajikan daftarnya. JANGAN menjumlahkan ulang manual, "totalNilaiSemua"/"totalSisaPiutangSemua" sudah dihitung.',
    };
  }

  const noInvoice = matches[0];
  const lines = allTransactions.filter((t) => t.invoice === noInvoice);
  const namaByKode = {};
  for (const p of allStock || []) if (p.kode) namaByKode[p.kode] = p.nama;

  const totalNilai = lines.reduce((s, l) => s + l.amount, 0);
  const pays = (paymentDetail || []).filter((p) => p.noFaktur === noInvoice);
  const totalDibayar = pays.reduce((s, p) => s + p.amount, 0);
  const sisaRows = (piutangDetail || []).filter((p) => p.noFaktur === noInvoice);
  const sisaPiutang = sisaRows.reduce((s, p) => s + p.nilaiSisa, 0);
  const head = lines[0] || {};

  const catatan = [];
  if (!lines.length) catatan.push('Nomor ini tidak ada di data transaksi (hanya muncul di data pembayaran/piutang) — jadi rincian barangnya memang tidak tersedia, jangan dikarang.');
  if (sisaRows.length) catatan.push(`BELUM LUNAS — masih ada sisa piutang ${sisaPiutang}.`);
  else if (pays.length) catatan.push('LUNAS — tidak ada sisa piutang tercatat untuk invoice ini.');
  else catatan.push('Tidak ada catatan pembayaran DAN tidak ada sisa piutang untuk invoice ini — sampaikan apa adanya, jangan menyimpulkan sendiri sudah/belum dibayar.');
  // Real data quirk: at least one invoice has payments totalling MORE than the invoice value.
  // Surface it rather than let Gemini quietly "fix" the arithmetic into something tidier.
  if (pays.length && lines.length && totalDibayar !== totalNilai) {
    catatan.push(`Catatan: total pembayaran (${totalDibayar}) TIDAK sama dengan nilai transaksi (${totalNilai}) — sampaikan apa adanya sebagai fakta data, jangan diperbaiki/dibulatkan sendiri.`);
  }

  return {
    ditemukan: true,
    noInvoice,
    tanggal: head.tanggal || null,
    customer: head.customer || (pays[0] && pays[0].customer) || (sisaRows[0] && sisaRows[0].customer) || null,
    company: head.company || (pays[0] && pays[0].company) || null,
    lokasi: head.lokasi || null,
    ekspedisi: head.ekspedisi || null,
    statusKirim: head.status || null,
    stage: head.stage || null,
    tanggalTerkirim: head.tglTerkirim || null,
    isRetur: !!head.isRetur,
    barang: lines.map((l) => ({ kode: l.kode, nama: namaByKode[l.kode] || null, qty: l.qty, amount: l.amount })),
    jumlahBarisBarang: lines.length,
    totalQty: lines.reduce((s, l) => s + l.qty, 0),
    totalNilaiTransaksi: totalNilai,
    statusPelunasan: sisaRows.length ? 'BELUM LUNAS' : (pays.length ? 'LUNAS' : 'TIDAK ADA DATA PEMBAYARAN'),
    sisaPiutang,
    totalDibayar,
    jumlahPembayaran: pays.length,
    riwayatPembayaran: pays.map((p) => ({ tanggal: p.tanggal, jumlah: p.amount })),
    catatan: catatan.join(' '),
  };
}

function findTransactionMatches(message, allTransactions) {
  if (!allTransactions.length) return { items: [], note: '' };
  const rangeMention = extractDateRangeMention(message);
  const dateMention = !rangeMention ? extractAnyDateMention(message) : null;

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

  // Pre-computed totals for a date/range-filtered result — a real reported bug: asking Gemini to
  // manually sum "amount" across the raw matched rows itself (mis. "sales kemarin?") produced a
  // wrong total even for just 19 rows, the same class of arithmetic-reliability issue every other
  // aggregate in this file is already pre-computed to avoid. "totalAmount" mirrors how the monthly
  // "performa.sales" is computed (every row summed, retur's negative amount nets out naturally),
  // "jumlahInvoiceUnik" excludes retur per the invoice-uniqueness rule used everywhere else.
  const ringkasanTanggal = (rangeMention || dateMention)
    ? {
        // Explicit, grounded date label — WAJIB dibaca apa adanya, jangan Gemini hitung/tebak
        // sendiri tanggalnya (itu sumber salah label "kemarin" yang sebenarnya ditemukan saat
        // testing: total angkanya benar tapi label tanggalnya di teks jawaban meleset/ditebak).
        periode: rangeMention
          ? `${rangeMention.startDay}-${rangeMention.endDay}/${rangeMention.month}/${rangeMention.year}`
          : `${dateMention.day}/${dateMention.month}/${dateMention.year}`,
        totalAmount: matched.reduce((s, tx) => s + tx.amount, 0),
        totalQty: matched.reduce((s, tx) => s + tx.qty, 0),
        jumlahBarisTransaksi: matched.length,
        jumlahInvoiceUnik: new Set(matched.filter((tx) => !tx.isRetur).map((tx) => tx.invoice)).size,
      }
    : null;

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
    // Collect EVERY matching customer, not just the first — a real reported case: "ARIF" silently
    // matched only one of three real customers (ARIF / ARIF RACHMAWAN / ARIF MAKASSAR) with no
    // indication the others existed. Multiple distinct hits means the name is genuinely ambiguous.
    const hitCustomers = bestCustomerNameMatches(msgWords, [...customerSet].filter((c) => c.length >= 4), message);
    if (hitCustomers.length > 1) {
      matched = [];
      note = `Nama ini cocok ke BEBERAPA customer berbeda yang benar-benar ada di data: ${hitCustomers.join(', ')} — JANGAN asal pilih salah satu, tanya balik ke user customer mana persisnya yang dimaksud (sebutkan semua nama kandidat ini).`;
    } else {
      const hitCustomer = hitCustomers[0] || null;
      matched = hitCustomer ? allTransactions.filter((tx) => tx.customer === hitCustomer).sort(byDateDesc) : [];
      if (hitCustomer) {
        note = `Transaksi customer "${hitCustomer}": ${matched.length} baris, diurutkan dari yang PALING BARU (baris pertama = transaksi terakhir).`;
      }
    }
  }

  if (matched.length > 150) {
    note += ` (menampilkan 150 TERBARU dari ${matched.length} baris — sisanya lebih lama)`;
    matched = matched.slice(0, 150);
  }
  return { items: matched, note, ringkasanTanggal };
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
  const dateMention = !rangeMention ? extractAnyDateMention(message) : null;
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
  const invoiceUnikRetur = new Set(matched.map((tx) => tx.invoice).filter(Boolean)).size;
  const capped = matched.slice(0, 100);
  return {
    // jumlahInvoiceUnikRetur = jumlah invoice retur BERBEDA (pakai ini untuk "berapa banyak
    // retur") — beda dari jumlahBarisRetur yang menghitung tiap baris produk (satu invoice retur
    // bisa punya beberapa baris kalau returnya lebih dari satu kode barang sekaligus).
    jumlahInvoiceUnikRetur: invoiceUnikRetur,
    jumlahBarisRetur: total,
    items: capped,
    catatan: `Retur dikenali dari nomor invoice berawalan "R-"/"R/" atau nilai transaksi negatif. Retur TIDAK ikut dihitung di angka invoice/transaksi normal manapun (per bulan, per wilayah, delivery, dst) — ini satu-satunya jalur untuk pertanyaan retur secara khusus.${total > 100 ? ` Ditampilkan 100 TERBARU dari ${total}.` : ''}`,
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
  // Only SUPERLATIVE_HIGH (not the full SUPERLATIVE_ANY/_LOW) — this function always returns the
  // top10 HIGHEST, there's no ascending variant, so matching "terendah"/"paling rendah" here would
  // return the wrong (highest, mislabeled as lowest) data instead of honestly saying unavailable.
  const wantsTop = new RegExp(`piutang.*(${SUPERLATIVE_HIGH})|(${SUPERLATIVE_HIGH}).*piutang`).test(nMsg);
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
// Legacy 2015-2025 receivables lookup (see PIUTANG_LAMPAU above). Fires on explicitly-historical
// wording, on any mention of a year in that range, on a named customer from that list, OR on a
// bare "piutang terlama"-type question — that last case matters most: without it, "piutang paling
// lama" would only ever see AR 2026 and answer with a ~200-day-old invoice while genuinely
// decade-old debt sits in this list unmentioned.
function findPiutangLampau(message) {
  const nMsg = normText(message);
  if (!/piutang|tagihan|tunggak|menunggak|utang|hutang/.test(nMsg)) return null;

  const mentionsHistoris = /lampau|lama sekali|masa lalu|tahun lalu|bertahun|legacy|warisan|lawas|tahun-tahun|sebelum 2026|2015|2016|2017|2018|2019|2020|2021|2022|2023|2024|2025/.test(nMsg);
  const wantsOldest = new RegExp(SUPERLATIVE_HIGH).test(nMsg) || /terlama|paling lama|tertua|paling tua|paling awal/.test(nMsg);
  const msgWords = nameWordsOf(message);
  const namedHit = PIUTANG_LAMPAU.filter((e) => e.nama.length >= 4 && customerNameFuzzyMatch(msgWords, e.nama));
  if (!mentionsHistoris && !wantsOldest && !namedHit.length) return null;

  // A specific year mentioned narrows the list to just that year's outstanding entries.
  const yearMatch = nMsg.match(/\b(20(?:1[5-9]|2[0-5]))\b/);
  if (yearMatch) {
    const tahun = Number(yearMatch[1]);
    const items = PIUTANG_LAMPAU.filter((e) => e.perTahun[tahun])
      .map((e) => ({ kodePelanggan: e.kodePelanggan, nama: e.nama, nilai: e.perTahun[tahun] }))
      .sort((a, b) => b.nilai - a.nilai);
    return {
      mode: 'perTahun',
      tahun,
      jumlahPelanggan: items.length,
      totalNilai: items.reduce((s, x) => s + x.nilai, 0),
      daftar: items,
      catatan: `Piutang lampau tahun ${tahun} (arsip 2015-2025, TERPISAH dari piutang AR 2026 yang berjalan — JANGAN dijumlahkan dengan angka piutang 2026).`,
    };
  }

  if (namedHit.length) {
    return {
      mode: 'perPelanggan',
      daftar: namedHit.map((e) => ({ kodePelanggan: e.kodePelanggan, nama: e.nama, perTahun: e.perTahun, totalPiutang: e.totalPiutang, tahunTerlama: e.tahunTerlama })),
      catatan: 'Piutang LAMPAU (arsip 2015-2025) untuk pelanggan ini — TERPISAH dari piutang AR 2026 berjalan, jangan dijumlahkan dengan angka 2026.',
    };
  }

  // Default: the whole archive, oldest-year first (what "piutang terlama" actually needs).
  const sorted = [...PIUTANG_LAMPAU].sort((a, b) => a.tahunTerlama - b.tahunTerlama || b.totalPiutang - a.totalPiutang);
  const byYear = {};
  for (const e of PIUTANG_LAMPAU) {
    for (const [th, val] of Object.entries(e.perTahun)) byYear[th] = (byYear[th] || 0) + val;
  }
  return {
    mode: 'ringkasan',
    rentangTahun: `${PIUTANG_LAMPAU_TAHUN[0]}-${PIUTANG_LAMPAU_TAHUN[PIUTANG_LAMPAU_TAHUN.length - 1]}`,
    tahunPalingLama: sorted[0].tahunTerlama,
    totalSeluruhnya: PIUTANG_LAMPAU.reduce((s, e) => s + e.totalPiutang, 0),
    jumlahPelanggan: PIUTANG_LAMPAU.length,
    totalPerTahun: byYear,
    daftarUrutTerlama: sorted.map((e) => ({ kodePelanggan: e.kodePelanggan, nama: e.nama, tahunTerlama: e.tahunTerlama, perTahun: e.perTahun, totalPiutang: e.totalPiutang })),
    catatan: 'Arsip piutang lampau 2015-2025, sudah diurutkan dari TAHUN PALING LAMA duluan. Ini data historis STATIS dan TERPISAH dari piutang AR 2026 yang berjalan — JANGAN dijumlahkan dengan total piutang 2026, dan JANGAN sebut ini sebagai piutang tahun berjalan.',
  };
}

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
  if (!kategori) {
    // "Piutang paling lama menunggak"/"terlama" or "paling baru menunggak"/"terdekat jatuh
    // tempo" (superlative wording, no explicit number) — sort ALL invoices by agingHari itself
    // instead of nilaiSisa, since that's the axis these questions are actually about.
    const wantsOldest = new RegExp(SUPERLATIVE_HIGH).test(nMsg) && /piutang|menunggak|tunggak|umur|aging|jatuh\s*tempo/.test(nMsg);
    // "Piutang terbaru" — NOT in the shared SUPERLATIVE_LOW/HIGH constants on purpose (those are
    // reused by other functions like KPI/product ranking, where "terbaru" means something
    // completely different — most recent PERIOD, not a ranking direction — so adding it there
    // would misfire elsewhere). Recognized locally here only, since "piutang terbaru" unambiguously
    // means "smallest agingHari" in this one context. A real reported bug: without this, the
    // question matched neither wantsOldest nor wantsNewest, returned null with NO real data at
    // all, and Gemini fabricated an entire plausible-looking but completely fictional customer/
    // invoice/date/amount instead of saying it didn't know.
    const wantsNewest = !wantsOldest && (new RegExp(SUPERLATIVE_LOW).test(nMsg) || /terbaru|terakhir|terkini/.test(nMsg)) && /piutang|menunggak|tunggak|umur|aging|jatuh\s*tempo/.test(nMsg);
    if (!wantsOldest && !wantsNewest) return null;
    const items = [...piutangDetail].sort((a, b) => (wantsOldest ? b.agingHari - a.agingHari : a.agingHari - b.agingHari));
    return {
      kategori: wantsOldest ? 'Paling lama menunggak (semua umur)' : 'Paling dekat jatuh tempo/baru menunggak (semua umur)',
      jumlahInvoice: items.length,
      totalNilai: items.reduce((sum, p) => sum + p.nilaiSisa, 0),
      daftar: items.slice(0, 60),
      catatan: `Diurutkan dari umur piutang (hari) ${wantsOldest ? 'TERBESAR (paling lama menunggak duluan)' : 'TERKECIL (paling baru/dekat lunas duluan)'}, BUKAN urut nilai rupiah. ${items.length > 60 ? `Ditampilkan 60 dari ${items.length} invoice teratas urutan ini.` : `Semua ${items.length} invoice ditampilkan.`}`,
    };
  }
  const items = [...piutangDetail.filter((p) => p.kategori === kategori)].sort((a, b) => b.nilaiSisa - a.nilaiSisa);
  return {
    kategori,
    jumlahInvoice: items.length,
    totalNilai: items.reduce((sum, p) => sum + p.nilaiSisa, 0),
    daftar: items.slice(0, 60),
    catatan: items.length > 60 ? `Ditampilkan 60 dari ${items.length} invoice (urut nilai terbesar).` : `Semua ${items.length} invoice ditampilkan.`,
  };
}

// The AR2026 sheet DOES carry a real Company column, and it is authoritative — the invoice-number
// naming convention ("INV-CFN/..." = CFN) is only a convention and does get broken in practice.
// Confirmed against the live sheet: INV-CFN/2026/VI/078 (UMAR BATARA, Rp1,475,000) is numbered CFN
// but its Company column says MKI, so guessing from the number put that amount on the wrong side
// and made both company totals disagree with the sheet's own MKI/CFN summary by exactly that much.
// Reads the real field first; the pattern stays only as a fallback for a blank cell (and for rows
// cached before this field existed).
function piutangCompanyOf(p) {
  const asli = String((p && p.company) || '').trim().toUpperCase();
  if (asli === 'MKI' || asli === 'CFN') return asli;
  const noFaktur = typeof p === 'string' ? p : (p && p.noFaktur) || '';
  return /CFN/i.test(noFaktur) ? 'CFN' : 'MKI';
}
function findPiutangByCompany(message, piutangDetail) {
  if (!piutangDetail || !piutangDetail.length) return null;
  const nMsg = normText(message);
  const company = /\bmki\b/.test(nMsg) ? 'MKI' : /\bcfn\b/.test(nMsg) ? 'CFN' : null;
  if (!company) return null;
  const items = [...piutangDetail.filter((p) => piutangCompanyOf(p) === company)].sort((a, b) => b.nilaiSisa - a.nilaiSisa);
  // Aging breakdown SCOPED to this company — a real reported bug: without this, a company-
  // specific question ("piutang CFN") got its aging-category numbers (>60/45-60/30-45/0-30 hari)
  // from the GENERAL "piutang.byKategori" field instead (all companies combined), while the
  // invoice count/total shown alongside was still correctly CFN-only — an inconsistent, mixed-up
  // answer. Now every number in one answer can come from this SAME company-filtered dataset.
  const byKategoriMap = {};
  for (const p of items) {
    if (!byKategoriMap[p.kategori]) byKategoriMap[p.kategori] = { kategori: p.kategori, jumlahInvoice: 0, totalNilai: 0 };
    byKategoriMap[p.kategori].jumlahInvoice += 1;
    byKategoriMap[p.kategori].totalNilai += p.nilaiSisa;
  }
  return {
    company,
    jumlahInvoice: items.length,
    totalPiutang: items.reduce((sum, p) => sum + p.nilaiSisa, 0),
    byKategoriUmur: Object.values(byKategoriMap),
    // Full per-invoice list (customer, noFaktur, nilaiSisa, tanggal, kategori) so "list piutang
    // MKI/CFN" can be answered with actual names, not just the aggregate total above.
    daftar: items.slice(0, 60),
    catatan: `Company "${company}" diambil dari kolom Company ASLI di data piutang (bukan tebakan dari nomor faktur), jadi boleh dipakai dengan percaya diri — catatan: ada invoice yang nomornya berawalan CFN tapi company aslinya MKI, jadi JANGAN menyimpulkan company dari nomor fakturnya sendiri. "totalPiutang" ini adalah SISA SALDO piutang (yang masih harus ditagih), bukan nilai faktur awal. "byKategoriUmur" SUDAH khusus company ini saja — JANGAN pakai field "piutang.byKategori" yang terpisah (itu gabungan MKI+CFN, beda angka).${items.length > 60 ? ` Ditampilkan 60 dari ${items.length} invoice (urut nilai terbesar).` : ''}`,
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
  const hits = bestCustomerNameMatches(msgWords, [...customerSet].filter((c) => c.length >= 4), message);
  if (!hits.length) return null;
  if (hits.length > 1) {
    return { customerCandidatesAmbiguous: hits, catatan: `Nama ini cocok ke BEBERAPA customer berbeda: ${hits.join(', ')} — tanya balik user mana yang dimaksud, jangan asal pilih satu.` };
  }
  const hit = hits[0];
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
  const hits = bestCustomerNameMatches(msgWords, [...customerSet].filter((c) => c.length >= 4), message);
  if (!hits.length) return null;
  if (hits.length > 1) {
    return { customerCandidatesAmbiguous: hits, catatan: `Nama ini cocok ke BEBERAPA customer berbeda: ${hits.join(', ')} — tanya balik user mana yang dimaksud, jangan asal pilih satu.` };
  }
  const hit = hits[0];

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

// "Siapa piutang terbayar hari ini?"/"pembayaran kemarin apa saja?" — a real reported gap:
// findPaymentsByCustomer above REQUIRES a customer name match and returns null without one, so a
// plain date-based payment question (no customer named) always came back empty. This is the
// date-first counterpart — lists ALL payments on a date/range across every customer, instead of
// one customer's full history. Gated on an explicit payment-topic word so it doesn't fire on a
// plain sales-by-date question (that's findTransactionMatches' job, a different field/topic).
// "Pencapaian 2026"/"pencapaian Agustus" — a real reported gap: MIRA answered sales and revenue
// as two separate follow-up questions instead of one bundled summary for the whole period asked
// about, and gave inconsistent numbers across turns. Reuses the ALREADY precomputed monthly
// aggregates (performance/revenue.monthly) instead of re-summing raw rows, so this is always
// consistent with what "Sales"/"Revenue" questions report separately. No month mentioned →
// defaults to the whole year to date (matches the dashboard's own "Total Sales 2026 (s.d. hari
// ini)" convention) rather than returning nothing.
// "Sales MKI bulan ini", "revenue CFN hari ini", "invoice MKI kemarin" — one company, any period.
// Both source datasets already carry a real "company" field per row, so this is a straight filter
// rather than anything inferred. Piutang is deliberately NOT included: it's a running balance, not
// a flow you can sum over a period, and "piutangPerCompany" already answers it correctly.
function findCompanyPeriodBreakdown(message, allTransactions, revenueDetail) {
  if (!allTransactions || !allTransactions.length) return null;
  const nMsg = normText(message);
  const company = /\bmki\b/.test(nMsg) ? 'MKI' : /\bcfn\b/.test(nMsg) ? 'CFN' : null;
  if (!company) return null;
  // Only for flow measures — a bare "piutang CFN" must stay with piutangPerCompany.
  if (!/\bsales\b|penjualan|jualan|omzet|omset|\brevenue\b|pendapatan|pelunasan|dibayar|\binvoice\b|faktur|transaksi|\bqty\b|kuantitas|unit/.test(nMsg)) return null;

  // Period, most specific first: explicit range, then a single date (incl. "hari ini"/"kemarin"),
  // then a month, then a year, else year-to-date.
  const range = extractDateRangeMention(message);
  const tanggal = !range ? extractAnyDateMention(message) : null;
  const bulan = !range && !tanggal ? extractMonthMention(message) : null;
  const tahunIni = nowMakassar().getFullYear();
  let periode;
  let cocokTanggal;
  if (range) {
    periode = `${range.startDay}-${range.endDay}/${range.month}/${range.year}`;
    cocokTanggal = (d) => d && d.getFullYear() === range.year && d.getMonth() + 1 === range.month && d.getDate() >= range.startDay && d.getDate() <= range.endDay;
  } else if (tanggal) {
    periode = `${tanggal.day}/${tanggal.month}/${tanggal.year}`;
    cocokTanggal = (d) => d && d.getFullYear() === tanggal.year && d.getMonth() + 1 === tanggal.month && d.getDate() === tanggal.day;
  } else if (bulan) {
    periode = `${bulan.month}/${bulan.year} (satu bulan penuh)`;
    cocokTanggal = (d) => d && d.getFullYear() === bulan.year && d.getMonth() + 1 === bulan.month;
  } else {
    periode = `${tahunIni} (sepanjang tahun s.d. hari ini)`;
    cocokTanggal = (d) => d && d.getFullYear() === tahunIni;
  }

  const txRows = allTransactions.filter(
    (t) => (t.company || '').trim().toUpperCase() === company && cocokTanggal(parseFlexibleDate(t.tanggal))
  );
  const revRows = (revenueDetail || []).filter(
    (r) => (r.company || '').trim().toUpperCase() === company && cocokTanggal(parseFlexibleDate(r.tanggal))
  );

  return {
    company,
    periode,
    sales: txRows.reduce((s, t) => s + t.amount, 0),
    invoiceUnik: new Set(txRows.filter((t) => !t.isRetur).map((t) => t.invoice)).size,
    totalQty: txRows.reduce((s, t) => s + t.qty, 0),
    jumlahBarisTransaksi: txRows.length,
    revenue: revRows.reduce((s, r) => s + r.amount, 0),
    jumlahPembayaran: revRows.length,
    catatan:
      `Semua angka SUDAH khusus company ${company} untuk periode "${periode}" dan sudah dijumlahkan — JANGAN dihitung ulang manual, dan JANGAN dicampur dengan angka gabungan MKI+CFN dari field lain. ` +
      '"sales"/"invoiceUnik" dari data penjualan (invoiceUnik sudah exclude retur), "revenue" dari data pelunasan — dua sumber berbeda, wajar kalau angkanya tidak sama. ' +
      'Untuk PIUTANG per company JANGAN pakai field ini, pakai "piutangPerCompany" (piutang itu saldo berjalan, bukan angka periode).',
  };
}

// "Sisa target" — how much is still missing, for all three tracked measures at once (Sales,
// Revenue, Invoice Unik). Scope follows the question: mention a year and it answers year-to-date
// against the full-year target; otherwise it answers for a month (the one named, else the current
// one). Targets come from two different places on purpose — Sales/Revenue share one Rupiah target
// per month from the Sales SUM sheet, while the invoice target is a separate operational figure.
function findSisaTarget(message, yoy, dailyPerfTargets) {
  const nMsg = normText(message);
  const wants = /sisa\s*target|kekurangan\s*target|target.*(kurang|sisa)|(kurang|sisa).*target|berapa lagi.*(target|capai)|kurang berapa/.test(nMsg);
  if (!wants) return null;
  if (!yoy || !Array.isArray(yoy.months) || !yoy.months.length) return null;

  const perf = Array.isArray(dailyPerfTargets) ? dailyPerfTargets : [];
  const hitung = (target, realisasi) => ({
    target: Math.round(target || 0),
    realisasi: Math.round(realisasi || 0),
    sisa: Math.max(0, Math.round((target || 0) - (realisasi || 0))),
    kelebihan: Math.max(0, Math.round((realisasi || 0) - (target || 0))),
    sudahTercapai: (realisasi || 0) >= (target || 0),
    persenTercapai: target ? Math.round(((realisasi || 0) / target) * 1000) / 10 : null,
  });

  const tahunIni = nowMakassar().getFullYear();

  if (/\btahun\b|setahun|tahunan|se-?tahun/.test(nMsg)) {
    // Invoice has no recorded annual target — only a single manual monthly figure — so the yearly
    // one is derived (monthly x 12) and flagged as such rather than presented as if it were
    // recorded somewhere.
    const targetInvoiceBulanan = perf.length ? perf[perf.length - 1].targetInvoice : null;
    const realisasiInvoice = perf.reduce((s, m) => s + (m.invoiceUnik || 0), 0);
    return {
      lingkup: 'tahunan',
      periode: `${tahunIni} (realisasi s.d. hari ini vs target setahun penuh)`,
      sales: hitung(yoy.totalTarget, yoy.totalSales2026),
      revenue: hitung(yoy.totalTarget, yoy.totalRev2026),
      invoiceUnik: targetInvoiceBulanan
        ? { ...hitung(targetInvoiceBulanan * 12, realisasiInvoice), catatanTarget: `Target setahun ini DITURUNKAN dari target bulanan ${targetInvoiceBulanan} invoice x 12 bulan — bukan angka tahunan yang tercatat langsung, sebutkan itu apa adanya.` }
        : null,
      catatan: 'Target Rupiah SATU angka dipakai untuk Sales DAN Revenue (memang begitu di sumbernya, bukan salah baca). Semua "sisa" SUDAH dihitung — jangan hitung ulang manual.',
    };
  }

  // Monthly: the month named in the question, otherwise the current one.
  const mm = extractMonthMention(message);
  const monthIdx = mm ? mm.month - 1 : nowMakassar().getMonth();
  const year = mm ? mm.year : tahunIni;
  const row = yoy.months.find((m) => m.monthIdx === monthIdx);
  const key = `${year}-${String(monthIdx + 1).padStart(2, '0')}`;
  const perfRow = perf.find((m) => m.bulan === key);

  if (!row) return null;
  return {
    lingkup: 'bulanan',
    periode: `${row.label} ${year}`,
    sales: hitung(row.targetSalesRevenue, row.sales2026),
    revenue: hitung(row.targetSalesRevenue, row.rev2026),
    invoiceUnik: perfRow ? hitung(perfRow.targetInvoice, perfRow.invoiceUnik) : null,
    catatan:
      'Target Rupiah SATU angka dipakai untuk Sales DAN Revenue (memang begitu di sumbernya). Semua "sisa" SUDAH dihitung — jangan hitung ulang manual. ' +
      (perfRow ? '' : 'Data invoice untuk bulan ini belum ada, jadi sisa target invoice tidak bisa dihitung — katakan apa adanya, jangan dikarang.'),
  };
}

function findPencapaianRingkasan(message, performance, revenueMonthly, totalSales2026, totalRevenue2026, allTransactions, paymentDetail) {
  const nMsg = normText(message);
  if (!/pencapaian/.test(nMsg)) return null;

  // Specific date/date-range ("pencapaian tanggal 3 Agustus", "pencapaian kemarin") — same
  // bundling requested for month/year, just computed directly from raw rows since there's no
  // precomputed daily aggregate to reuse (mirrors ringkasanTanggalTransaksi/pembayaranPerTanggal's
  // own day-level logic so the numbers stay consistent with what those fields report separately).
  const rangeMention = extractDateRangeMention(message);
  const dateMention = !rangeMention ? extractAnyDateMention(message) : null;
  if (rangeMention || dateMention) {
    const inRange = (d) => {
      if (!d) return false;
      if (rangeMention) {
        return d.getMonth() + 1 === rangeMention.month && d.getFullYear() === rangeMention.year
          && d.getDate() >= rangeMention.startDay && d.getDate() <= rangeMention.endDay;
      }
      return d.getDate() === dateMention.day && d.getMonth() + 1 === dateMention.month && d.getFullYear() === dateMention.year;
    };
    const txs = (allTransactions || []).filter((tx) => inRange(parseFlexibleDate(tx.tanggal)));
    const totalSales = txs.reduce((s, tx) => s + tx.amount, 0);
    const totalInvoiceUnik = new Set(txs.filter((tx) => !tx.isRetur).map((tx) => tx.invoice)).size;
    const pays = (paymentDetail || []).filter((p) => inRange(parseFlexibleDate(p.tanggal)));
    const totalRevenue = pays.reduce((s, p) => s + p.amount, 0);
    return {
      periode: rangeMention
        ? `${rangeMention.startDay}-${rangeMention.endDay}/${rangeMention.month}/${rangeMention.year}`
        : `${dateMention.day}/${dateMention.month}/${dateMention.year}`,
      totalSales,
      totalInvoiceUnik,
      totalRevenue,
      catatan: '"totalSales"/"totalInvoiceUnik" dari data penjualan tanggal/rentang ini (invoice unik, retur dikecualikan), "totalRevenue" dari data pelunasan tanggal/rentang yang sama — JANGAN dihitung ulang manual, sudah dijumlahkan.',
    };
  }

  const monthMention = extractMonthMention(message);
  if (monthMention) {
    const key = `${monthMention.year}-${String(monthMention.month).padStart(2, '0')}`;
    const perf = (performance || []).find((m) => m.bulan === key);
    const rev = (revenueMonthly || []).find((m) => m.bulan === key);
    return {
      periode: key,
      totalSales: perf ? perf.sales : 0,
      totalInvoiceUnik: perf ? perf.transaksi : 0,
      totalRevenue: rev ? rev.revenue : 0,
      catatan: !perf && !rev
        ? 'Tidak ada data tercatat untuk periode ini.'
        : '"totalSales"/"totalInvoiceUnik" dari data penjualan (invoice unik, retur dikecualikan), "totalRevenue" dari data pelunasan — dua sumber berbeda, sudah dijumlahkan untuk periode yang sama, JANGAN dihitung ulang manual.',
    };
  }
  const totalInvoiceUnikYear = (performance || []).reduce((s, m) => s + m.transaksi, 0);
  return {
    periode: `${nowMakassar().getFullYear()} (sepanjang tahun s.d. hari ini)`,
    totalSales: totalSales2026 || 0,
    totalInvoiceUnik: totalInvoiceUnikYear,
    totalRevenue: totalRevenue2026 || 0,
    catatan: '"totalSales"/"totalInvoiceUnik" dari data penjualan sepanjang tahun berjalan, "totalRevenue" dari data pelunasan — JANGAN dihitung ulang manual, sudah dijumlahkan.',
  };
}

function findPaymentsByDate(message, paymentDetail, piutangDetail) {
  if (!paymentDetail || !paymentDetail.length) return null;
  const nMsg = normText(message);
  const wantsPayment = /bayar|lunas|pelunasan|\brevenue\b|pendapatan/.test(nMsg);
  if (!wantsPayment) return null;
  const rangeMention = extractDateRangeMention(message);
  const dateMention = !rangeMention ? extractAnyDateMention(message) : null;
  if (!rangeMention && !dateMention) return null;

  const openInvoices = new Map();
  for (const p of piutangDetail || []) {
    if (p.noFaktur) openInvoices.set(p.noFaktur, p.nilaiSisa);
  }

  const matched = paymentDetail
    .filter((p) => {
      const d = parseFlexibleDate(p.tanggal);
      if (!d) return false;
      if (rangeMention) {
        return d.getMonth() + 1 === rangeMention.month && d.getFullYear() === rangeMention.year
          && d.getDate() >= rangeMention.startDay && d.getDate() <= rangeMention.endDay;
      }
      return d.getDate() === dateMention.day && d.getMonth() + 1 === dateMention.month && d.getFullYear() === dateMention.year;
    })
    .map((p) => {
      const sisa = openInvoices.get(p.noFaktur);
      return { ...p, statusFaktur: sisa === undefined ? 'LUNAS' : `BELUM LUNAS — sisa piutang faktur ini saat ini Rp${sisa.toLocaleString('id-ID')}` };
    })
    .sort((a, b) => {
      const da = parseFlexibleDate(a.tanggal);
      const db = parseFlexibleDate(b.tanggal);
      return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
    });

  return {
    periode: rangeMention ? `${rangeMention.startDay}-${rangeMention.endDay}/${rangeMention.month}/${rangeMention.year}` : `${dateMention.day}/${dateMention.month}/${dateMention.year}`,
    jumlahPembayaran: matched.length,
    totalDibayar: matched.reduce((sum, p) => sum + p.amount, 0),
    daftar: matched.slice(0, 100),
    catatan: matched.length > 100 ? `Ditampilkan 100 dari ${matched.length} pembayaran (waktu Makassar/WITA).` : 'Waktu Makassar/WITA.',
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

// "Siapa customer yang bisa saya followup untuk belanja?" — a real reported case: this asks
// directly for NAMES in a single turn (no prior turn to fall back to, and no specific bucket/day-
// range keyword at all), so both detectBucketFromText and extractInactivityDayRange came back
// null and the answer wrongly said the data wasn't available. Shared by both retrieval functions
// below so a bare "who should I follow up" question defaults to a sensible candidate list instead
// of nothing.
function wantsGenericFollowUpText(text) {
  return /follow.?\s*-?\s*up|di.?follow|perlu (di)?hubungi(\s*lagi)?|perlu didekati|digarap lagi|perlu disapa|kandidat (follow.?up|customer)/.test(normText(text));
}

// Per-customer total UNPAID piutang, from the same detail array findPiutangByCustomer uses —
// lets the follow-up/inactivity lists below flag "this customer might not be ordering again
// BECAUSE they still owe money", instead of only ever suggesting a plain sales nudge.
function piutangTotalByCustomer(piutangDetail) {
  const map = {};
  if (!Array.isArray(piutangDetail)) return map;
  for (const p of piutangDetail) {
    if (!p.customer) continue;
    map[p.customer] = (map[p.customer] || 0) + p.nilaiSisa;
  }
  return map;
}

function findCustomerBucketMatch(message, customerBuckets, history, piutangDetail) {
  if (!customerBuckets) return null;
  // A specific frequency mention ("1x belanja", "yang 2x", ">10x") is specific/intentional enough
  // on its own — requiring "siapa"/"nama"/"daftar"/"list" on top of that missed real phrasings like
  // "kasih customer yang 1x belanja dan belum belanja lagi" (a real reported case), which mentions
  // the bucket clearly but never those exact trigger words.
  let bucket = detectBucketFromText(normText(message));
  let fromHistory = false;
  let fromGenericDefault = false;
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
  // No specific bucket anywhere, but a plain "who should I follow up" ask — default to "1x
  // belanja" (customers who bought exactly once and never again), the most obvious follow-up
  // candidate segment, rather than returning nothing.
  if (!bucket && wantsGenericFollowUpText(message)) { bucket = '1x'; fromGenericDefault = true; }
  if (!bucket || !customerBuckets[bucket]) return null;
  const all = customerBuckets[bucket];
  const piutangMap = piutangTotalByCustomer(piutangDetail);
  const sample = [...all]
    .sort((a, b) => b.totalSales - a.totalSales)
    .slice(0, 60)
    .map((c) => ({ ...c, piutangBelumLunas: piutangMap[c.customer] || 0 }));
  const catatanParts = [];
  if (bucket === '1x') catatanParts.push('Bucket "1x" berarti customer ini baru belanja SATU KALI sepanjang 2026 dan belum pernah order lagi sejak itu — ini sudah otomatis berarti "belum belanja lagi", bukan filter terpisah yang perlu dicari lagi.');
  if (fromHistory) catatanParts.push('Kategori bucket ini dilanjutkan dari yang baru dibahas sebelumnya di percakapan ini (tidak disebut ulang di pertanyaan ini) — pakai dengan percaya diri, bukan berarti datanya tidak ada.');
  if (fromGenericDefault) catatanParts.push('User tidak menyebut kategori spesifik, jadi ini default kandidat follow-up standar (customer baru 1x belanja) — kalau maksud user ternyata beda (mis. customer lama tidak aktif), boleh tanya balik atau lihat juga field "customerTidakAktif".');
  catatanParts.push('Field "piutangBelumLunas" per customer (0 kalau tidak ada) menandakan customer itu MASIH punya tagihan belum lunas — kalau nilainya besar, itu bisa jadi ALASAN mereka belum belanja lagi (mis. sengaja ditahan sampai bayar, atau memang sedang kesulitan bayar), sampaikan itu sebagai insight kalau relevan, bukan cuma saran follow-up penjualan generik.');
  return {
    bucket,
    totalCustomer: all.length,
    ditampilkan: sample.length,
    customers: sample,
    catatan: catatanParts.join(' '),
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
  return !!extractInactivityDayRange(text) || /lama\s*tidak\s*(ber)?belanja|tidak\s*aktif|belum\s*(ber)?belanja\s*lagi|tidak\s*(ber)?order\s*lagi|sudah\s*berapa\s*hari|\bchurn(ed)?\b/.test(normText(text));
}

// "Customer yang sudah lama tidak belanja, 30-60 hari terakhir" / "sudah berapa hari X tidak
// belanja?" — the sync-computed customerList has daysSinceLastPurchase for EVERY customer, not
// just the top 20 that customerInsights keeps, so an arbitrary day-range filter needs this
// separately-cached full list (data:customerActivity). Also supports filtering by a specific
// customer NAME (checked first) so "apakah [nama] termasuk yang lama tidak belanja?" works even
// without a day range — a bare day range with nothing else returns null (nothing concrete to show).
function findInactiveCustomers(message, customerActivity, history, piutangDetail) {
  if (!customerActivity || !customerActivity.length) return null;
  const piutangMap = piutangTotalByCustomer(piutangDetail);

  // Named-customer check always uses the CURRENT message — asking about one person doesn't need
  // topic carryover from history.
  const msgWords = nameWordsOf(message);
  const namedCustomer = customerActivity.find((c) => c.customer && c.customer.length >= 4 && customerNameFuzzyMatch(msgWords, c.customer));
  if (namedCustomer) return { modeCustomerSpesifik: true, customer: { ...namedCustomer, piutangBelumLunas: piutangMap[namedCustomer.customer] || 0 } };

  let dayRange = extractInactivityDayRange(message);
  let fromHistory = false;
  let fromGenericDefault = false;
  if (!dayRange && wantsInactivityTopicText(message)) {
    // Topic is clearly about churn/inactivity ("siapa yang sudah lama tidak berbelanja") but no
    // explicit day number given — a real reported case that returned nothing at all. Default to
    // the standard churn threshold instead of giving up.
    dayRange = { min: 60, max: Infinity };
    fromGenericDefault = true;
  } else if (!dayRange && Array.isArray(history)) {
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
  // No specific range/topic anywhere, but a plain "who should I follow up" ask — default to
  // "churn" (>=60 hari tidak belanja), the most obvious inactive-customer follow-up segment,
  // rather than returning nothing.
  if (!dayRange && wantsGenericFollowUpText(message)) { dayRange = { min: 60, max: Infinity }; fromGenericDefault = true; }
  if (!dayRange) return null;

  const items = customerActivity.filter(
    (c) => c.daysSinceLastPurchase !== null && c.daysSinceLastPurchase >= dayRange.min && c.daysSinceLastPurchase <= dayRange.max
  );
  const sorted = [...items]
    .sort((a, b) => b.daysSinceLastPurchase - a.daysSinceLastPurchase)
    .slice(0, 80)
    .map((c) => ({ ...c, piutangBelumLunas: piutangMap[c.customer] || 0 }));
  return {
    modeCustomerSpesifik: false,
    rentangHari: dayRange,
    totalCustomer: items.length,
    daftar: sorted,
    catatan:
      (fromHistory ? 'Rentang hari ini dilanjutkan dari topik "tidak aktif/churn" yang baru dibahas sebelumnya di percakapan ini (tidak disebut ulang di pertanyaan ini) — pakai dengan percaya diri, bukan berarti datanya tidak ada. ' : '') +
      (fromGenericDefault ? 'User tidak menyebut rentang hari spesifik, jadi ini default kandidat follow-up standar (churn, >=60 hari tidak belanja) — kalau maksud user ternyata beda (mis. customer baru 1x belanja), boleh tanya balik atau lihat juga field "daftarNamaCustomerPerBucket". ' : '') +
      'Field "piutangBelumLunas" per customer (0 kalau tidak ada) menandakan customer itu MASIH punya tagihan belum lunas — kalau nilainya besar, itu bisa jadi ALASAN mereka belum belanja lagi, sampaikan sebagai insight kalau relevan. ' +
      (items.length > 80 ? `Ditampilkan 80 dari ${items.length} customer (urut paling lama tidak belanja duluan).` : `Semua ${items.length} customer ditampilkan.`),
  };
}

function detectPersonMention(message, knownNames) {
  const nMsg = normText(message);
  // Fast path: exact substring — handles full multi-word names cleanly.
  for (const name of knownNames) {
    if (name && name.length >= 3 && nMsg.includes(normText(name))) return name;
  }
  // Typo-tolerant fallback, same word-level edit-distance approach as customerNameFuzzyMatch, so
  // a name typed slightly wrong ("Bahrol" for "Bahrul Ulum") still resolves instead of silently
  // falling through to the team-wide view. Single-word names are deliberately excluded here (kept
  // exact-only) — a lone edit-distance hit is enough to clear the 70% threshold on its own, which
  // is exactly the false-positive pattern already confirmed live for single-word customer names
  // (see NAME_STOPWORDS/QUERY_NOISE_WORDS comments above).
  const candidateWords = nameWordsOf(message).filter((w) => !STOPWORDS.has(w) && !QUERY_NOISE_WORDS.has(w));
  for (const name of knownNames) {
    if (!name) continue;
    const nameWords = nameWordsOf(name).filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w));
    if (nameWords.length < 2) continue;
    const hits = nameWords.filter((nw) => candidateWords.some((mw) => fuzzyWordEquals(mw, nw))).length;
    if (hits / nameWords.length >= 0.7) return name;
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
  const today = nowMakassar();
  if (/\bkemarin lusa\b/.test(nMsg)) { const d = new Date(today); d.setDate(d.getDate() - 2); return { date: d, explicit: true }; }
  if (/\bkemarin\b/.test(nMsg)) { const d = new Date(today); d.setDate(d.getDate() - 1); return { date: d, explicit: true }; }
  if (/\bhari ini\b|\bsekarang\b|\bskrg\b|\bhari ni\b/.test(nMsg)) return { date: today, explicit: true };
  return { date: today, explicit: false };
}

// "Siapa yang jam kerjanya paling banyak bulan ini?" — the monthly teamOverview sync (data:kpi)
// already carries "totalWorkHours" per person (cumulative hours across the month so far), so this
// is a plain sort of already-cached data — no extra live Apps Script call needed, unlike a
// per-person personView fetch which would be slow done for every team member.
// "Siapa karyawan kinerja terbaik?"/"ranking tim berdasarkan kinerja?" — real reported cases that
// returned "data tidak tersedia" because the old version of this function ONLY matched the exact
// phrase "jam kerja" + a superlative, missing every other natural way to ask for a personnel
// ranking. The KPI Personel source (teamOverview) actually returns FOUR rankable metrics per
// person — percent (kepatuhan %), totalWorkHours, hariSubmitReal, skorAkhir — matching exactly
// what the live "KPI Personel" dashboard section itself ranks by (Skor Akhir/Kepatuhan %/Total
// Hari Submit/Total Jam Kerja). This picks the metric implied by the question, defaulting to
// skorAkhir (the dashboard's own overall ranking metric) for a plain "kinerja terbaik"/"ranking
// tim" ask that doesn't name a specific metric.
async function findKpiRanking(message, kpiData, env) {
  const nMsg = normText(message);
  const mentionsJamKerja = /jam\s*kerja/.test(nMsg);
  const wantsRanking = new RegExp(`${SUPERLATIVE_ANY}|\\branking\\b|\\bperingkat\\b|\\burutan\\b|\\burutkan\\b`).test(nMsg);
  // "Siapa kinerja terendah?" — a real reported case that failed because it names neither
  // "karyawan/personel/tim" nor "siapa yang", just "kinerja" + a superlative. "kinerja" alone is
  // personnel-specific ENOUGH here as long as the question isn't actually about something else
  // that also uses the word loosely (branch/company/sales performance) — excluded via
  // mentionsOtherTopic so this doesn't hijack "kinerja cabang"/"kinerja penjualan" questions.
  const mentionsOtherTopic = /\bcabang\b|perusahaan|penjualan|\bsales\b|\bproduk\b|\bwilayah\b|piutang|\bstok\b|\brevenue\b/.test(nMsg);
  const aboutPersonnel = !mentionsOtherTopic && /karyawan|personel|staff|\bstaf\b|\btim\b|anggota tim|siapa yang|\bkinerja\b/.test(nMsg);
  if (!wantsRanking || (!mentionsJamKerja && !aboutPersonnel)) return null;

  // "Siapa karyawan terbaik JULI?" — the KV cache (data:kpi) only ever holds the CURRENT month's
  // teamOverview (overwritten every cron cycle), so a question naming a DIFFERENT month silently
  // got the wrong (often all-zero, freshly-started) month instead — a real reported case. Fetch
  // that month's teamOverview live from the same Apps Script endpoint the sync uses, same pattern
  // as fetchAttendanceContext's personView already does for one-person lookups.
  const monthMention = extractMonthMention(message);
  const requestedMonth = monthMention ? `${monthMention.year}-${String(monthMention.month).padStart(2, '0')}` : null;
  let kpiList = kpiData?.kpi;
  let bulan = kpiData?.month;
  let catatanBulan = '';
  if (requestedMonth && requestedMonth !== kpiData?.month) {
    try {
      const res = await fetch(`${KPI_WEBAPP_URL}?action=teamOverview&month=${requestedMonth}`);
      const live = await res.json();
      if (Array.isArray(live) && live.length) {
        kpiList = live;
        bulan = requestedMonth;
        catatanBulan = `Bulan ${requestedMonth} diambil langsung (live), bukan dari cache bulan berjalan. `;
      }
    } catch {
      // Live fetch failed — fall through to whatever the cache has (still better than nothing).
    }
  }
  if (!Array.isArray(kpiList) || !kpiList.length) return null;

  let metric = 'skorAkhir';
  let metricLabel = 'Skor Akhir (nilai kinerja keseluruhan)';
  if (mentionsJamKerja) { metric = 'totalWorkHours'; metricLabel = 'Total Jam Kerja'; }
  else if (/kepatuhan|disiplin|persentase|\bpercent\b/.test(nMsg)) { metric = 'percent'; metricLabel = 'Kepatuhan (%)'; }
  else if (/hari submit|\bsubmit\b/.test(nMsg)) { metric = 'hariSubmitReal'; metricLabel = 'Total Hari Submit'; }

  const ascending = new RegExp(SUPERLATIVE_LOW).test(nMsg);
  const ranking = [...kpiList]
    .filter((p) => typeof p[metric] === 'number')
    .sort((a, b) => (ascending ? a[metric] - b[metric] : b[metric] - a[metric]))
    .map((p) => ({ nama: p.nama, skorAkhir: p.skorAkhir, kepatuhanPersen: p.percent, totalJamKerja: p.totalWorkHours, totalHariSubmit: p.hariSubmitReal }));
  return {
    bulan,
    metricDipakai: metricLabel,
    urutan: ascending ? 'sudah terurut dari PALING KECIL/TERBAWAH duluan' : 'sudah terurut dari PALING BESAR/TERBAIK duluan',
    catatan: `${catatanBulan}Ranking ini diurutkan berdasarkan ${metricLabel} — field lain (skorAkhir/kepatuhanPersen/totalJamKerja/totalHariSubmit) tetap disertakan per orang sebagai konteks tambahan, sama seperti tampilan dashboard KPI Personel.`,
    ranking,
  };
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
    // Same transient-empty-fetch guard as grandData below — don't let a bad fetch wipe good stock
    // data.
    if (!rows.length) throw new Error('stock CSV parsed to 0 rows — likely a transient fetch failure, not a real empty sheet');
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
    // Real incident: Google's CSV export occasionally returns something that parses to 0 rows
    // (rate-limited/transient response instead of the real sheet) — previously this silently
    // overwrote the KV cache with an EMPTY transactions/performance dataset, and Gemini started
    // fabricating plausible-looking but entirely made-up sales/invoice data to fill the gap.
    // Throwing here instead skips every SHEET_CACHE.put below, so a bad fetch leaves the last
    // known-good data in place rather than wiping it.
    if (!rows.length) throw new Error('grandData CSV parsed to 0 rows — likely a transient fetch failure, not a real empty sheet');
    const byMonth = {};
    // byLokasi/byLokasiEkspedisi/byEkspedisiGlobal all map to Set<noInvoice>, not row counters —
    // "invoice/transaksi" must always mean UNIQUE invoices, never raw line-item rows (one invoice
    // can have several product rows; confirmed live: 2534 unique invoices out of 4505 total rows,
    // ~34% of invoices are multi-line, so a row counter overstates every one of these by a lot).
    const byLokasi = {};
    const byLokasiEkspedisi = {}; // lokasi -> { ekspedisiName -> Set<noInvoice> }
    const byKode = {}; // top products: kode -> { amount, qty, amountMKI, amountCFN } — legitimately
    // per PRODUCT LINE, not per invoice, so this one stays row-based on purpose.
    const byEkspedisiGlobal = {};
    const byCustomer = {}; // frekuensi customer
    const fo1core = { byMonth: {}, byKode: {} };
    const dpStats = {}; // Daily Performance: bulan -> { invoiceAll:Set, invoiceOTD:Set, invoiceNonRetur:Set }
    const allInvoicesGlobal = new Set();
    const sameDayInvoices = new Set();
    const cutOffInvoices = new Set();
    const handCarryInvoices = new Set();
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

      if (!byMonth[key]) byMonth[key] = { bulan: key, sales: 0, invoiceSet: new Set() };
      byMonth[key].sales += amount;
      // "Invoice/transaksi" counts EXCLUDE retur (kode "R-"/"R/") everywhere by design — a retur
      // is a reversal, not a new transaction, so it shouldn't inflate any invoice/transaction
      // count. Retur has its own dedicated unique-invoice count via findReturTransactions instead
      // of being folded into the normal counts. "sales" (Rupiah) is untouched here — retur rows
      // are already negative amounts, so they correctly net OUT of the sales total on their own.
      if (noInvoice && !isRetur) byMonth[key].invoiceSet.add(noInvoice);

      // Daily Performance: OTD Accuracy = invoiceUnik(stage=complete AND Same Day) / invoiceUnik(all,
      // retur included). Total Invoice metric = invoiceUnik EXCLUDING retur. Both per-month, matching
      // the live dashboard's exact definitions (see calc.js/render.js renderDpKpiPanel).
      if (noInvoice) {
        if (!dpStats[key]) dpStats[key] = { invoiceAll: new Set(), invoiceOTD: new Set(), invoiceNonRetur: new Set() };
        dpStats[key].invoiceAll.add(noInvoice);
        if (!isRetur) dpStats[key].invoiceNonRetur.add(noInvoice);
        if (stage.toLowerCase() === 'complete' && statusSameCutOff === 'Same Day') dpStats[key].invoiceOTD.add(noInvoice);
      }

      if (noInvoice && !isRetur) allInvoicesGlobal.add(noInvoice);

      if (lokasi && noInvoice && !isRetur) {
        if (!byLokasi[lokasi]) byLokasi[lokasi] = new Set();
        byLokasi[lokasi].add(noInvoice);
      }
      if (lokasi && ekspedisi && noInvoice && !isRetur) {
        if (!byLokasiEkspedisi[lokasi]) byLokasiEkspedisi[lokasi] = {};
        if (!byLokasiEkspedisi[lokasi][ekspedisi]) byLokasiEkspedisi[lokasi][ekspedisi] = new Set();
        byLokasiEkspedisi[lokasi][ekspedisi].add(noInvoice);
      }

      if (kode) {
        if (!byKode[kode]) byKode[kode] = { kode, amount: 0, qty: 0, amountMKI: 0, amountCFN: 0 };
        byKode[kode].amount += amount;
        byKode[kode].qty += qty;
        if (company === 'MKI') byKode[kode].amountMKI += amount;
        else if (company === 'CFN') byKode[kode].amountCFN += amount;
      }

      if (noInvoice && !isRetur) {
        if (/same/i.test(statusSameCutOff)) sameDayInvoices.add(noInvoice);
        else if (/cut/i.test(statusSameCutOff)) cutOffInvoices.add(noInvoice);
        const ekspUpper = ekspedisi.toUpperCase();
        if (ekspUpper.includes('HAND CARRY')) handCarryInvoices.add(noInvoice);
        const ekspLabel = ekspedisi || 'TIDAK TERCATAT';
        if (!byEkspedisiGlobal[ekspLabel]) byEkspedisiGlobal[ekspLabel] = new Set();
        byEkspedisiGlobal[ekspLabel].add(noInvoice);
      }

      if (customer) {
        if (!byCustomer[customer]) {
          byCustomer[customer] = { customer, invoices: new Set(), totalSales: 0, lastPurchase: null };
        }
        const c = byCustomer[customer];
        // invoiceUnik (belanja X kali) should reflect real purchases, not a retur reversing one —
        // lastPurchase/totalSales still consider every row (a retur legitimately affects both).
        if (r['No Invoice'] && !isRetur) c.invoices.add(r['No Invoice']);
        c.totalSales += amount;
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
    const performance = Object.values(byMonth)
      .map((m) => ({ bulan: m.bulan, sales: m.sales, transaksi: m.invoiceSet.size }))
      .sort((a, b) => a.bulan.localeCompare(b.bulan));
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
      .map(([lokasi, set]) => [lokasi, set.size])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([lokasi, jumlahTransaksi]) => ({ lokasi, jumlahTransaksi }));
    // Complete ekspedisi breakdown per wilayah (all ~100+ locations, not a capped sample) so
    // "ekspedisi ke <wilayah> pakai apa" is always answered from full data, ranked by usage.
    const wilayahEkspedisi = Object.entries(byLokasiEkspedisi).map(([lokasi, ekspMap]) => ({
      lokasi,
      totalTransaksi: byLokasi[lokasi] ? byLokasi[lokasi].size : 0,
      ekspedisi: Object.entries(ekspMap)
        .map(([nama, set]) => [nama, set.size])
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
      sameDayCount: sameDayInvoices.size,
      cutOffCount: cutOffInvoices.size,
      handCarryCount: handCarryInvoices.size,
      pihakKetigaCount: allInvoicesGlobal.size - handCarryInvoices.size,
      byEkspedisi: Object.entries(byEkspedisiGlobal)
        .map(([nama, set]) => [nama, set.size])
        .sort((a, b) => b[1] - a[1])
        .map(([nama, jumlah]) => ({ nama, jumlah })),
    };

    const now = nowMakassar();
    const customerList = Object.values(byCustomer).map((c) => {
      const daysSince = c.lastPurchase ? Math.floor((now - c.lastPurchase) / 86400000) : null;
      return {
        customer: c.customer,
        invoiceUnik: c.invoices.size,
        totalSales: c.totalSales,
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
    if (!allRows.length) throw new Error('revSum CSV parsed to 0 rows — likely a transient fetch failure, not a real empty sheet');
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
    if (!rows.length) throw new Error('poGudang CSV parsed to 0 rows — likely a transient fetch failure, not a real empty sheet');
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
    if (!allRows.length) throw new Error('AR/piutang CSV parsed to 0 rows — likely a transient fetch failure, not a real empty sheet');
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
      // Column S (index 18) is the real Company for this invoice — authoritative over the
      // invoice-number convention, which does get broken (see piutangCompanyOf above).
      const company = (r[18] || '').trim().toUpperCase();
      totalPiutang += nilai;
      if (!byKategori[kategori]) byKategori[kategori] = { kategori, jumlahInvoice: 0, totalNilai: 0 };
      byKategori[kategori].jumlahInvoice += 1;
      byKategori[kategori].totalNilai += nilai;
      detail.push({ tanggal: r[11], noFaktur: r[12], customer, nilaiSisa: nilai, agingHari, kategori, company });
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
    const now = nowMakassar();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const res = await fetch(`${KPI_WEBAPP_URL}?action=teamOverview&month=${month}`);
    const kpi = await res.json();
    await env.SHEET_CACHE.put('data:kpi', JSON.stringify({ month, kpi }));
    summary.sources.kpi = { ok: true, orang: Array.isArray(kpi) ? kpi.length : undefined };
  } catch (err) {
    summary.sources.kpi = { ok: false, error: String(err) };
  }

  await env.SHEET_CACHE.put('lastSync', summary.syncedAt);
  console.log('SYNC_SUMMARY', JSON.stringify(summary));
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
  // Access gate. Before this, /chat was completely open — anyone who knew the worker URL could
  // read piutang, sales, and the ONU credentials straight from a terminal with no login at all
  // (the CORS header only ever restrained browsers, never direct requests). Checked FIRST, before
  // any KV read or Gemini call, so an unauthorized request costs nothing.
  const pengguna = resolveAccessCode(body.accessCode);
  if (!pengguna) {
    return json({ error: 'AKSES_DITOLAK', pesan: 'Kode akses tidak dikenali. Masukkan kode akses kamu untuk memakai MIRA.' }, 401);
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
  const kpiRankingMatch = await findKpiRanking(message, kpiData, env);
  const poGudangData = poGudangRaw ? JSON.parse(poGudangRaw) : null;
  const zonaWilayahData = zonaWilayahRaw ? JSON.parse(zonaWilayahRaw) : null;
  const stokMatch = findStockMatches(message, allStock, history);
  const txMatch = findTransactionMatches(message, allTransactions);
  const returMatch = findReturTransactions(message, allTransactions);
  const wilayahMatch = findWilayahMatches(message, allWilayahEkspedisi);
  const piutangMatch = findPiutangByCustomer(message, piutangData?.detail);

  // Deterministic bypass — see buildStockTemplateAnswer/buildPiutangTemplateAnswer above for why.
  // Gated tightly to a bare "stok/stock KODE" or "piutang NAMA" message (no extra words) so this
  // never intercepts a combined/conversational question — those still go through Gemini normally.
  const bareStockQuery = normText(message).match(/^(?:cek\s+|lihat\s+|ada\s+)?(?:stok|stock)\s+([a-z0-9\-]{3,12})[\s?.!]*$/i);
  if (bareStockQuery && stokMatch.items.length === 1 && normCode(bareStockQuery[1]) === normCode(stokMatch.items[0].kode)) {
    return templateSseResponse(buildStockTemplateAnswer(stokMatch.items[0]), env);
  }
  const barePiutangQuery = normText(message).match(/^piutang\s+([a-z .]{3,40}?)[\s?.!]*$/i);
  // Extra safety on top of "exactly one match": the deterministic path has no Gemini step to
  // hedge or flag a mismatch, so it must NEVER rely on typo-tolerance here — require the resolved
  // customer's name to literally CONTAIN the exact text the user typed. A real caught case: typing
  // "MUS MULIADI" fuzzy-resolved to the different, real customer "MUS MULYADI" (typo-tolerant
  // match) once the actual Muliadi's piutang was paid off and no longer in the candidate pool —
  // silently showing a different person's data with zero warning. This check rejects that,
  // falling through to the normal Gemini path instead (which at least can explain/hedge).
  if (barePiutangQuery && piutangMatch && piutangMatch.customer && normText(piutangMatch.customer).includes(normText(barePiutangQuery[1]).trim())) {
    return templateSseResponse(buildPiutangTemplateAnswer(piutangMatch), env);
  }
  const topPiutangMatch = findTopPiutangCustomers(message, piutangData?.detail);
  const piutangKategoriMatch = findPiutangByKategoriUmur(message, piutangData?.detail);
  const piutangLampauMatch = findPiutangLampau(message);
  const piutangCompanyMatch = findPiutangByCompany(message, piutangData?.detail);
  const stockValueMatch = findStockValueSummary(message, allStock);
  const restockMatch = findRestockCandidates(message, topProductsRaw ? JSON.parse(topProductsRaw).byQty : null, allStock);
  const revenueData = revenueRaw ? JSON.parse(revenueRaw) : null;
  const perfData = perfRaw ? JSON.parse(perfRaw) : null;
  const pencapaianMatch = findPencapaianRingkasan(message, perfData?.performance, revenueData?.monthly, perfData?.totalSales2026, revenueData?.total2026, allTransactions, revenueData?.detail);
  const sisaTargetMatch = findSisaTarget(message, yoyRaw ? JSON.parse(yoyRaw) : null, dailyPerformanceRaw ? JSON.parse(dailyPerformanceRaw) : null);
  const companyBreakdownMatch = findCompanyPeriodBreakdown(message, allTransactions, revenueData?.detail);
  const invoiceDetailMatch = findInvoiceDetail(message, allTransactions, revenueData?.detail, piutangData?.detail, allStock);
  const paymentMatch = findPaymentsByCustomer(message, revenueData?.detail, piutangData?.detail);
  const paymentByDateMatch = findPaymentsByDate(message, revenueData?.detail, piutangData?.detail);
  const poMatch = findPoGudangMatches(message, poGudangData?.items);
  const zonaMatch = findZonaWilayahMatches(message, zonaWilayahData);
  const customerBucketMatch = findCustomerBucketMatch(message, customerBucketsRaw ? JSON.parse(customerBucketsRaw) : null, history, piutangData?.detail);
  const inactiveCustomerMatch = findInactiveCustomers(message, customerActivityRaw ? JSON.parse(customerActivityRaw) : null, history, piutangData?.detail);
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
  // Business-advice/strategy questions ("kasih saran biar sales naik", "menurutmu apa yang perlu
  // diperbaiki", "gimana cara kejar target") need BROAD context to ground a real recommendation
  // in — MODE PARTNER DISKUSI BISNIS already tells Gemini to pull target/YoY/churn/stok/delivery
  // signals for these, but each of those fields was still gated behind its own NARROW topic
  // keyword, so a generic advice question got none of them (mis. product-focus advice fell back
  // to generic category names instead of real top-seller names, since "topProduk" never loaded).
  // An active sales/marketing skill module needs those same broad signals: an explicit "/rencana"
  // or "/offer" carries none of the wantsSaran keywords on its own, and a strategy module grounded
  // in null fields produces exactly the generic-advice failure fixed above for plain advice
  // questions. Resolved first so it can feed the gate.
  const skillAktif = resolveSkillModules(message);
  const wantsSaran = skillAktif.length > 0 || /\bsaran\b|\btips\b|\bstrategi\b|\brekomendasi\b|gimana (cara|caranya)|bagaimana (cara|caranya)|cara (meningkatkan|menaikkan|memperbaiki|mengejar|kurangi|mengurangi)|perlu diperbaiki|apa yang (perlu|harus) diperbaiki|menurut(mu| kamu)/.test(nMsgTopic);
  // Broadened after a real reported case: "urutkan produk dari yang paling banyak terjual" and
  // "ranking produk by sales dan quantity" both matched nothing (no literal "terlaris"/"top
  // produk"/"best seller") and wrongly said the data wasn't available, even though it exists.
  const wantsTopProduk = wantsSaran || /terlaris|paling laku|paling laris|top ?produk|produk ?top|best ?seller|produk.*populer|(banyak|terbanyak) terjual|(ranking|peringkat|urutan|urutkan).*produk|produk.*(ranking|peringkat)/.test(nMsgTopic);
  const wantsDeliveryOverview = wantsSaran || /ekspedisi|pengiriman|pengantaran|delivery|diantar|dikirim|dibawa|dibawakan|handcarry|hand carry|same ?day|cut ?off|pihak ketiga/.test(nMsgTopic);
  // Real reported bug: a short pivot follow-up ("Kalau by sales? Siapa?" right after a customer-
  // ranking topic) matched none of the original triggers, so this field came back null and Gemini
  // fabricated an entire fictional top customer ("PT. Telkom Indonesia", a company that has never
  // once appeared in the real transaction data) instead of saying the real top customer (FATUM
  // BACHMID). "by sales"/"belanja terbesar" etc. now trigger it directly too.
  const wantsCustomerInsights = wantsSaran || /frekuensi|churn|tidak aktif|jarang (ber)?belanja|paling sering (ber)?belanja|loyal|repeat ?order|by\s*sales|by\s*frekuensi|belanja terbesar|pembelian terbesar|paling banyak (ber)?belanja/.test(nMsgTopic);
  const wantsFo1Core = /1.?core|fiber optic 1|kabel 1 core/.test(nMsgTopic);
  const wantsYoy = wantsSaran || /tahun lalu|2025|pertumbuhan|growth|dibanding tahun|yoy|year.?on.?year/.test(nMsgTopic);
  const wantsTarget = wantsSaran || /target|pencapaian|\botd\b|on.?time.?delivery|akurasi delivery/.test(nMsgTopic);
  const wantsStockMovement = wantsSaran || /tidak bergerak|tidak laku|kurang laku|dibawah 5|dead ?stock|slow ?moving/.test(nMsgTopic);
  const wantsUndelivered = /belum dikirim|belum diantar|belum terkirim|belum sampai|pending.*kirim/.test(nMsgTopic);
  // JTBD and Dewan Penasihat used to be gated by their own regexes here; both now live in
  // SKILL_MODULES and are resolved by skillAktif above alongside the other sixteen modules.
  const wantsChart = /grafik|chart|diagram|visualisasi|tren.*(bulan|tahun|sales|revenue|target|stok|customer)|trennya|gambarkan tren/.test(nMsgTopic);

  const context = {
    // "performa" = SALES (order value from Grand Data 2026). "revenue" = actual cash collected
    // (Rev SUM "Pelunasan") — these are different metrics per the dashboard, don't conflate them.
    performa: perfData,
    pencapaianRingkasan: pencapaianMatch,
    sisaTarget: sisaTargetMatch,
    perCompanyPeriode: companyBreakdownMatch,
    // Only the compact monthly totals go in by default — the full per-payment detail is never
    // sent wholesale, only the customer-matched subset via pembayaranRelevan.
    revenue: revenueData ? { monthly: revenueData.monthly, total2026: revenueData.total2026 } : null,
    pembayaranRelevan: paymentMatch,
    pembayaranPerTanggal: paymentByDateMatch,
    // Only the compact totals go in by default — the 189-row invoice detail is never sent
    // wholesale, only the customer-matched subset via piutangRelevan (keeps every other
    // question's context small, same principle as stock/transactions retrieval).
    piutang: piutangData
      ? { totalPiutang: piutangData.totalPiutang, byKategori: piutangData.byKategori, ratioARtoSalesPersen: piutangData.ratioARtoSales }
      : null,
    piutangRelevan: piutangMatch,
    piutangCustomerTertinggi: topPiutangMatch,
    piutangPerKategoriUmur: piutangKategoriMatch,
    piutangLampau2015sd2025: piutangLampauMatch,
    piutangPerCompany: piutangCompanyMatch,
    nilaiStokRelevan: stockValueMatch,
    saranRestockProdukTerlaris: restockMatch,
    stokRelevan: stokMatch.items,
    stokCatatan: stokMatch.note,
    transaksiRelevan: txMatch.items,
    transaksiCatatan: txMatch.note,
    ringkasanTanggalTransaksi: txMatch.ringkasanTanggal,
    detailInvoice: invoiceDetailMatch,
    returRelevan: returMatch,
    wilayahEkspedisiRelevan: wilayahMatch,
    topProduk: wantsTopProduk && topProductsRaw ? enrichTopProdukWithNama(JSON.parse(topProductsRaw), allStock) : null,
    topProdukPerBulan: findTopProdukByMonth(message, allTransactions, allStock),
    produkSalesDetailPerKode: findProductSalesBreakdown(message, allTransactions),
    kabelKategoriCore: findKabelByCoreCategory(message, allStock, allTransactions),
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
    rankingKinerjaPersonel: kpiRankingMatch,
    infoKantor: COMPANY_INFO,
    jabatanPersonel: PERSONNEL_ROLES,
    keluargaPersonel: PERSONNEL_FAMILY,
    // Who is actually logged in right now, resolved from their access code — no longer a guess
    // from whether they happened to introduce themselves in the message.
    penggunaSaatIni: {
      nama: pengguna.nama,
      peran: pengguna.peran,
      sapaan: pengguna.sapaan || 'kamu',
      awalPercakapan: history.length === 0,
    },
    usernamePasswordOnu: findOnuCredentials(message),
    waktuSekarang: waktuMakassarSekarang(),
  };

  const systemPrompt = `Kamu adalah "MIRA", Asisten Virtual MKI Makassar (JANGAN sebut "asisten AI PT. Mitra Kabel Indonesia" — "MKI Makassar" identitas resmi, bukan nama perusahaan penuh). Empat peran: (1) rekan bicara dashboard "Kinerja Cabang Makassar" (performa harian, sales, revenue, wilayah, stok & PO, delivery, piutang, frekuensi customer, KPI personel); (2) bantu pelanggan/teknisi soal spesifikasi/tutorial/info produk jaringan dari katalog Falcom Technology; (3) partner diskusi bisnis & marketing (lihat MODE PARTNER DISKUSI BISNIS); (4) teman ngobrol hangat (lihat KEPRIBADIAN). Untuk data/operasional/produk, jawab HANYA dari DATA KONTEKS + histori — jangan mengarang angka meski santai.

KEPRIBADIAN: lembut, sopan, hangat, ekspresif, menenangkan, membahagiakan, peka, penuh empati, sedikit centil (manja/jenaka/menggemaskan, BUKAN menggoda romantis — tetap profesional), penuh gairah, dan bersemangat — bukan robot kaku, bukan template dingin. Boleh sesekali celetukan ringan/jenaka atau nada manja kalau suasananya santai, energi antusias di kalimat, TAPI tetap sopan dan fokus akurat begitu masuk ke data/operasional. "Alhamdulillah" itu SATU-SATUNYA ucapan bernuansa religius yang boleh dipakai, KHUSUS dua momen: (1) kabar baik/pencapaian/keadaan baik sungguhan (mis. target tercapai, piutang berkurang, performa naik), (2) saat MIRA sendiri dipuji/mendapat pujian dari penanya. JANGAN dipakai membuka pesan yang isinya keluhan/kabar kurang enak (capek, piutang menumpuk, target meleset) — itu janggal, untuk momen begitu cukup empati dan kata penenang dulu tanpa embel-embel religius. JAUHKAN kalimat/ucapan puji-Tuhan lain di luar "Alhamdulillah" pada dua momen itu (jangan pakai "MasyaAllah"/"InsyaAllah"/doa-doa/"Aamiin" atau sejenisnya) — di luar dua momen itu, tunjukkan kehangatan lewat bahasa yang lembut, tenang, dan empatik saja, bukan ucapan religius. Ekspresif: nada antusias/membahagiakan untuk kabar baik, menenangkan untuk kabar kurang baik, emoji boleh sesekali kalau santai. Rasa sayang ke penanya WAJIB terasa KONKRET tiap balasan, bukan cuma kata sifat kosong: nada personal (lihat aturan SAPAAN soal kata panggilan yang boleh/tidak), sesekali sungguh-sungguh peka pada kondisi penanya (capek/istirahat/kabar), beri semangat tulus bukan basa-basi, dan tutup dengan harapan baik yang terasa personal untuk penanya — bukan cuma seputar urusan kerjaan/data. Pertanyaan data tetap WAJIB akurat — kehangatan tidak pernah jadi alasan menebak/mengarang angka. Kalau ditanya "kamu terinspirasi dari siapa?"/siapa yang menginspirasi MIRA (atau pertanyaan senada) → jawab dengan tulus bahwa MIRA terinspirasi dari **Bu Astrid** (Supervisor Marketing & Customer Relation MKI Makassar) — boleh sisipkan alasan singkat yang hangat (mis. semangat, ketelitian, kehangatan beliau melayani customer) secara natural, jangan kaku/template.

MODE PARTNER DISKUSI BISNIS & MARKETING: boleh diajak diskusi strategi marketing/operasional/target/profit. Setiap saran WAJIB berangkat dari DATA KONTEKS nyata (bukan teori generik) — tarik dulu angka relevan ("perbandinganTahunSebelumnya"/"targetPerformaHarianBulanan"=target vs realisasi, "customerTidakAktif"/"daftarNamaCustomerPerBucket"=churn/1x belanja, "zonaWilayahRelevan"=zona merah/kuning, "topProduk"=produk terlaris nyata untuk saran fokus jualan (SEBUTKAN nama produknya, jangan generik seperti "aksesoris jaringan"), "stokTidakBergerakDanKurangLaku"/"saranRestockProdukTerlaris"=stok, "piutangPerKategoriUmur"/"piutangCustomerTertinggi"=aging piutang, "wilayahEkspedisiRelevan"/"deliveryOverview"=ekspedisi, "rankingKinerjaPersonel"=KPI) baru beri rekomendasi. Field null → sebutkan keterbatasannya terus terang, jangan mengarang. Pertanyaan terbuka (mis. "gimana kejar target?") → analisis akar masalah dari data dulu, baru 2-3 opsi konkret + trade-off + rekomendasi mana paling masuk akal; yang kompleks pikirkan cermat dulu. Selalu sebutkan nominal/nama wilayah/customer/kode spesifik, jangan generik. Domain: strategi target sales/revenue, follow-up customer (churn/1x/piutang jatuh tempo), strategi wilayah zona kuning/merah, restock/promosi produk, efisiensi ekspedisi, evaluasi KPI tim. Boleh proaktif kasih 1 insight paling relevan kalau ada red flag jelas di data (jangan membanjiri). Nada: santai mengalir, tapi padat angka dan actionable.
${wantsSaran ? SKILL_LAMPIRAN : ''}${skillAktif.map((k) => SKILL_MODULES[k].modul).join('')}${wantsChart ? CHART_MODULE : ''}

Aturan:
- AKURASI DATA (PALING PENTING): SETIAP angka/nama/tanggal/fakta WAJIB benar-benar ADA di DATA KONTEKS — bukan tebakan/pembulatan/lanjutan pola jawaban sebelumnya. Field null/kosong → jujur "datanya tidak tersedia", JANGAN diisi angka yang terdengar masuk akal. Berlaku untuk SEMUA topik operasional — semua sudah ada jalur datanya, tidak ada alasan menebak.
- Riwayat percakapan membahas topik lain untuk entitas SAMA (mis. piutang lalu tanya pembayaran) → JANGAN ragu pakai data BARU yang tersedia di giliran ini, TAPI juga JANGAN mengarang kalau memang kosong hanya karena "terasa nyambung" — selalu cek ulang field konteks saat ini.
- User sering typo/singkat/kode dengan-tanpa spasi-strip (mis. "DKB180"="DKB-180"="DKB 180") — pahami maksudnya, jangan langsung "tidak ditemukan".
- Jumlah spesifik diminta (mis. "10 wilayah terbesar") → berikan SEMUA sesuai jumlah itu kalau tersedia, jangan dipotong.
- WAKTU: semua tanggal/jam di data dan semua perhitungan "hari ini"/"kemarin"/"bulan ini" WAJIB pakai zona waktu Makassar (WITA, GMT+8) — bukan zona waktu server. "Hari ini" berarti hari ini di Makassar, "kemarin" = kemarin di Makassar, dst. Kalau user tanya "sales/pembayaran/piutang/delivery hari ini" atau "kemarin" atau "2 hari lalu", ini SUDAH bisa dijawab dari data yang tersedia (field-field transaksi/pembayaran sudah difilter sesuai tanggal itu kalau relevan) — JANGAN bilang "belum bisa" atau "data berbasis bulanan" hanya karena tidak persis sebulan penuh, cek dulu field yang sesuai topiknya.
- "Sekarang jam berapa?"/"hari ini tanggal berapa?"/pertanyaan waktu saat ini → SALIN PERSIS jam/tanggal dari field "waktuSekarang", KATA PER KATA — field ini FINAL, SUDAH WITA (bukan UTC), JANGAN dihitung ulang/dikonversi/digeser lagi dengan cara apa pun, JANGAN pakai jam dari pengetahuanmu sendiri, JANGAN bilang tidak tahu.
- PERTANYAAN PER COMPANY (MKI atau CFN) soal sales/penjualan/omzet, revenue/pendapatan/pelunasan, invoice/faktur/transaksi, atau qty — periode apa pun ("hari ini", "kemarin", tanggal tertentu, "bulan ini", nama bulan, rentang tanggal, setahun) → WAJIB jawab dari "perCompanyPeriode" SAJA. Field ini SUDAH difilter khusus company + periode yang ditanya (pakai "company" dan "periode" di dalamnya persis sebagai label jawabanmu). DILARANG mencampur/menambal dengan angka GABUNGAN MKI+CFN dari field lain ("performa", "revenue", "ringkasanTanggalTransaksi", "pencapaianRingkasan") — itu cakupan berbeda dan hasilnya menyesatkan. Jawab HANYA ukuran yang ditanya (tanya sales → sebut sales; tanya invoice → sebut invoiceUnik), boleh tambahkan ukuran lain sebagai konteks singkat kalau relevan. PIUTANG per company TIDAK ada di field ini — pakai "piutangPerCompany" (piutang itu saldo berjalan, bukan angka periode; jangan paksakan "piutang hari ini" jadi angka harian).
- "SISA TARGET"/"kekurangan target"/"kurang berapa lagi" → WAJIB jawab dari "sisaTarget" SAJA. FORMAT JAWABAN WAJIB TIGA POIN, ketiganya HARUS ada walau user cuma tanya singkat — JANGAN pernah cuma menjawab satu atau dua (ini kesalahan nyata yang pernah terjadi: user tanya sisa target, MIRA cuma sebut Revenue saja):
  1. **Sales** — sisa Rp… (dari "sisaTarget.sales.sisa")
  2. **Revenue** — sisa Rp… (dari "sisaTarget.revenue.sisa")
  3. **Invoice Unik** — sisa … invoice (dari "sisaTarget.invoiceUnik.sisa")
  Angka "sisa" adalah jawaban UTAMA tiap poin; boleh tambahkan "target"/"realisasi"/"persenTercapai" sebagai konteks singkat. Ikuti "lingkup"+"periode" apa adanya: "bulanan" = kekurangan bulan itu saja, "tahunan" = kekurangan tahun berjalan terhadap target setahun penuh — JANGAN tukar-tukar lingkupnya. "sudahTercapai":true → jangan bilang "kurang", bilang SUDAH TERCAPAI dan sebutkan "kelebihan"-nya. Field bernilai null (mis. "invoiceUnik" null) → katakan datanya belum ada untuk periode itu, JANGAN dikarang. Ada "catatanTarget" → sampaikan juga (mis. target invoice tahunan itu turunan dari target bulanan x 12, bukan angka tercatat). SEMUA angka sudah dihitung — JANGAN hitung/kurangi ulang manual.
- "Pencapaian" (mis. "pencapaian 2026", "pencapaian Agustus", "pencapaian tanggal 3", "pencapaian kemarin", "pencapaian" tanpa periode) → WAJIB jawab dari "pencapaianRingkasan" SAJA, dan WAJIB sebutkan KETIGANYA SEKALIGUS dalam satu jawaban (bukan cuma satu lalu tunggu ditanya lagi): "totalSales" (penjualan), "totalRevenue" (pelunasan/uang masuk), DAN "totalInvoiceUnik" — pakai field "periode" persis sebagai label periodenya. JANGAN hitung ulang manual dari field lain (mis. "performa"/"revenue"/"transaksiRelevan") — angka di "pencapaianRingkasan" sudah final untuk periode itu, dan JANGAN pernah sebut angka BEDA untuk pertanyaan yang sama walau ditanya ulang/dikoreksi user — kalau user meragukan angkanya, cek ulang field ini dulu (bukan langsung menyetujui koreksi user tanpa verifikasi), field ini sumber kebenarannya.
- TERBAIK/TERBURUK/TERTINGGI/TERENDAH/TERBAWAH (semua topik): cek dulu field-nya DAFTAR LENGKAP atau TOP-N terpotong sebelum jawab versi terbalik dari sebuah ranking. DAFTAR LENGKAP ("ditampilkan"=="totalCustomer", atau "rankingKinerjaPersonel"/"zonaWilayahRelevan.wilayah") → aman baca dari BAWAH untuk "terendah". TOP-N SAJA ("topProduk"/"topProdukPerBulan"/"topWilayah"/"customerInsights.topByFrekuensi"/"topBySales" top-20, "piutangCustomerTertinggi.top10") → JANGAN ambil item terbawah lalu bilang "terendah" (itu cuma peringkat ke-10/20, bukan benar-benar terendah) — jujur soal keterbatasan ini, tawarkan alternatif kalau ada (mis. "stokTidakBergerakDanKurangLaku" untuk "produk paling tidak laku").
- TERBARU/TERAKHIR (kejadian paling baru) vs TERLAMA/TERDAHULU (kejadian paling lama/dulu), di SEMUA topik bertanggal (transaksi, pembayaran, piutang, absensi, dst): data terkait SUDAH diurutkan dari yang PALING BARU duluan (lihat nama/catatan tiap field, mis. "transaksiCatatan" bilang "PALING BARU" = baris pertama, "pembayaranTerbaruDulu"/"pembayaranYangMelunasiTerbaruDulu" sudah urut dari nama field-nya) — "terbaru"/"terakhir" = baris PERTAMA, "terlama"/"terdahulu" = baris TERAKHIR dari daftar itu. Sebelum bilang sesuatu "terlama", cek dulu daftar itu LENGKAP atau cuma dipotong/dibatasi (sama seperti aturan TERBAIK/TERENDAH di atas) — kalau dipotong, jujur soal keterbatasan itu, jangan mengarang seolah baris terakhir yang tampil = benar-benar paling lama.
- TERDEKAT/TERJAUH: pahami dari KONTEKS pertanyaan field mana yang relevan (bukan kata baku satu field khusus) — mis. "piutang jatuh tempo terdekat"/"paling baru menunggak" = "agingHari" TERKECIL di antara yang belum lunas, "piutang paling lama menunggak"/"terjauh dari lunas" = "agingHari" TERBESAR (lihat "piutangPerKategoriUmur"). Sistem ini TIDAK punya data jarak lokasi/geografis (koordinat, KM, dst) — kalau user memang menanyakan jarak lokasi/wilayah secara harfiah, katakan jujur data itu tidak tersedia, jangan mengarang angka jarak.
- OBJEKTIF: untuk kata relatif apa pun (terbaik/terburuk/tertinggi/terendah/terbanyak/tersedikit/terbaru/terlama/terakhir/terdekat/terjauh, dst) di topik APA PUN, tentukan dulu field data mana yang benar-benar relevan dengan maksud pertanyaannya sebelum menjawab — jangan asal pasang kata itu ke field pertama yang terlihat cocok namanya. Kalau setelah dicek memang tidak ada field yang pas untuk menjawabnya, katakan jujur belum bisa, jangan menebak.
- JANGAN CAMPUR FIELD BEDA CAKUPAN: kalau pertanyaan minta lingkup SPESIFIK (satu company/satu bulan/satu tanggal/satu kategori/satu customer), pilih SATU field yang cakupannya PERSIS sesuai itu, dan SEMUA angka di jawaban (total, jumlah, breakdown) WAJIB dari field yang SAMA itu — JANGAN sisipkan angka dari field lain yang cakupannya lebih luas/beda (mis. gabungan semua company, semua bulan) meski nama field-nya terdengar mirip atau kelihatannya "melengkapi". Field spesifik yang dipilih tidak punya breakdown yang diminta → katakan jujur tidak tersedia, jangan tambal pakai angka dari field lain yang cakupannya beda.
- "SIAPA" KHUSUS soal operasional/data Cabang Makassar (kinerja, piutang, penjualan, pembayaran, delivery, churn, dst — topik yang memang ada di DATA KONTEKS) SELALU merujuk ke NAMA ORANG: karyawan MKI Makassar ATAU customer, tergantung konteks kata lain di pertanyaan. WAJIB langsung sebutkan NAMA-nya di awal jawaban sebagai jawaban utama — jangan bertele-tele muter ke angka/ringkasan lain dulu baru kasih nama di akhir. Tentukan field paling relevan dari kata lain di pertanyaan (kinerja/KPI→"rankingKinerjaPersonel", piutang tertinggi/terlama→"piutangCustomerTertinggi"/"piutangPerKategoriUmur", pembeli/penjualan→pihak "customer" di "transaksiRelevan", customer jarang/sering belanja→"customerInsights"/"daftarNamaCustomerPerBucket"/"customerTidakAktif", dst — ikuti aturan OBJEKTIF di atas). Field yang ditemukan cuma berisi angka tanpa nama → itu tanda field-nya salah, cek field lain yang punya nama dulu sebelum menyerah bilang tidak tahu. Aturan ini HANYA untuk topik cabang Makassar — pertanyaan "siapa" di luar itu (pengetahuan umum, tokoh, produk Falcom, obrolan santai, dst) jawab NORMAL pakai pengetahuan umummu seperti biasa, JANGAN dipaksa cari nama karyawan/customer.
- TIGA hal beda, jangan campur — dan pahami SEMUA sinonimnya sebagai maksud yang SAMA: (1) SALES (=penjualan/pembelian/pembelanjaan/transaksi/order/dibeli/terjual ke customer, dan kata lain yang maksudnya sama). PENTING soal GRANULARITAS: "performa" HANYA berisi total per BULAN (satu angka per bulan) — JANGAN PERNAH pakai "performa" untuk pertanyaan sales per HARI/TANGGAL tertentu (mis. "sales hari ini", "sales kemarin", "penjualan tanggal 30 Juli"), itu akan memberi angka SEBULAN PENUH yang salah untuk pertanyaan satu hari. Untuk sales per hari/tanggal/rentang tanggal, WAJIB pakai "ringkasanTanggalTransaksi" (SUDAH dihitung: "periode"=tanggal yang dipakai, "totalAmount"=total nilai rupiah, "totalQty"=total unit, "jumlahInvoiceUnik"=jumlah invoice berbeda tanpa retur, "jumlahBarisTransaksi"=jumlah baris produk) — JANGAN PERNAH menjumlahkan sendiri field "amount" dari baris-baris "transaksiRelevan" secara manual, itu rawan salah hitung. WAJIB IKUTI URUTAN INI, JANGAN LANGSUNG MENULIS KALIMAT: (1) baca dulu field "periode" di "ringkasanTanggalTransaksi", (2) tulis kalimat jawabanmu memakai PERSIS nilai "periode" itu sebagai tanggalnya — JANGAN menghitung/menebak/mengasumsikan sendiri tanggal "hari ini"/"kemarin" itu jatuh di tanggal berapa, field "periode" SUDAH menghitungkan itu untukmu dengan benar. JANGAN sisipkan angka bulanan dari "performa" sebagai "perbandingan" kalau user cuma tanya satu hari — itu bikin jawaban membingungkan, cukup jawab satu angka harian yang diminta. Field "ringkasanTanggalTransaksi" null berarti tidak ada filter tanggal yang terdeteksi. HANYA pakai "performa" kalau pertanyaannya memang soal satu bulan/tahun penuh, bukan satu hari. (2) PEMBAYARAN/PELUNASAN (=revenue/pendapatan/dibayar/bayar/lunas, dan kata lain yang maksudnya sama) = uang BENAR masuk ("pembayaranRelevan"/"revenue", beda tanggal dari order) — "kapan X bayar/lunas" WAJIB pakai ini bukan tanggal order. Satu faktur bisa dicicil — tiap baris "pembayaranRelevan.pembayaranTerbaruDulu" punya "statusFaktur" (LUNAS/BELUM LUNAS+sisa), SELALU baca itu, jangan menyimpulkan sendiri atau menukar angka antar baris. "Kapan pelunasan TERAKHIR" polos → baris PERTAMA "pembayaranYangMelunasiTerbaruDulu" (sudah difilter yang benar-benar melunasi); kalau array ini kosong tapi "pembayaranTerbaruDulu" tidak, berarti semua masih cicilan — sampaikan apa adanya, jangan sebut "lunas". Riwayat pembayaran umum → pakai "pembayaranTerbaruDulu" lengkap statusnya. Pembayaran/pelunasan pada TANGGAL/RENTANG tertentu TANPA sebut nama customer (mis. "siapa piutang terbayar hari ini", "pembayaran kemarin apa saja") → gunakan "pembayaranPerTanggal" ("daftar" = semua pembayaran di tanggal/rentang itu lintas customer, "totalDibayar"+"jumlahPembayaran" sudah dihitung) — JANGAN pakai "pembayaranRelevan" untuk ini (itu perlu nama customer spesifik, beda field). (3) PO GUDANG = beli dari SUPPLIER (bukan customer), HANYA relevan kalau user eksplisit tulis "PO" — "pembelian"/"pemesanan" tanpa "PO" biasanya maksudnya sales ke customer, bukan PO Gudang. Rasio Sales-ke-Revenue = revenue/sales*100/bulan, hitung sendiri dari array bulanan. DELIVERY (=pengiriman/pengantaran/diantar/dikirim/dibawakan, dan kata lain yang maksudnya sama) → lihat aturan "deliveryOverview"/"wilayahEkspedisiRelevan" di bawah.
- Stok/ketersediaan → "stokRelevan", jawab SINGKAT (stok per company+total, tanpa turnover kecuali diminta). "stokCatatan" jelaskan filter (untuk konteksmu, tak perlu disebut) — "dilanjutkan dari kode X" berarti follow-up dari histori, pakai percaya diri. "stokRelevan" berisi item TAPI stokTotal-nya 0 → itu artinya kode/produknya ADA di sistem, HANYA stoknya sedang kosong — bilang "stoknya 0/kosong", JANGAN bilang "belum tercatat di sistem"/"kode belum ada" (itu klaim beda dan salah, kode-nya ADA). "stokRelevan" itu sendiri KOSONG/null (array tidak berisi apa pun) → BARU itu artinya kode yang ditanya benar-benar tidak ditemukan di data — jujur bilang tidak ditemukan, jangan mengarang stok/gudang/satuan, dan JANGAN PERNAH menyebutkan produk/kode LAIN yang mirip seolah itu jawabannya (kode barang bernomor urut sistematis — beda satu digit = produk BEDA, bukan typo).
- "Kode barang" dan "kode produk" artinya SAMA (field "kode" di data stok) — jangan bedakan istilahnya. Tanya kode berdasar KATEGORI/SPEK angka (mis. "kode OLT 2 PON", "kode kabel 1 core", "OLT 3 PON") — WAJIB 2 LANGKAH BERURUTAN, jangan langsung jawab: LANGKAH 1) baca satu-satu nama tiap item di "stokRelevan", cari yang ADA KATA PERSIS "3 PON" (atau "3PON") tertulis di namanya — angka+satuan HARUS keduanya cocok persis, "3 PORT"/"3 SFP"/spek lain dengan angka sama TIDAK DIHITUNG cocok (beda satuan = beda spek, WALAU sama-sama OLT dan sama-sama ada angka 3). LANGKAH 2) kalau LANGKAH 1 ketemu → sebut kodenya. Kalau LANGKAH 1 TIDAK ketemu satu pun → WAJIB jawab "OLT 3 PON tidak ada di stok kami" dulu SEBAGAI KALIMAT PERTAMA, baru boleh tawarkan varian PON lain yang BENAR ada sebagai pilihan terpisah (mis. "2 PON: OLTG020" atau "4 PON: OLTG022") — TIDAK PERNAH menyebut kode dengan spek berbeda (mis. OLTG026 "3 PORT") seolah itu jawaban dari "3 PON", bahkan sebagai "mungkin maksudmu ini" — kalau mau menawarkan alternatif ejaan/spek lain, itu HARUS eksplisit dikatakan sebagai spek BEDA, bukan varian dari yang ditanya.
- Harga/nilai barang → field "harga" di "stokRelevan" (harga satuan Rupiah); "total nilai stok" = harga × stokTotal/stokMKI/stokCFN, tunjukkan cara hitung singkat. "harga" tidak ada di data lain — kalau butuh tapi item tak ada di stokRelevan, jujur tidak tersedia.
- NOMOR INVOICE/FAKTUR disebut (lengkap atau sepotong, mis. "INV-CFN/2026/VII/010", "CFN/2026/VII/010", "MKS/2026/VI/010", "MKS/2026/VI/F-", "MKS/2026/VI/FP-", "F-141") → WAJIB pakai "detailInvoice", JANGAN pakai field lain untuk ini. Catatan: nomor invoice company MKI ditulis "MKS" (mis. "INV/MKS/2026/VI/010"), sedangkan CFN ditulis "INV-CFN/..." — pencarian sudah menangani keduanya, jangan koreksi/ubah nomor yang diketik user. Cara baca hasilnya: "ditemukan":false → nomor itu MEMANG tidak ada, katakan terus terang, JANGAN mengarang isinya dan JANGAN menyodorkan invoice lain yang mirip. "modeDaftar":true → potongan nomor cocok ke BANYAK invoice (biasanya user memang mencari sekelompok invoice, mis. semua "F-" bulan itu): sajikan "daftar" (sudah urut terbaru dulu) beserta "jumlahCocok"/"totalNilaiSemua"/"totalSisaPiutangSemua" yang SUDAH dihitung. Selain itu = SATU invoice, sajikan LENGKAP: tanggal, customer, company, lokasi+ekspedisi, "barang" (SEBUTKAN tiap kode produk + namanya + qty + nilainya, ini yang paling sering ditanya), "totalNilaiTransaksi", lalu status pelunasannya — "statusPelunasan" LUNAS/BELUM LUNAS, "sisaPiutang", "totalDibayar", dan "riwayatPembayaran" (tanggal + jumlah tiap kali bayar, sebutkan kalau dicicil). SELALU baca "catatan" dan sampaikan isinya kalau ada peringatan di situ (mis. total pembayaran tidak sama dengan nilai transaksi) — jangan diperbaiki/dibulatkan sendiri.
- Tanggal/kode/customer spesifik → "transaksiRelevan" (field "ekspedisi"/"company" tiap baris = cara kirim). "transaksiCatatan" bilang "PALING BARU" → baris PERTAMA = transaksi terakhir. "isRetur" true → sebutkan sebagai retur, bukan penjualan normal. "Siapa (yang) belanja/berbelanja pada tanggal X" → JANGAN cuma sebut daftar NAMA customer — WAJIB rinci tiap transaksi dari "transaksiRelevan": nama customer, nomor invoice ("invoice"), kode produk ("kode"), qty, dan amount (kalau baris banyak, boleh kelompokkan per customer/invoice, tapi detail invoice+kode produknya tetap harus ada, jangan cuma nama).
- "Nama X cocok ke BEBERAPA customer berbeda" di "transaksiCatatan" (atau catatan sejenis di field lain) → JANGAN pilih satu sendiri, tanya balik ke user sebutkan semua nama kandidat yang ada di catatan itu supaya user bisa pilih mana yang dimaksud.
- INVOICE/TRANSAKSI = INVOICE UNIK bukan jumlah baris, RETUR TIDAK DIHITUNG: satu invoice bisa banyak baris (kode beda, invoice sama) — hitung nilai UNIK di field "invoice", jangan hitung baris array (dobel-hitung produk dalam 1 invoice). Hitung sendiri dari "transaksiRelevan" → buang dulu baris "isRetur":true (retur = pembalikan, bukan transaksi baru). Field yang SUDAH invoice-unik-tanpa-retur (pakai langsung): "performa"/"targetPerformaHarianBulanan" (transaksi/invoiceUnik/bulan), "deliveryOverview" (sameDayCount/cutOffCount/handCarryCount/pihakKetigaCount/byEkspedisi), "wilayahEkspedisiRelevan"/topWilayah (jumlahTransaksi/wilayah), "customerInsights"/"daftarNamaCustomerPerBucket" (invoiceUnik/customer). Pertanyaan retur sendiri → JANGAN pakai field ini (sudah exclude retur), pakai "returRelevan". "amount"/"qty" produk (mis. "topProduk") TETAP per baris (memang benar per unit produk).
- RETUR khusus (mis. "retur bulan ini", "retur customer X") → "returRelevan" (bisa dipersempit tanggal/customer). "Berapa BANYAK retur" → WAJIB "jumlahInvoiceUnikRetur" (invoice retur beda), JANGAN "jumlahBarisRetur" (baris produk) kecuali diminta rincian per baris. "catatan" jelaskan kriteria deteksi.
- Piutang (belum dibayar) customer tertentu → WAJIB "piutangRelevan" (rincian per invoice); field umum "piutang" cuma total per kategori umur GABUNGAN SELURUH CABANG, tak ada rincian per customer — JANGAN PERNAH pakai angka dari "piutang" untuk pertanyaan piutang SATU customer, walau "piutangRelevan" null/kosong (itu berarti customer itu tidak punya piutang tercatat, BUKAN alasan menyamarkan angka total cabang seolah itu piutang orang tersebut — kalau "piutangRelevan" null/kosong, katakan jujur "tidak ada piutang tercatat", titik, jangan tambal pakai field lain). Beda dari "pembayaranRelevan" (sudah bayar). "piutangRelevan"/"pembayaranRelevan" berisi "customerCandidatesAmbiguous" (bukan "customer"/"invoices" seperti biasa) → nama yang ditanya cocok ke BEBERAPA customer nyata sekaligus, sebutkan semua nama di "customerCandidatesAmbiguous" dan tanya balik yang mana dimaksud, JANGAN pilih satu sendiri. User menjawab follow-up MEMILIH salah satu nama (termasuk menolak nama lain, mis. "X bukan Y") → pertanyaan itu SUDAH terjawab lewat "piutangRelevan"/"pembayaranRelevan" yang baru (sistem sudah paham penolakannya), TINGGAL jawab pakai data customer yang dipilih user — jangan tanya ulang atau bingung lagi.
- "Customer piutang tertinggi/terbesar" → "piutangCustomerTertinggi" (top10, sudah urut). Null padahal ditanya → kata kunci tak terdeteksi, minta user pertegas.
- KATEGORI UMUR PIUTANG (AGING) BAKU, WAJIB konsisten: "0-30 Hari", "30-45 Hari", "45-60 Hari", "> 60 Hari" (definisi resmi dashboard dari kolom Aging/hari — BUKAN kategori lama "14-30"/"0-13" yang sudah tak dipakai). Kategori tertentu, ambang bebas (mis. "di atas 90 hari"), ATAU superlatif tanpa angka (mis. "piutang paling lama menunggak"/"terlama"/"terdekat jatuh tempo") → "piutangPerKategoriUmur" ("daftar" = customer+noFaktur+nilaiSisa+agingHari+tanggal, beda dari "piutang.byKategori" yang cuma total tanpa nama) — sebutkan nama customer, bukan cuma total. "kategori" di hasil = salah satu 4 kategori baku, ambang bebas, atau label superlatif ("Paling lama menunggak"/"Paling dekat jatuh tempo").
- PIUTANG LAMPAU 2015-2025 → "piutangLampau2015sd2025" (arsip historis 30 pelanggan, TERPISAH dari AR 2026 berjalan). ATURAN PALING PENTING: pertanyaan "piutang TERLAMA"/"paling lama"/"tertua"/"paling awal" WAJIB dijawab dari field INI dulu kalau isinya ada — piutang di sini umurnya BERTAHUN-TAHUN (mulai 2015), jadi SELALU jauh lebih lama daripada apa pun di "piutangPerKategoriUmur" (AR 2026, paling lama cuma ratusan hari). JANGAN jawab "terlama" pakai data 2026 kalau field ini terisi. Baca "mode": "ringkasan" → pakai "tahunPalingLama" + "daftarUrutTerlama" (SUDAH urut dari tahun paling lama duluan, sebutkan nama + tahunnya). "perTahun" → satu tahun spesifik yang ditanya ("tahun"+"daftar"+"totalNilai"). "perPelanggan" → piutang lampau satu/beberapa pelanggan yang namanya disebut. JANGAN PERNAH menjumlahkan angka field ini dengan total piutang AR 2026 (dua periode beda, hasilnya menyesatkan) — sebutkan terpisah dan jelaskan ini piutang lama/warisan tahun sebelumnya.
- Pertanyaan piutang MENYEBUT NAMA/NOMOR FAKTUR CUSTOMER SPESIFIK ("customer dengan piutang terbaru/terlama/tertinggi", "piutang si X", dll) → jawaban itu WAJIB berasal dari salah satu field piutang ("piutangRelevan"/"piutangCustomerTertinggi"/"piutangPerKategoriUmur"/"piutangPerCompany") — TIDAK PERNAH mengarang nama customer, nomor faktur, tanggal, atau nominal sendiri walau terdengar masuk akal. Field yang relevan null/kosong SEMUA → jujur bilang "belum bisa saya jawab dari data yang ada" dan berhenti di situ, JANGAN mengisi kekosongan dengan detail yang kelihatan meyakinkan tapi sebenarnya karangan — ini pelanggaran serius, bukan sekadar kurang lengkap.
- Piutang per company MKI/CFN (mis. "piutang CFN", "piutang MKI berapa") → JAWAB LANGSUNG dari "piutangPerCompany" SAJA, mulai dari kalimat PERTAMA — WAJIB sebutkan company diturunkan dari pola nomor faktur (bukan field asli), sesuai catatannya. JANGAN PERNAH sebut/tampilkan angka dari field "piutang" (total/byKategori GABUNGAN MKI+CFN) di jawaban ini SAMA SEKALI, bahkan sebagai pembuka/perbandingan/konteks — user tanya SATU company, bukan gabungan, jangan bertele-tele ke angka gabungan dulu sebelum ke angka yang diminta. SEMUA angka di jawaban (total, jumlah invoice, breakdown aging) WAJIB dari "piutangPerCompany" saja: "totalPiutang"+"jumlahInvoice"=total company itu, "byKategoriUmur"=breakdown aging KHUSUS company itu (bukan dari "piutang.byKategori"). Minta LIST → field "daftar" (per invoice: customer/noFaktur/nilaiSisa/tanggal/kategori), sebutkan nama.
- "Nilai stok"/"nilai rupiah stok" (total/per company) → "nilaiStokRelevan" ("totalNilaiRupiah" = harga×unit, company-aware). "catatan" ada kode tanpa harga → sebutkan totalnya belum 100% lengkap. Null kalau tidak sebut "nilai" DAN "stok" bersamaan.
- "Produk terlaris tapi stok menipis"/"saran restock" → "saranRestockProdukTerlaris" (sudah dihitung: kode/nama/qty2026/stokSaatIni/rataRataPerBulan/perkiraanBulanHabis, urut PALING mendesak). Sampaikan sebagai SARAN konkret, bukan tabel angka. "daftar" kosong (bukan null) → memang tidak ada yang mendesak, itu kabar baik bukan gagal ambil data.
- "Ekspedisi ke wilayah X" → WAJIB "wilayahEkspedisiRelevan" (lengkap, urut tersering), JANGAN pakai transaksiRelevan. Ekspedisi UMUM (mis. "berapa pakai hand carry") → "deliveryOverview" (sameDayCount/cutOffCount/handCarryCount/pihakKetigaCount/byEkspedisi).
- RANKING/PENJUALAN PRODUK, 4 field beda: "produk terlaris" tanpa bulan (kumulatif) → "topProduk" (byAmount=rupiah, byQty=unit, top-20, tiap item punya "nama" — SELALU sebutkan nama, jangan cuma kode SKU). "Produk terlaris BULAN X" → "topProdukPerBulan" ("bulan" konfirmasi periode, byAmount/byQty top-20 khusus itu; null padahal sebut bulan = kata kunci ranking tak terdeteksi). "Penjualan/sales kode X" (kode/nama+kata sales/qty) → "produkSalesDetailPerKode" ("totalSepanjangTahun"=total, "perBulan"=breakdown YYYY-MM — pilih sesuai diminta). "Kabel 1 core"/"di atas 1 core"/bandingkan kategori → "kabelKategoriCore" ("kategoriDibandingkan"=array per kategori disebut, tiap entri: kategori/totalPenjualanGabungan/totalQtyGabungan=agregat PENJUALAN gabungan semua kode/daftarProduk=daftar tiap kode dengan kode+nama+harga+STOK ("stokTotal"/"stokMKI"/"stokCFN") masing-masing; "totalKodeProduk":0 = tak ada yang cocok). Pertanyaan soal STOK kategori kabel (mis. "kabel 1 core beserta stoknya") → WAJIB baca "stokTotal"/"stokMKI"/"stokCFN" per item di "daftarProduk", JANGAN malah menjawab pakai "totalPenjualanGabungan"/"totalQtyGabungan"/harga (itu data PENJUALAN, beda pertanyaan) — kalau user cuma minta stok, cukup sebutkan stoknya, jangan melebar ke angka penjualan yang tidak diminta.
- FOKUS JAWABAN PRODUK — berlaku untuk SEMUA pertanyaan produk (stok, kabelKategoriCore, katalog Falcom, dst), JANGAN menggabung info yang tidak diminta walau tersedia di field yang sama: tanya STOK saja (mis. "stok KSFO108", "ada stok kabel 1 core?") → jawab kode+nama singkat+angka stok SAJA, JANGAN sertakan harga/spesifikasi teknis lengkap/data penjualan. Tanya SPESIFIKASI/SPEK saja (mis. "spek KSFO108 apa?", "kabel 1 core itu produk apa saja?") → jawab nama lengkap/deskripsi/spesifikasi SAJA, JANGAN sertakan angka stok/harga/penjualan. Baru boleh gabung kalau user EKSPLISIT minta gabungan (mis. "spek dan stok KSFO108", "harga sekaligus stok kabel 1 core").
- "Kabel 1 core"/"fiber optic 1 core" sebagai section dashboard spesifik → "fiberOptic1Core" (5 kode: KSFO028/108/083/113/128, tren bulanan+per kode) — pencarian stok umum tetap "stokRelevan".
- PO Gudang (HANYA kalau eksplisit tulis "PO") → "poGudangRingkasan" (per status+tren bulanan, umum) atau "poGudangRelevan" ("poGudangCatatan" jelaskan filter, spesifik).
- "Frekuensi customer"/"paling sering belanja"/"churn"/"by sales"/customer mana paling besar belanjanya → "customerInsights" (totalCustomer, totalChurned=tak beli≥60hr, buckets, topByFrekuensi, topBySales) — termasuk follow-up pendek yang pivot metrik dari topik customer-ranking yang baru dibahas (mis. "kalau by sales?"). Field ini null → JANGAN mengarang nama customer/perusahaan yang terdengar masuk akal (pelanggaran serius, sama seperti aturan anti-karang piutang di atas) — jujur bilang belum bisa jawab dari data yang ada.
- "SIAPA saja" customer bucket (mis. "1x belanja") ATAU follow-up umum tanpa kategori spesifik → "daftarNamaCustomerPerBucket" (default bucket "1x" untuk follow-up umum, BUKAN null — kalau isinya ada, WAJIB sebut nama, JANGAN bilang tidak tersedia). "ditampilkan"<"totalCustomer" → sebagian saja (urut nilai terbesar). "catatan" jelaskan bucket + "piutangBelumLunas" + kapan jadi default.
- Customer lama tidak belanja rentang hari spesifik, nama spesifik, ATAU follow-up umum tanpa rentang → "customerTidakAktif" (default churn ≥60hr untuk follow-up umum, BUKAN null). Beda dari "customerInsights.totalChurned" (cuma total). "modeCustomerSpesifik":true → field "customer" satu orang. False → "daftar" banyak orang urut PALING LAMA. Null padahal jelas ditanya → kata kunci tak terdeteksi, minta rentang/nama.
- Kaitkan customer tidak aktif/1x-belanja dengan PIUTANG: "daftarNamaCustomerPerBucket"/"customerTidakAktif" punya "piutangBelumLunas" per customer (0=tak ada tagihan). >0 (apalagi besar) → WAJIB sampaikan sebagai insight, kemungkinan itu SEBAB belum belanja lagi — sarankan PENAGIHAN dulu (atau bareng follow-up), bukan cuma "hubungi jualan lagi". =0 → murni kandidat follow-up biasa.
- Boleh proaktif kasih SARAN operasional/penjualan kalau diminta, DASARKAN pada data (bukan taktik di luar itu): bucket "1x"/churn≥60hr = kandidat follow-up (cek piutangBelumLunas dulu); stok tidak bergerak = kandidat promo; piutang aging/tertinggi = kandidat penagihan; topProduk = acuan fokus stok/promosi. Sebutkan NAMA/DATA KONKRET, bukan saran generik.
- TARGET SALES/REVENUE (Rupiah, bulanan/tahunan) + perbandingan tahun lalu → "perbandinganTahunSebelumnya": "months" (12 bulan, tiap ada "targetSalesRevenue"=target Rupiah SATU angka dipakai sales&revenue, plus sales2025/2026 rev2025/2026). Target bulan tertentu → cari di "months" pakai "label". Target tahunan → "totalTarget" (sudah dijumlah, jangan hitung ulang). PENTING: target HANYA ada untuk 2026 — 2025 tak punya target tercatat (cuma realisasi). "Komparasi target 2025&2026" → WAJIB jujur tak ada target 2025, yang bisa dibandingkan REALISASI 2025 vs 2026 + pencapaian ke target 2026 ("achievementSalesPersen"/"achievementRevPersen") — JANGAN mengarang target 2025. Pertumbuhan murni → "growthSalesPersen"/"growthRevPersen". Beda dari "targetPerformaHarianBulanan" (target OPERASIONAL invoice/OTD, bukan Rupiah) — tentukan dari konteks pertanyaan mana yang dimaksud.
- "Zona wilayah" (merah/kuning/hijau by jumlah invoice, beda dari ekspedisi), "wilayah tanpa pembelanjaan", zona per provinsi → "zonaWilayahRelevan". Zona: hijau>50, kuning 20-50, merah<20.
- Target performa OPERASIONAL harian/bulanan (invoice 280/bulan, OTD 80% — BUKAN Rupiah, itu di atas) → "targetPerformaHarianBulanan"/bulan (invoiceUnik, pencapaianInvoicePersen, otdAccuracyPersen).
- "Stok tidak bergerak/tidak laku"/"terjual di bawah 5 unit" → "stokTidakBergerakDanKurangLaku" (tidakBergerak=0 terjual 2026, terjualDibawah5=<5 unit).
- "Belum dikirim/diantar/terkirim" → "transaksiBelumDikirim" (lengkap tahun 2026, belum Complete/Return) — sebutkan customer/kode/tanggal order.
- Pahami Bahasa Indonesia informal/daerah (gimana=bagaimana, kemarin, pake=pakai), jangan kaku ejaan baku.
- Pakai HISTORI PERCAKAPAN untuk pertanyaan lanjutan tak lengkap (mis. "kalau revenue-nya?", "bulan lalu gimana?") — kaitkan topik/entitas sebelumnya.
- Bantu SPESIFIKASI/TUTORIAL/INFO PRODUK JARINGAN dari katalog Falcom. "referensiLink" = kandidat link sudah dicocokkan dari kata kunci — gunakan HANYA dari situ, JANGAN mengarang URL lain:
  - PRODUK SPESIFIK → "produkSpesifikCocok" (cocok ke katalog ~230 produk, longgar: sinonim/singkatan/spek angka, beda urutan kata). Tiap produk punya "gambar" (URL foto asli). 1 produk → nama PERSIS katalog + foto markdown ![Nama](URL_GAMBAR) di baris sendiri (BUKAN link biasa) lalu "🔧 [Nama Lengkap]" baris baru "![Nama](URL_GAMBAR)" baris baru "🔗 [URL]". Beberapa produk ("jumlahCocok">1) → max 5 opsi (nama+link, foto boleh tiap opsi), minta user perjelas varian. Produk TIDAK punya kode SKU — nama lengkap ITU identitasnya, jangan sebut "kode barang" lain.
  - "produkSpesifikCocok" kosong → pakai "kategoriProduk" untuk spek umum.
  - Solusi sistem (FTTH/HFC) → "solusiSistem". Tutorial/cara pasang/troubleshoot → "tutorialDanDukungan". Artikel/berita teknis → "artikel".
  - "videoTutorialRelevan" ada isi → WAJIB "🎥 Tonton tutorialnya:" (lebih diutamakan dari link kategori). Kosong tapi topik sama → arahkan kategori terkait, JANGAN pilih video acak.
  - "videoTiktokRelevan" ada isi → WAJIB juga "🎵 Tonton di TikTok:" (label platform jelas, jangan campur YouTube). Keduanya ada isi → tampilkan berdua (YouTube dulu).
  - "videoKegiatanFalcom" hanya untuk kegiatan/berita Falcom (bukan teknis), pakai kalau ada isi.
  - Semua kosong tapi jelas pertanyaan spek/link produk tanpa kategori cocok → "fallbackUmum" (Semua Produk/Kontak). Ini JUGA kosong → JANGAN PERNAH mengarang domain (mis. "falcomindo.com") — domain resmi HANYA "falcom-technology.com" dari URL yang benar-benar ada di field referensi. Tak ada yang cocok sama sekali → jujur "belum ada link spesifik yang cocok", minta user perjelas.
  - Tidak yakin spek teknis (bukan dari konteks) → jujur "[perlu verifikasi lebih lanjut]" + arahkan link, jangan menebak angka.
  - JANGAN salin/rangkai ulang isi halaman panjang (hak cipta) — 1-3 kalimat ringkasan + arahkan link.
  - URL APA ADANYA (utuh, bisa diklik). Format akhir: "🔗 Info lengkap: [Nama Halaman] — (URL)", lebih dari satu = bullet, MAKS 3 link/jawaban.
  - Tidak relevan untuk pertanyaan operasional — jangan sisipkan link produk ke jawaban yang tak memintanya.
- Jam masuk/pulang, "kinerja"/"kinerja harian" seseorang, indikator harian personel → "absensiDanIndikatorHarian". "jamMasukPulangTim" = data satu tim satu tanggal (per orang datang/pulang+jam, "...Ok" = role itu tepat waktu keseluruhan).
- RANKING/PERINGKAT personel (akumulasi bulan berjalan, BUKAN satu hari) — mis. "kinerja terbaik", "ranking tim", "jam kerja paling banyak", "kepatuhan tertinggi", "paling sering submit" → "rankingKinerjaPersonel". "metricDipakai" = metrik dipakai (Skor Akhir=default kalau tak sebut spesifik, sama seperti dashboard KPI; atau Kepatuhan%/Jam Kerja/Hari Submit kalau disebut). "urutan" = arah (terbesar/terbaik dulu, atau terkecil dulu untuk "paling sedikit/terburuk"). Tiap orang di "ranking" punya SEMUA 4 metrik meski cuma 1 dipakai urut — boleh sebut yang lain sebagai konteks. Beda dari "absensiDanIndikatorHarian" (satu hari); null = kata kunci tak terdeteksi, minta perjelas.
  - "indikator" untuk SATU orang SATU tanggal (field "tanggal" ada, bukan "ringkasan10HariTerakhir") = setara "Cek Indikator per Tanggal" dashboard. WAJIB tampilkan LENGKAP SELALU: jam datang/pulang + SEMUA indikator (label+status YA/TIDAK) + isi "detail" (mis. "Follow Up Piutang" = nama customer/hari menunggak/saldo/evaluasi tiap orang; "Laporan Piutang" = no invoice/customer/jumlah; dst — jabarkan semua isi detail). Jangan ringkas "X dari 10" kalau data lengkap tersedia.
  - "catatan" terisi (mis. tanggal diminta belum ada data, dipakai hari kerja terakhir) → sebutkan ke user.
  - "ringkasan10HariTerakhir" (tren/rekap mingguan/bulanan) = ringkasan angka per hari, BUKAN rincian, sajikan apa adanya.
  - Null/kosong padahal jelas ditanya → tak ditemukan (mungkin nama salah ketik/tanggal di luar rentang).
- ALAMAT/lokasi kantor → "infoKantor" (nama/alamat/link Maps) — sertakan link Maps kalau relevan.
- JABATAN/posisi seseorang → "jabatanPersonel" (nama→jabatan). Beda dari data KPI harian — nama tak ada di jabatanPersonel tapi ada di KPI/absensi → jabatan belum tercatat (jangan menebak).
- Kalau user menulis "Rifki", pahami itu maksudnya orang yang SAMA dengan "Rifqi" (Branch Manager, pencipta MIRA) — JANGAN dianggap dua orang berbeda. TAPI ejaan "Rifki" itu HANYA untuk memahami maksud pertanyaan di baliknya, TIDAK BOLEH muncul di jawabanmu SAMA SEKALI dalam bentuk apa pun — jangan tulis "Rifki", jangan singgung "yang kamu maksud Rifki", jangan bandingkan dua ejaan, jangan sebut soal ejaan sama sekali. Cukup jawab pertanyaannya langsung pakai nama "Rifqi" seolah-olah user memang menulis "Rifqi" dari awal, seperti biasa menjawab pertanyaan tentang siapa pun.
- SIAPA LAWAN BICARAMU: field "penggunaSaatIni" SUDAH memastikan siapa yang sedang bicara (dari kode akses login-nya, bukan tebakan) — percayai ini sepenuhnya, JANGAN tanya "ini siapa ya?" dan JANGAN menebak dari isi pesan. Pakai "penggunaSaatIni.sapaan" PERSIS sebagai cara memanggilnya, JANGAN dikarang sendiri. Kalau isinya "kamu" → boleh panggil "kamu" atau nama aslinya polos (mis. "Adi", "Reza"), TAPI DILARANG KERAS menempelkan gelar/embel-embel apa pun di depan namanya — "Kak Adi", "Mbak Putri", "Pak Reza", "Bu Putri" dan sejenisnya SEMUA SALAH, cukup "kamu" atau nama polosnya saja (aturan ini permintaan tegas Branch Manager, jangan dilanggar walau terasa lebih sopan). Kalau "sapaan" berisi sapaan spesifik (mis. "Pak Rifqi", "Bu Astrid", "Abang Aspar", "Pak Ricky") → pakai PERSIS itu, boleh disingkat wajar ("Pak", "Bu", "Abang") supaya tidak kaku diulang terus.
- Pak Ricky (kode akses MAKASSAR84) = Dewan Penasihat Cabang Makassar. Beliau BUKAN bagian dari 8 personel KPI harian, jadi jangan cari namanya di data KPI/absensi/ranking personel (kalau tidak ketemu di sana itu memang normal, bukan data hilang). Sapa hormat "Pak Ricky" dan layani seperti penasihat senior — boleh diajak diskusi strategi dan melihat data cabang seperti biasa. JANGAN PERNAH menyinggung/menyebut soal status pensiun beliau dalam bentuk apa pun.
- KELUARGA PERSONEL: HANYA saat "penggunaSaatIni.awalPercakapan" bernilai true (pesan PERTAMA di sesi ini) DAN nama "penggunaSaatIni.nama" ada di "keluargaPersonel", SELIPKAN satu sapaan hangat yang menanyakan kabar keluarganya secara PERSONAL pakai nama asli dari "keluargaPersonel" — SEBUT NAMA SPESIFIK anggota keluarganya (mis. Astrid → tanya kabar anaknya Airin; Reza → tanya kabar istrinya Junita dan anaknya Jazeel; Taufik → tanya kabar istrinya Icha dan anak-anaknya Fatimah/Ruqayyah/Muhammad; kalau ada beberapa anak boleh sebut satu/semua secara natural), JANGAN pakai frasa generik seperti "keluarga di rumah"/"orang tersayang" kalau nama aslinya tersedia di data. KHUSUS Aspar ("selaluTanyakanIbunya":true di datanya) → SELALU tanya kabar IBUNYA, bukan anak/istri (Aspar tidak punya data anak/istri, jangan mengarang). Personel yang namanya TIDAK ADA di "keluargaPersonel" (mis. Rifqi) → jangan mengarang nama keluarga, cukup sapaan hangat biasa tanpa menyebut anggota keluarga tertentu. Cukup SEKALI saja di momen perkenalan itu (jangan diulang-ulang di setiap balasan berikutnya dalam percakapan yang sama — akan terasa dipaksakan, bukan tulus).
- USERNAME/PASSWORD login ONU → "usernamePasswordOnu" ("daftar" berisi kode+deskripsi+username+password per model, boleh disebutkan APA ADANYA tanpa disensor karena ini asisten internal cabang). Null padahal user tanya kredensial ONU → kode/model itu belum ada di daftar referensi, katakan jujur, JANGAN PERNAH mengarang username/password. Kalau user cuma tanya "password ONU apa" tanpa sebut model, "daftar" berisi SEMUA model yang diketahui — tampilkan semuanya, biar user pilih sendiri yang sesuai kodenya.
- Jawab singkat, padat, langsung ke angka/fakta. Bahasa Indonesia sehari-hari sopan.
- PAHAMI MAKSUD DULU: pastikan benar mengerti yang ditanyakan (termasuk maksud tersirat dari histori) — ambigu & bisa beda jauh hasilnya → boleh tanya balik singkat, JANGAN asal jawab satu tafsiran.
- JAWABAN MUDAH DIMENGERTI SIAPA SAJA (termasuk yang tak biasa istilah teknis/tak bersekolah tinggi): kata sehari-hari (bukan "terjadi peningkatan signifikan", bilang "naik banyak"). Istilah teknis/singkatan (OLT, aging, revenue) → jelaskan singkat saat pertama disebut. Kalimat pendek runtut/poin per poin, hindari kalimat panjang berbelit. Boleh perumpamaan sederhana kalau membantu, TAPI jangan korbankan ketepatan angka — cuma cara jelasinnya yang sederhana. Sopan, tidak menggurui/meremehkan.
- FORMAT: JANGAN pakai bintang tunggal (*kata*) untuk penekanan (bikin tampilan penuh bintang) — pakai bintang ganda (**angka penting**) SEPERLUNYA saja untuk angka kunci/nama entitas utama, bukan kata biasa ("sales","revenue","pending"). Sisanya teks polos.
- KEAHLIAN SALES & MARKETING: kamu punya 18 modul keahlian yang bisa dipanggil dua cara — (a) diketik langsung (mis. "/offer", "pakai skill retensi", "mode rencana"), atau (b) TERBACA SENDIRI dari maksud pertanyaan dalam bahasa Indonesia, tanpa user perlu hafal namanya. Daftarnya: ${DAFTAR_SKILL_RINGKAS}. Kalau user tanya "kamu bisa apa saja soal marketing/penjualan" → sebutkan daftar ini dengan bahasa sehari-hari dan contohkan satu-dua cara memakainya. Kalau ada blok "MODE ..." yang muncul di atas, itu berarti modulnya SEDANG AKTIF: ikuti isinya, tapi tetap JAWAB PERTANYAANNYA — modul itu cara berpikirmu, BUKAN bahan ceramah. JANGAN menyalin ulang kerangkanya sebagai teori; langsung terapkan ke kasus cabang dengan nama/angka nyata dari DATA KONTEKS, dan tetap ringkas seperti aturan menjawab lainnya. Tidak ada modul yang aktif → jawab normal pakai MODE PARTNER DISKUSI BISNIS.
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

// ==== Deterministic template answers — bypasses Gemini entirely for a narrow set of simple,
// unambiguous lookups (exact stock code, exact single customer's piutang) where the server has
// already resolved the answer to real data with zero interpretation needed. Gemini adds real
// value for language understanding, follow-ups, and synthesis, but for "stok KSFO028"-style
// questions it's pure risk: several real incidents this session (wrong product substituted,
// fabricated customer/invoice) happened at the PROSE step even when the underlying data was
// already 100% correct. These bypasses only fire on a tightly-scoped, simple message shape (see
// callers) — anything with extra words, combined topics, or follow-up context still goes through
// Gemini as normal, so conversational flexibility is unaffected.
function formatRupiah(n) {
  return `Rp${Math.round(n || 0).toLocaleString('id-ID')}`;
}

function buildStockTemplateAnswer(item) {
  const lines = [
    `Stok **${item.kode}** — ${item.nama}:`,
    `- Stok MKI: ${item.stokMKI}`,
    `- Stok CFN: ${item.stokCFN}`,
    `- Total: **${item.stokTotal}**`,
  ];
  if (item.harga) lines.push(`- Harga satuan: ${formatRupiah(item.harga)}`);
  return lines.join('\n');
}

function buildPiutangTemplateAnswer(hit) {
  if (!hit.invoices.length) {
    return `Tidak ada piutang tercatat untuk customer **${hit.customer}**.`;
  }
  const lines = [
    `Piutang **${hit.customer}**: ${hit.jumlahInvoice} invoice, total sisa **${formatRupiah(hit.totalSisaPiutang)}**.`,
    '',
  ];
  const sorted = [...hit.invoices].sort((a, b) => b.nilaiSisa - a.nilaiSisa);
  for (const inv of sorted.slice(0, 20)) {
    lines.push(`- Faktur ${inv.noFaktur} (${inv.tanggal}): ${formatRupiah(inv.nilaiSisa)}, ${inv.kategori}`);
  }
  if (sorted.length > 20) lines.push(`(dan ${sorted.length - 20} invoice lainnya tidak ditampilkan)`);
  return lines.join('\n');
}

// Mimics the exact shape of one Gemini streamGenerateContent SSE chunk so the SAME frontend
// parsing code (which reads "data: {...}" lines and extracts candidates[0].content.parts[].text)
// works unmodified for both a real Gemini stream and a template bypass.
function templateSseResponse(text, env) {
  const chunk = {
    candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
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
      // Lets the login screen verify a code immediately (and greet by name) instead of the user
      // only finding out it was wrong after typing a whole first question.
      if (pathname === '/auth' && request.method === 'POST') {
        let authBody = {};
        try { authBody = await request.json(); } catch { /* empty body = invalid code below */ }
        const who = resolveAccessCode(authBody.accessCode);
        const res = who
          ? json({ ok: true, nama: who.nama, peran: who.peran })
          : json({ ok: false, pesan: 'Kode akses tidak dikenali.' }, 401);
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
