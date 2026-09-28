# 豐原區 3D 地形模型 Fengyuan District 3D

Three.js 單頁模型：地形、道路、水系、建物量體、擬真模式（衛星影像、日照陰影）、人視點、地點縮放。

- 線上版：https://pp0514-hill.github.io/fengyuan-3D/
- 原始碼：`src/`（`npx esbuild src/main.js --bundle --minify --format=iife --outfile=bundle.js` 後執行 `src/build.py`）
- 資料：`data/fengyuan-osm-pack.b64.txt`（OpenStreetMap，2026-09-25 擷取）

## 資料來源與授權
- 道路、建物、水系、行政界：© OpenStreetMap contributors，ODbL 1.0
- 地形：AWS Terrain Tiles（Terrarium）
- 擬真模式衛星影像：© Esri, Maxar, Earthstar Geographics（執行期載入）

建物高度多數為推估值；本模型僅供基地初步判讀，不得作為測量、設計或法規依據。
