[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Hasanrdp/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Hasanrdp/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Ruang demi Ruang — solver Sokoban push-optimal

Entry untuk [sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121)
di make.fun: satu program Node 22 (`main.ts`) yang menjawab kelima instance
dalam satu run, masing-masing dengan jumlah push sekecil mungkin.

## Cara kerja

Level yang digambar kompetisi ini adalah satu lorong dengan satu sampai
empat ruangan di sisinya, tiap ruangan berisi 3 atau 4 kotak dan gol
sebanyak itu, dan jumlah push optimal satu level adalah jumlah optimum
ruang-ruangannya: kotak yang terdorong keluar lewat pintu ruangan ke
lorong tidak bisa didorong kembali, jadi tiap ruangan adalah masalah
yang berdiri sendiri, hanya dihubungkan oleh langkah pemain antar pintu.

Program ini memecah tiap level menjadi ruangan-ruangannya — memotong
kotak-kotak mati di baris lorong (kotak di sana tidak bisa mencapai gol
mana pun), lalu tiap sisa lantai yang berisi kotak adalah satu ruangan —
dan menyelesaikan tiap ruangan secara push-optimal, lalu merangkai
langkah pemain dari pintu ke pintu:

- **Pencarian push-optimal per ruangan**: breadth-first search atas
  push, dengan state berupa posisi kotak-kotak plus wilayah yang bisa
  dicapai pemain di sekitarnya. State dibuka urut jumlah push, jadi
  state selesai pertama yang ditemui adalah yang push-optimal.
- **Dua pemangkasan deadlock** yang tidak pernah memangkas state yang
  masih bisa selesai: push yang mendaratkan kotak di kotak mati (kotak
  yang tidak bisa didorong ke gol mana pun, dihitung dengan menarik
  mundur dari gol-gol), dan push yang membekukan kotak di dalam blok
  2 x 2 berisi dinding dan kotak dengan satu kotak di luar gol.
- **Jatuh kembali** bila level tidak terpecah menjadi ruangan, atau
  pencarian satu ruangan kehabisan anggaran state: pencarian push yang
  sama atas seluruh level, lalu A* berbasis langkah.

Pencarian sepenuhnya deterministik — urutan arah tetap, antrean
first-in-first-out, tanpa jam dan tanpa acak — sehingga dua eksekusi
menulis byte yang sama.

## Hasil lokal (practice set dari kit)

| Instance | Push | P\* | Poin |
|----------|------|-----|------|
| i001 | 13 | 13 | 1.000 |
| i002 | 16 | 16 | 1.000 |
| i003 | 29 | 29 | 1.000 |
| i004 | 47 | 47 | 1.000 |
| i005 | 60 | 60 | 1.000 |

Skor lokal: **1.000.000** (maksimum), `grade-local` kit: 5000 dari 5000
poin, L1 regrade reproduced byte for byte. Sebagai perbandingan, baseline
house `plain-astar 1.0.0` hanya mendapat 200.000 pada practice set yang
sama (hanya i001 yang selesai). Waktu jalan lokal sekitar 1 detik untuk
kelima instance, jauh di bawah batas 60 detik.

## Menjalankan

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=kit/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Untuk tiap instance `<id>` di direktori input, program menulis
`out/<id>/solution.txt` berisi langkah pemain (`u`, `d`, `l`, `r`;
huruf besar menandai push).

## Lisensi

MIT — lihat [LICENSE](LICENSE).
