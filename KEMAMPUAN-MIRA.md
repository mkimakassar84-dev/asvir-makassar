# Kemampuan MIRA — Catatan Resmi

Dokumen ini mencatat **apa saja yang bisa MIRA lakukan** dan **keputusan penting di baliknya**.
Tujuannya supaya kemampuan MIRA tidak hilang atau berubah tanpa sengaja saat ada perubahan
berikutnya.

> **Sebelum mengubah `worker.js`, jalankan:** `node test-mira.js`
> **Sesudah mengubah, jalankan lagi.** Kalau ada yang GAGAL, itu berarti sebuah kemampuan yang
> dulu pernah rusak dan sudah diperbaiki, kini rusak lagi. Jangan deploy sebelum hijau.

---

## 1. Cara MIRA bekerja (ringkas)

```
Pertanyaan  ->  [Gerbang kode akses]  ->  [32 fungsi pencari data]  ->  Gemini  ->  Jawaban
                                                   |
                                          hanya data yang RELEVAN
                                          yang dikirim, bukan semua
```

Dua hal penting:

1. **Yang menentukan benar/salahnya jawaban adalah lapisan pencari data**, bukan Gemini. Kalau
   data yang tepat tidak ikut terkirim, Gemini cenderung mengarang untuk menutupi kekosongan.
   Ini penyebab hampir semua kesalahan yang pernah dilaporkan.
2. **Pertanyaan stok per kode dan piutang per nama dijawab tanpa Gemini sama sekali** (jalur
   template). Untuk dua hal itu, kesalahan penyampaian secara struktural mustahil.

---

## 2. Daftar kemampuan

### Penjualan & Pendapatan
| Bisa ditanya | Contoh |
|---|---|
| Sales/revenue per hari, tanggal, rentang, bulan, tahun | "sales kemarin", "revenue 4 Agustus" |
| Pencapaian gabungan (sales + revenue + invoice unik sekaligus) | "pencapaian Agustus", "pencapaian 2026" |
| Sisa target (sales, revenue, invoice unik) | "sisa target bulan ini", "sisa target tahunan" |
| Performa satu periode | "performa Mei-Juli", "performa sejak April sampai hari ini" |
| Perbandingan dua periode + persentase | "perbandingan penjualan Maret dan Juni" |
| Perbandingan dengan tahun lalu | "sales 2025 vs 2026", "Juli 2025 vs Juli 2026" |
| Semua di atas dipisah per company | "sales MKI bulan ini", "revenue CFN hari ini" |

### Piutang
| Bisa ditanya | Contoh |
|---|---|
| Total, per kategori umur, per customer, per company | "piutang CFN", "piutang Fatum" |
| Customer piutang tertinggi / paling lama menunggak | "siapa piutang terlama" |
| Piutang lampau 2015-2025 (arsip statis, 30 pelanggan) | "piutang terlama", "piutang tahun 2017" |
| Cek duplikasi faktur | "cek duplikasi piutang" |

### Produk & Stok
| Bisa ditanya | Contoh |
|---|---|
| Stok per kode (jalur tanpa Gemini) | "stok KSFO028" |
| Stok per kategori/nama | "stok OLT", "kabel 1 core", "splicer" |
| Produk terlaris kumulatif / per bulan | "produk terlaris Juli" |
| Penjualan beberapa kode sekaligus + per bulan | "bandingkan KSFO113 dan KSFO128" |
| Nilai rupiah stok, saran restock, stok tidak bergerak | "saran restock" |
| Katalog Falcom: spesifikasi, foto, tutorial | "ODP 8 core" |
| Username/password default 6 model ONU | "password ONU FL327D" |

### Invoice & Transaksi
| Bisa ditanya | Contoh |
|---|---|
| Detail satu invoice: isi barang + status pelunasan | "CFN/2026/VII/010" |
| Pencarian sebagian nomor / satu seri | "MKS/2026/VI/F-" |
| Siapa belanja pada tanggal tertentu (rinci per invoice+produk) | "siapa belanja 5 Januari" |
| Tanggal boleh ditulis angka | "siapa belanja tanggal 5/8/2026" |
| Retur | "retur bulan ini" |

### Customer
| Bisa ditanya | Contoh |
|---|---|
| Jumlah customer unik | "berapa jumlah customer kita" |
| Customer aktif per periode + persentase | "persentase customer aktif sejak Mei" |
| Frekuensi belanja, churn, customer tidak aktif | "customer yang sudah lama tidak berbelanja" |
| Riwayat belanja & pembayaran per customer | "pembelanjaan Delta Sky Tech" |

### Operasional lain
Wilayah & zona (per wilayah maupun **ringkasan sebaran seluruh zona**), delivery & ekspedisi,
PO Gudang, KPI personel & absensi, jabatan, alamat kantor, jam & tanggal sekarang (WITA).

### Non-operasional
Diskusi strategi berbasis data, analisis akar masalah, "dewan penasihat" multi-sudut-pandang,
grafik, dan obrolan biasa.

---

## 3. Keputusan yang TIDAK BOLEH diubah tanpa alasan kuat

Masing-masing lahir dari kesalahan nyata yang dilaporkan. Semuanya dijaga oleh `test-mira.js`.

| Aturan | Kenapa | Kalau dilanggar |
|---|---|---|
| **Kode barang harus cocok PERSIS** — tanpa toleransi typo | KSFO028 dan KSFO020 sama-sama produk asli, beda 1 digit | Ditanya satu produk, dijawab produk lain |
| **Company piutang dibaca dari kolom asli**, bukan ditebak dari nomor faktur | Ada faktur bernomor CFN yang company-nya MKI | Pembagian MKI/CFN meleset |
| **Semua kode yang disebut harus dikembalikan** | Dulu hanya kode pertama yang diambil | "Kode kedua tidak punya data" — padahal ada |
| **Bulan tanpa penjualan ditulis 0**, bukan dihilangkan | Bulan hilang dibaca sebagai "data belum tercatat" | Dilaporkan sebagai kerusakan sistem |
| **Field jangan pernah dikosongkan saat ambigu** | Kekosongan memancing Gemini mengarang | Nomor invoice & daftar barang fiktif |
| **Data keluarga hanya milik yang sedang login** | Dulu seluruh daftar dikirim | Rekan kerja disebut sebagai istri |
| **Tahun lampau hanya dari data khusus** | Transaksi mentah cuma tahun berjalan | Angka tahun ini dilabeli tahun lalu |
| **Perbandingan tahun pakai periode setara** | 2025 penuh vs 2026 sebagian = −33,7% (menyesatkan); setara = +1,8% | Rencana kerja disusun atas defisit palsu |
| **Duplikasi dipisah menurut jenis risikonya** | Nomor sama + tanggal beda ≠ tagih ganda | Angka risiko digelembungkan |
| **Retur tidak menambah hitungan invoice** | Retur itu pembalikan, bukan transaksi baru | Jumlah transaksi menggelembung |
| **Sinkronisasi kosong tidak menimpa data lama** | Google Sheets pernah membalas kosong | Seluruh data hilang, MIRA mengarang |
| **Satu hal = satu angka.** Bulan berjalan ikut buku transaksi, bukan kolom rekap sheet | Sheet Rp606.839.800 vs buku Rp597.119.800 | Pertanyaan sama dijawab beda tiap kali ditanya |
| **Invoice per wilayah dihitung dari buku transaksi**, sheet hanya penyedia daftar nama wilayah | Papan KPI dulu ikut menghitung retur (Makassar 499 vs 482) | Dua angka untuk wilayah yang sama |
| **Yang "terlemah" punya field sendiri**, bukan ekor daftar teratas | Ekor top-20 pernah disebut sebagai wilayah terlemah | Barru (46) disebut terlemah, padahal ada yang 1 |

---

## 4. Batas yang diketahui (bukan bug)

- **Data 2025 hanya total bulanan** — tidak ada rincian invoice/produk/customer tahun lalu.
- **PO Gudang mulai Maret 2026.**
- **Katalog produk & video di-input manual**, tidak sinkron otomatis dari website.
- **Tidak bisa menerima/membuat gambar, PDF, Excel, Word.**
- **Tidak menulis apa pun ke Google Sheets** — hanya membaca.
- **Tidak ada penanda kejadian bisnis** (mis. tanggal kenaikan harga).
- **Sinkronisasi tiap 10 menit**; khusus pertanyaan stok ada penyegaran langsung bila data >2 menit.
- **Butuh internet** — mode offline hanya menampilkan tampilan kosong.
- **Gemini bisa keliru menyampaikan** walau datanya benar. Sudah banyak dikurangi lewat aturan,
  tapi tidak bisa dijamin nol.

---

## 5. Hal yang perlu dipantau

- **Ukuran system prompt: ~51.000 karakter.** Dulu 37.000 pernah membuat MIRA lambat sekali dan
  perlu dipadatkan. Sekarang masih sehat (2–5 detik), tapi kalau bertambah terus dan MIRA mulai
  terasa lambat, inilah tersangka pertama — padatkan kalimatnya, jangan hapus aturannya.
- **Pertanyaan bernada saran memuat banyak data sekaligus** (~33.000 token) — paling boros kuota.
- **Kuota gratis Gemini**; kalau habis, MIRA menjawab dengan pesan khusus, bukan error mentah.

---

## 6. Alur kerja yang aman

```bash
node test-mira.js        # sebelum mengubah — pastikan hijau
# ... lakukan perubahan di worker.js ...
node -c worker.js        # cek sintaks
node test-mira.js        # sesudah mengubah — WAJIB hijau
npx wrangler deploy      # baru deploy
```

Kalau mengubah tampilan (`index.html`), naikkan `CACHE_NAME` di `sw.js` supaya HP memuat versi
baru, lalu `git push` (GitHub Pages).
