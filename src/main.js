import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

/* =========================================================================
   豐原區 3D 地形模型 Fengyuan District — Three.js
   資料：OpenStreetMap（Overpass API，執行期下載）＋ AWS Terrain Tiles（Terrarium）
   ========================================================================= */

const CFG = {
  districtName: '豐原區',
  demZoom: 13,                 // Terrarium z13 ≈ 17.5 m/px @ lat 24°
  gridStep: 20,                // 地形網格間距（m）
  margin: 700,                 // 行政界外擴範圍（m）
  texMax: 4096,                // 地圖紋理最大邊長（px）
  stationFallback: [24.2541, 120.7234],
  endpoints: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ],
  demUrl: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
};

const COL = {
  bg: 0xECEAE5,
  terrLow: new THREE.Color(0xEDEBE6),
  terrHigh: new THREE.Color(0xCFC9BE),
  base: 0xD8D5CE,
  bldg: 0xFBFAF7,
  bldgEst: 0xF1EEE8,
  edge: 0x8E8A82,
  accent: 0x9C3D2C,
};

/* ---------- UI helpers ---------- */
const $ = (s) => document.querySelector(s);
const logEl = $('#log');
function log(msg, kind = '') {
  const d = document.createElement('div');
  d.className = 'log-line ' + kind;
  const t = new Date();
  d.textContent = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}  ${msg}`;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
  console.log('[fengyuan3d]', msg);
}
function setStatus(txt) { $('#status').textContent = txt; }
window.__fy = { state: 'init', errors: [] };

/* ---------- IndexedDB cache ---------- */
const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      try {
        const r = indexedDB.open('fengyuan3d', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { this.db = r.result; res(r.result); };
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
  },
  async get(k) {
    try {
      const db = await this.open();
      return await new Promise((res) => {
        const q = db.transaction('kv').objectStore('kv').get(k);
        q.onsuccess = () => res(q.result);
        q.onerror = () => res(undefined);
      });
    } catch (e) { return undefined; }
  },
  async set(k, v) {
    try {
      const db = await this.open();
      await new Promise((res) => {
        const t = db.transaction('kv', 'readwrite');
        t.objectStore('kv').put(v, k);
        t.oncomplete = res; t.onerror = res; t.onabort = res;
      });
    } catch (e) { /* ignore */ }
  },
  async clear() {
    try {
      const db = await this.open();
      await new Promise((res) => {
        const t = db.transaction('kv', 'readwrite');
        t.objectStore('kv').clear();
        t.oncomplete = res; t.onerror = res;
      });
    } catch (e) { /* ignore */ }
  },
};

async function overpass(query, key, label) {
  const cached = await idb.get(key);
  if (cached) { log(`${label}：使用快取`); return cached; }
  let lastErr;
  const eps = [...CFG.endpoints, ...CFG.endpoints];
  for (let n = 0; n < eps.length; n++) {
    const ep = eps[n];
    if (n === CFG.endpoints.length) { log(`${label}：全部端點忙碌，5 秒後重試`, 'warn'); await new Promise((r) => setTimeout(r, 5000)); }
    try {
      log(`${label}：下載中（${new URL(ep).host}）`);
      const t0 = performance.now();
      const r = await fetch(ep, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      log(`${label}：${j.elements.length} 筆，${((performance.now() - t0) / 1000).toFixed(1)} s`);
      await idb.set(key, j);
      return j;
    } catch (e) {
      lastErr = e;
      log(`${label}：${new URL(ep).host} 失敗（${e.message}），改試下一個`, 'warn');
    }
  }
  throw lastErr;
}

/* ---------- Projection (local tangent plane, meters) ---------- */
const P = { lat0: 0, lon0: 0, kx: 1, kz: 110574 };
function setOrigin(lat0, lon0) {
  P.lat0 = lat0; P.lon0 = lon0;
  P.kx = 111320 * Math.cos(lat0 * Math.PI / 180);
}
const toX = (lon) => (lon - P.lon0) * P.kx;
const toZ = (lat) => -(lat - P.lat0) * P.kz;
const toLon = (x) => x / P.kx + P.lon0;
const toLat = (z) => -z / P.kz + P.lat0;

/* ---------- Ring stitching for multipolygon relations ---------- */
function stitchRings(ways) {
  const segs = ways.map((w) => w.map((p) => [p.lon, p.lat])).filter((s) => s.length > 1);
  const rings = [];
  const key = (p) => p[0].toFixed(7) + ',' + p[1].toFixed(7);
  while (segs.length) {
    let ring = segs.shift().slice();
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 10000) {
      const endK = key(ring[ring.length - 1]);
      let found = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (key(s[0]) === endK) { ring = ring.concat(s.slice(1)); segs.splice(i, 1); found = true; break; }
        if (key(s[s.length - 1]) === endK) { ring = ring.concat(s.slice().reverse().slice(1)); segs.splice(i, 1); found = true; break; }
      }
      if (!found) break;
    }
    if (ring.length > 3) rings.push(ring);
  }
  return rings;
}
function ringArea(ring) { // ring in local [x,z]
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]);
  return a / 2;
}

/* ---------- Global state ---------- */
const S = {
  boundary: null,       // {outer:[[lon,lat]...][], inner:[]}
  boundaryLocal: null,  // {outer:[[x,z]][], inner:[]}
  ext: null,            // {minX,maxX,minZ,maxZ}
  hf: null,             // {nx,nz,step,data:Float32Array}
  mask: null,           // Uint8Array inside-district per grid node
  features: null,       // parsed OSM
  landmarks: [],
  buildings: [],        // parsed footprints
  station: null,
  ex: 1.0,
  layers: { terrain: true, buildings: true, roads: true, water: true, rail: true, boundary: true, labels: true, villages: false, parks: true },
};

/* ---------- Three.js scene ---------- */
const canvas = $('#c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const TOUCH = window.matchMedia('(pointer: coarse)').matches;
const SMALL = () => window.matchMedia('(max-width: 900px)').matches;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, TOUCH ? 1.5 : 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(COL.bg);
scene.fog = new THREE.Fog(COL.bg, 16000, 40000);
const camera = new THREE.PerspectiveCamera(35, 1, 5, 80000);
camera.position.set(0, 9000, 9000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 120;
controls.maxDistance = 30000;
controls.screenSpacePanning = false;
controls.panSpeed = 1.0;
controls.zoomToCursor = true;

/* ---------- 工具模式（仿 SketchUp）：O 環繞、H 平移手掌、Shift+Z 全圖 ---------- */
const TOOL = { mode: 'orbit' };
function setTool(mode) {
  TOOL.mode = mode;
  if (mode === 'pan') {
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  } else {
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  }
  document.body.dataset.tool = mode;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === mode));
}
// 中鍵＝環繞；Shift＋中鍵＝暫時平移（OrbitControls 對 ROTATE 按鍵加 Shift 會轉為平移，與 SketchUp 一致）
setTool('orbit');
controls.addEventListener('start', () => document.body.classList.add('dragging'));
controls.addEventListener('end', () => document.body.classList.remove('dragging'));

const hemi = new THREE.HemisphereLight(0xffffff, 0xB8B2A6, 1.35);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-6000, 9000, -4000); // 西北方光源，地形判讀慣例
scene.add(sun);
scene.add(sun.target);
sun.shadow.mapSize.set(TOUCH ? 2048 : 4096, TOUCH ? 2048 : 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 1.5;

const world = new THREE.Group();
scene.add(world);
let terrainMesh = null, baseMesh = null, bldgMesh = null, bldgEdges = null, hiMesh = null;
let mapCanvas = null, mapTex = null;

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 300));

/* ---------- DEM ---------- */
function lonToPx(lon, z) { return (lon + 180) / 360 * 256 * 2 ** z; }
function latToPx(lat, z) {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 256 * 2 ** z;
}

async function loadDEM() {
  const { minX, maxX, minZ, maxZ } = S.ext;
  const step = CFG.gridStep;
  const nx = Math.ceil((maxX - minX) / step) + 1;
  const nz = Math.ceil((maxZ - minZ) / step) + 1;
  const key = `dem:v2:${CFG.demZoom}:${minX.toFixed(0)}:${maxX.toFixed(0)}:${minZ.toFixed(0)}:${maxZ.toFixed(0)}:${step}:${P.lat0.toFixed(5)}:${P.lon0.toFixed(5)}`;
  const cached = await idb.get(key);
  if (cached) { log('地形 DEM：使用快取'); return { nx, nz, step, data: new Float32Array(cached) }; }

  const z = CFG.demZoom;
  const w = toLon(minX), e = toLon(maxX), n = toLat(minZ), s = toLat(maxZ);
  const px0 = lonToPx(w, z), px1 = lonToPx(e, z), py0 = latToPx(n, z), py1 = latToPx(s, z);
  const tx0 = Math.floor(px0 / 256), tx1 = Math.floor(px1 / 256), ty0 = Math.floor(py0 / 256), ty1 = Math.floor(py1 / 256);
  const TW = tx1 - tx0 + 1, TH = ty1 - ty0 + 1;
  log(`地形 DEM：下載 Terrarium z${z} 圖磚 ${TW}×${TH} 張`);
  const mos = new Float32Array(TW * 256 * TH * 256);
  const MW = TW * 256;
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    jobs.push((async () => {
      const r = await fetch(CFG.demUrl(z, tx, ty), { mode: 'cors' });
      if (!r.ok) throw new Error(`DEM tile ${tx}/${ty} HTTP ${r.status}`);
      const bmp = await createImageBitmap(await r.blob());
      const oc = document.createElement('canvas'); oc.width = 256; oc.height = 256;
      const cx = oc.getContext('2d', { willReadFrequently: true });
      cx.drawImage(bmp, 0, 0);
      const d = cx.getImageData(0, 0, 256, 256).data;
      const ox = (tx - tx0) * 256, oy = (ty - ty0) * 256;
      for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
        const k = (j * 256 + i) * 4;
        mos[(oy + j) * MW + ox + i] = d[k] * 256 + d[k + 1] + d[k + 2] / 256 - 32768;
      }
    })());
  }
  await Promise.all(jobs);
  const MH = TH * 256;
  const data = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const lat = toLat(minZ + j * step);
    const py = latToPx(lat, z) - ty0 * 256 - 0.5;
    for (let i = 0; i < nx; i++) {
      const lon = toLon(minX + i * step);
      const px = lonToPx(lon, z) - tx0 * 256 - 0.5;
      const x0 = Math.max(0, Math.min(MW - 2, Math.floor(px))), y0 = Math.max(0, Math.min(MH - 2, Math.floor(py)));
      const fx = Math.min(1, Math.max(0, px - x0)), fy = Math.min(1, Math.max(0, py - y0));
      const a = mos[y0 * MW + x0], b = mos[y0 * MW + x0 + 1], c = mos[(y0 + 1) * MW + x0], d = mos[(y0 + 1) * MW + x0 + 1];
      data[j * nx + i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  await idb.set(key, data.buffer.slice(0));
  log(`地形 DEM：網格 ${nx}×${nz}（${step} m）`);
  return { nx, nz, step, data };
}

function heightAt(x, z) {
  const { nx, nz, step, data } = S.hf;
  const fx = (x - S.ext.minX) / step, fz = (z - S.ext.minZ) / step;
  const i = Math.max(0, Math.min(nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(nz - 2, Math.floor(fz)));
  const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fz - j));
  const a = data[j * nx + i], b = data[j * nx + i + 1], c = data[(j + 1) * nx + i], d = data[(j + 1) * nx + i + 1];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/* ---------- District mask (per grid node) ---------- */
function buildMask() {
  const { nx, nz, step } = S.hf;
  const oc = document.createElement('canvas'); oc.width = nx; oc.height = nz;
  const cx = oc.getContext('2d', { willReadFrequently: true });
  cx.fillStyle = '#000'; cx.fillRect(0, 0, nx, nz);
  cx.beginPath();
  for (const ring of [...S.boundaryLocal.outer, ...S.boundaryLocal.inner]) {
    ring.forEach(([x, z], k) => {
      const px = (x - S.ext.minX) / step, pz = (z - S.ext.minZ) / step;
      k ? cx.lineTo(px, pz) : cx.moveTo(px, pz);
    });
    cx.closePath();
  }
  cx.fillStyle = '#fff'; cx.fill('evenodd');
  const d = cx.getImageData(0, 0, nx, nz).data;
  const m = new Uint8Array(nx * nz);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4] > 127 ? 1 : 0;
  return m;
}

/* ---------- Terrain mesh ---------- */
function buildTerrain() {
  const { nx, nz, step, data } = S.hf;
  const { minX, minZ } = S.ext;
  const W = (nx - 1) * step, H = (nz - 1) * step;
  const pos = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2), col = new Float32Array(nx * nz * 3);
  let hMin = Infinity, hMax = -Infinity;
  for (let k = 0; k < data.length; k++) if (S.mask[k]) { hMin = Math.min(hMin, data[k]); hMax = Math.max(hMax, data[k]); }
  S.hMin = hMin; S.hMax = hMax;
  let allMin = Infinity;
  for (let k = 0; k < data.length; k++) allMin = Math.min(allMin, data[k]);
  S.allMin = allMin;
  const c = new THREE.Color();
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, h = data[k];
    pos[k * 3] = minX + i * step; pos[k * 3 + 1] = h * S.ex; pos[k * 3 + 2] = minZ + j * step;
    uv[k * 2] = i / (nx - 1); uv[k * 2 + 1] = 1 - j / (nz - 1);
    const t = Math.min(1, Math.max(0, (h - hMin) / Math.max(1, hMax - hMin)));
    c.copy(COL.terrLow).lerp(COL.terrHigh, Math.pow(t, 0.8));
    col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let p = 0;
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, cc = a + nx, d = cc + 1;
    idx[p++] = a; idx[p++] = cc; idx[p++] = b;
    idx[p++] = b; idx[p++] = cc; idx[p++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const mat = (S.real && satTex)
    ? new THREE.MeshStandardMaterial({ map: satTex, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
    : new THREE.MeshLambertMaterial({ vertexColors: true, map: mapTex, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  if (terrainMesh) { world.remove(terrainMesh); terrainMesh.geometry.dispose(); }
  terrainMesh = new THREE.Mesh(g, mat);
  terrainMesh.receiveShadow = S.real;
  world.add(terrainMesh);
  buildBase();
}

function buildBase() { // 模型底座（實體模型意象）
  const { nx, nz, step, data } = S.hf;
  const { minX, minZ } = S.ext;
  const baseY = (S.allMin - 60) * S.ex;
  const pts = [];
  const edge = [];
  for (let i = 0; i < nx; i++) edge.push([i, 0]);
  for (let j = 1; j < nz; j++) edge.push([nx - 1, j]);
  for (let i = nx - 2; i >= 0; i--) edge.push([i, nz - 1]);
  for (let j = nz - 2; j >= 1; j--) edge.push([0, j]);
  edge.push([0, 0]);
  for (let k = 0; k < edge.length - 1; k++) {
    const [i0, j0] = edge[k], [i1, j1] = edge[k + 1];
    const x0 = minX + i0 * step, z0 = minZ + j0 * step, x1 = minX + i1 * step, z1 = minZ + j1 * step;
    const y0 = data[j0 * nx + i0] * S.ex, y1 = data[j1 * nx + i1] * S.ex;
    pts.push(x0, y0, z0, x0, baseY, z0, x1, y1, z1, x1, y1, z1, x0, baseY, z0, x1, baseY, z1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.computeVertexNormals();
  if (baseMesh) { world.remove(baseMesh); baseMesh.geometry.dispose(); }
  baseMesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: COL.base, side: THREE.DoubleSide }));
  world.add(baseMesh);
}

/* ---------- OSM parsing ---------- */
const ROAD = {
  motorway: [24, 1], trunk: [20, 1], primary: [16, 1], secondary: [13, 2], tertiary: [10, 2],
  motorway_link: [9, 2], trunk_link: [9, 2], primary_link: [8, 2], secondary_link: [7, 2], tertiary_link: [7, 3],
  unclassified: [7, 3], residential: [6.5, 3], living_street: [5.5, 3], service: [4, 4], track: [3, 4],
};
function parseFeatures(j) {
  const F = { roads: [], rails: [], waterways: [], waterAreas: [], parks: [] };
  for (const el of j.elements) {
    const t = el.tags || {};
    if (el.type === 'way' && el.geometry) {
      const pts = el.geometry.map((p) => [toX(p.lon), toZ(p.lat)]);
      if (t.highway && ROAD[t.highway]) F.roads.push({ pts, kind: t.highway, bridge: t.bridge, tunnel: t.tunnel, name: t.name });
      else if (t.railway) { if (t.tunnel !== 'yes') F.rails.push({ pts, kind: t.railway }); }
      else if (t.waterway) {
        if (t.waterway === 'riverbank') F.waterAreas.push({ outer: [pts], inner: [] });
        else F.waterways.push({ pts, kind: t.waterway, name: t.name, tunnel: t.tunnel });
      }
      else if (t.natural === 'water' || t.water || t.landuse === 'reservoir' || t.landuse === 'basin') F.waterAreas.push({ outer: [pts], inner: [] });
      else if (t.leisure === 'park' || t.landuse === 'grass' || t.leisure === 'pitch' || t.landuse === 'forest' || t.natural === 'wood') F.parks.push({ outer: [pts], inner: [], kind: t.leisure || t.landuse || t.natural });
    } else if (el.type === 'relation' && el.members) {
      const outer = [], inner = [];
      for (const m of el.members) if (m.type === 'way' && m.geometry) (m.role === 'inner' ? inner : outer).push(m.geometry);
      const toL = (rings) => stitchRings(rings).map((r) => r.map(([lon, lat]) => [toX(lon), toZ(lat)]));
      const poly = { outer: toL(outer), inner: toL(inner) };
      if (t.natural === 'water' || t.water || t.waterway === 'riverbank') F.waterAreas.push(poly);
      else if (t.leisure === 'park' || t.landuse === 'forest' || t.natural === 'wood' || t.landuse === 'grass') F.parks.push(poly);
    }
  }
  return F;
}

function parseLandmarks(j) {
  const L = [];
  const seen = new Set();
  for (const el of j.elements) {
    const t = el.tags || {};
    if (!t.name) continue;
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    let kind = null, pri = 9;
    if (t.railway === 'station' || t.public_transport === 'station') { kind = 'station'; pri = 1; }
    else if (t.natural === 'peak') { kind = 'peak'; pri = 2; }
    else if (t.amenity === 'place_of_worship') { if (/^豐原慈濟宮$|^豐原慈后宮$/.test(t.name)) { kind = 'temple'; pri = 3; } }
    else if (t.leisure === 'park') { if (/葫蘆墩公園|綠空廊道|中正公園|葫蘆墩圳水岸|旱溪源頭/.test(t.name)) { kind = 'park'; pri = 4; } }
    else if (t.leisure === 'stadium') { if (/體育場/.test(t.name)) { kind = 'sport'; pri = 5; } }
    else if (t.amenity === 'townhall' || t.office === 'government') { if (/區公所|陽明大樓/.test(t.name)) { kind = 'gov'; pri = 4; } }
    else if (t.place) { kind = 'village'; pri = 8; }
    if (!kind) continue;
    const k = kind + t.name;
    if (seen.has(k)) continue;
    seen.add(k);
    L.push({ name: t.name, kind, pri, x: toX(lon), z: toZ(lat), lat, lon, ele: t.ele });
  }
  return L;
}

/* ---------- Map texture (roads, water, boundary drawn on terrain) ---------- */
function drawMap() {
  const { minX, maxX, minZ, maxZ } = S.ext;
  const W = maxX - minX, H = maxZ - minZ;
  const ppm = CFG.texMax / Math.max(W, H);
  const cw = Math.round(W * ppm), ch = Math.round(H * ppm);
  if (!mapCanvas) { mapCanvas = document.createElement('canvas'); }
  mapCanvas.width = cw; mapCanvas.height = ch;
  const cx = mapCanvas.getContext('2d');
  const X = (x) => (x - minX) * ppm, Z = (z) => (z - minZ) * ppm;
  const pathLine = (pts) => { cx.beginPath(); pts.forEach(([x, z], k) => (k ? cx.lineTo(X(x), Z(z)) : cx.moveTo(X(x), Z(z)))); };
  const pathPoly = (poly) => {
    cx.beginPath();
    for (const r of [...poly.outer, ...poly.inner]) { r.forEach(([x, z], k) => (k ? cx.lineTo(X(x), Z(z)) : cx.moveTo(X(x), Z(z)))); cx.closePath(); }
  };
  cx.fillStyle = '#FFFFFF'; cx.fillRect(0, 0, cw, ch);
  cx.lineCap = 'round'; cx.lineJoin = 'round';
  const F = S.features;
  if (F) {
    if (S.layers.parks) {
      cx.fillStyle = '#E2E6D8';
      for (const p of F.parks) { pathPoly(p); cx.fill('evenodd'); }
    }
    if (S.layers.water) {
      cx.fillStyle = '#9DB0B6';
      for (const p of F.waterAreas) { pathPoly(p); cx.fill('evenodd'); }
      cx.strokeStyle = '#8CA2A9';
      const ww = { river: 14, canal: 7, stream: 3.5, drain: 3, ditch: 2 };
      for (const w of F.waterways) {
        if (w.tunnel === 'culvert' || w.tunnel === 'yes') continue;
        cx.lineWidth = Math.max(1, (ww[w.kind] || 2.5) * ppm);
        pathLine(w.pts); cx.stroke();
      }
    }
    if (S.layers.roads) {
      const roads = F.roads.filter((r) => r.tunnel !== 'yes').sort((a, b) => ROAD[b.kind][1] - ROAD[a.kind][1]);
      // casing
      for (const r of roads) {
        const [w] = ROAD[r.kind];
        cx.strokeStyle = ROAD[r.kind][1] <= 2 ? '#A9A398' : '#C7C2B8';
        cx.lineWidth = Math.max(1.2, (w + 2.4) * ppm);
        pathLine(r.pts); cx.stroke();
      }
      for (const r of roads) {
        const [w, rank] = ROAD[r.kind];
        cx.strokeStyle = rank <= 1 ? '#F4F1EA' : '#FCFBF8';
        cx.lineWidth = Math.max(0.6, w * ppm);
        pathLine(r.pts); cx.stroke();
      }
    }
    if (S.layers.rail) {
      for (const r of F.rails) {
        if (!/rail|light_rail|subway|narrow_gauge/.test(r.kind)) continue;
        cx.setLineDash([]);
        cx.strokeStyle = '#55524C'; cx.lineWidth = Math.max(1.5, 6 * ppm);
        pathLine(r.pts); cx.stroke();
        cx.strokeStyle = '#FFFFFF'; cx.lineWidth = Math.max(0.8, 3 * ppm);
        cx.setLineDash([22 * ppm, 22 * ppm]);
        pathLine(r.pts); cx.stroke();
        cx.setLineDash([]);
      }
    }
  }
  // 區外淡化
  cx.fillStyle = 'rgba(236,234,229,0.62)';
  cx.beginPath();
  cx.rect(0, 0, cw, ch);
  for (const r of [...S.boundaryLocal.outer, ...S.boundaryLocal.inner]) { r.forEach(([x, z], k) => (k ? cx.lineTo(X(x), Z(z)) : cx.moveTo(X(x), Z(z)))); cx.closePath(); }
  cx.fill('evenodd');
  if (S.layers.boundary) {
    cx.strokeStyle = '#232220';
    cx.lineWidth = Math.max(2, 9 * ppm);
    cx.setLineDash([70 * ppm, 22 * ppm, 12 * ppm, 22 * ppm]);
    for (const r of S.boundaryLocal.outer) { pathLine(r); cx.closePath(); cx.stroke(); }
    cx.setLineDash([]);
  }
  if (!mapTex) {
    mapTex = new THREE.CanvasTexture(mapCanvas);
    mapTex.colorSpace = THREE.SRGBColorSpace;
    mapTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    mapTex.generateMipmaps = true;
    mapTex.minFilter = THREE.LinearMipmapLinearFilter;
  } else {
    mapTex.image = mapCanvas;
    mapTex.needsUpdate = true;
  }
}

/* ---------- Buildings ---------- */
function hash(n) { let x = n % 2147483647; x = (x * 16807) % 2147483647; return x / 2147483647; }
function estimateHeight(t, id) {
  if (t.height) { const h = parseFloat(String(t.height).replace(',', '.')); if (h > 1 && h < 400) return [h, 'OSM height'] }
  if (t['building:levels']) { const l = parseFloat(t['building:levels']); if (l > 0 && l < 120) return [l * 3.3 + 1, `OSM ${l} 層`]; }
  const b = t.building, r = hash(id);
  const table = {
    apartments: [5, 12], residential: [4, 7], house: [2, 4], detached: [2, 3], terrace: [3, 5],
    commercial: [3, 7], retail: [2, 4], office: [5, 12], industrial: [1, 2], warehouse: [1, 2], factory: [1, 2],
    school: [3, 5], university: [4, 6], hospital: [6, 12], temple: [1, 2], church: [1, 2], shrine: [1, 1],
    roof: [1, 1], garage: [1, 1], shed: [1, 1], hut: [1, 1], train_station: [2, 3], public: [3, 5], government: [4, 7],
  };
  const [a, z] = table[b] || [2, 5];
  const lv = Math.round(a + r * (z - a));
  const h = (b === 'industrial' || b === 'warehouse' || b === 'factory') ? 7 + r * 5 : (b === 'roof' ? 4.5 : lv * 3.3 + 0.6);
  return [h, `推估 ${lv} 層`];
}

/* ---------- 指定建物細化（使用者提供資料） ---------- */
const DETAIL = {
  1004856225: {
    name: '初樸建築師事務所', floors: 11,
    // 以下為假設值（未經現況丈量）：
    h1: 4.2,          // 1F 樓高
    hTyp: 3.3,        // 2F 以上標準層樓高
    parapet: 1.2,     // 女兒牆高
    bay: 3.6,         // 立面開窗跨距
    winRatio: 0.62,   // 窗寬／跨距
    winH: 1.7, sill: 0.9, // 窗高、窗台高
    penthouse: 3.0,   // 屋突（樓梯間／機房）高
    focusFloor: 5,    // 事務所所在樓層
    role: 'office',
  },
};
// 國聚之境（3 棟，使用者提供 15F）；以下樓高、開窗皆為假設值
const GUOJU = { name: '國聚之境', floors: 15, h1: 4.2, hTyp: 3.2, parapet: 1.2, bay: 3.4, winRatio: 0.55, winH: 1.5, sill: 0.9, penthouse: 3.0, focusFloor: null, role: 'landmark', group: 'guoju' };
for (const id of [1191332091, 1191332092, 1191332093]) DETAIL[id] = GUOJU;

function parseBuildings(j) {
  const out = [];
  for (const el of j.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 4) continue;
    const t = el.tags || {};
    let ring = el.geometry.map((p) => [toX(p.lon), toZ(p.lat)]);
    const f = ring[0], l = ring[ring.length - 1];
    if (f[0] === l[0] && f[1] === l[1]) ring = ring.slice(0, -1);
    if (ring.length < 3) continue;
    const D = DETAIL[el.id];
    if (D) {
      const h = D.h1 + D.hTyp * (D.floors - 1);
      out.push({ id: el.id, ring, h, src: `使用者提供 ${D.floors} 層（樓高為假設值）`, est: false, tags: { ...t, name: D.name, building: D.role === 'office' ? 'office' : (t.building || 'apartments') }, detail: D });
      continue;
    }
    const [h, src] = estimateHeight(t, el.id);
    out.push({ id: el.id, ring, h, src, est: src.startsWith('推估'), tags: t });
  }
  return out;
}

function buildBuildings() {
  if (bldgMesh) { world.remove(bldgMesh); bldgMesh.geometry.dispose(); bldgMesh = null; }
  if (bldgEdges) { world.remove(bldgEdges); bldgEdges.geometry.dispose(); bldgEdges = null; }
  clearHighlight();
  if (!S.buildings.length) return;
  const pos = [], nor = [], col = [], edges = [], triOwner = [];
  const cA = new THREE.Color(COL.bldg), cB = new THREE.Color(COL.bldgEst);
  const REALPAL = [0xD9D4CA, 0xCFC8BB, 0xE6E2DA, 0xBFB8AC, 0xCBC1B0, 0xD7D0C5, 0xB9B3AA, 0xE0D6C6].map((h) => new THREE.Color(h));
  const roofDark = new THREE.Color(0x8E8A84);
  const V = THREE.ShapeUtils;
  S.buildings.forEach((b, bi) => {
    let ring = b.ring;
    if (ringArea(ring) < 0) ring = ring.slice().reverse(); // 保證一致方向
    let base = Infinity;
    for (const [x, z] of ring) base = Math.min(base, heightAt(x, z));
    const y0 = (base - 1.5) * S.ex; // 埋入地面避免懸空
    const y1 = base * S.ex + b.h;
    b.y0 = y0; b.y1 = y1; b.base = base;
    if (b.detail) return; // 細化建物另行建模
    const c = S.real ? REALPAL[Math.floor(hash(b.id * 7 + 3) * REALPAL.length)] : (b.est ? cB : cA);
    const push = (x, y, z, nx, ny, nz) => { pos.push(x, y, z); nor.push(nx, ny, nz); col.push(c.r, c.g, c.b); };
    // roof
    const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
    let tris;
    try { tris = V.triangulateShape(contour, []); } catch (e) { tris = []; }
    for (const [a, bb, cc] of tris) {
      // 以 (x,z) 平面三角化；確保法向朝上
      const A = ring[a], B = ring[bb], C = ring[cc];
      const cross = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
      const order = cross < 0 ? [A, B, C] : [A, C, B];
      for (const P0 of order) push(P0[0], y1, P0[1], 0, 1, 0);
      triOwner.push(bi);
    }
    // walls
    for (let i = 0; i < ring.length; i++) {
      const A = ring[i], B = ring[(i + 1) % ring.length];
      let nx = B[1] - A[1], nz = -(B[0] - A[0]);
      const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
      // ringArea>0 → 外法向量 = (dz, -dx)
      push(A[0], y0, A[1], nx, 0, nz); push(B[0], y1, B[1], nx, 0, nz); push(B[0], y0, B[1], nx, 0, nz);
      push(A[0], y0, A[1], nx, 0, nz); push(A[0], y1, A[1], nx, 0, nz); push(B[0], y1, B[1], nx, 0, nz);
      triOwner.push(bi, bi);
      edges.push(A[0], y1, A[1], B[0], y1, B[1]);
      edges.push(A[0], y0 + 1.5 * S.ex, A[1], A[0], y1, A[1]);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  bldgMesh = new THREE.Mesh(g, S.real
    ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, side: THREE.DoubleSide })
    : new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  bldgMesh.castShadow = bldgMesh.receiveShadow = S.real;
  if (S.focus5) { bldgMesh.material.transparent = true; bldgMesh.material.opacity = 0.35; bldgMesh.material.depthWrite = false; }
  bldgMesh.userData.triOwner = Uint32Array.from(triOwner);
  world.add(bldgMesh);
  const eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
  bldgEdges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: COL.edge, transparent: true, opacity: 0.45 }));
  world.add(bldgEdges);
  bldgMesh.visible = S.layers.buildings;
  bldgEdges.visible = S.layers.buildings && !S.real;
  buildDetails();
}

let detailGroup = null;
function buildDetails() {
  if (detailGroup) { world.remove(detailGroup); detailGroup.traverse((o) => o.geometry && o.geometry.dispose()); detailGroup = null; }
  const list = S.buildings.filter((b) => b.detail);
  if (!list.length) return;
  detailGroup = new THREE.Group();
  const real = S.real;
  const M = (c, rough = 0.9, metal = 0) => real ? new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal }) : new THREE.MeshLambertMaterial({ color: c });
  const matWall = M(0xC9C6BF, 0.92);       // 清水模灰（假設）
  const matSlab = M(0xB2AEA6, 0.9);
  const matGlass = real ? new THREE.MeshStandardMaterial({ color: 0x6A808C, roughness: 0.22, metalness: 0.08, emissive: 0x1C252B }) : new THREE.MeshLambertMaterial({ color: 0x8FA0A8 });
  const matFrame = M(0x55524C, 0.6, 0.3);
  const matRoof = M(0x9C988F, 0.95);
  const matAccent = M(COL.accent, 0.8);
  const focus = !!S.focus5;
  // 5F 窗：室內點燈的暖光玻璃
  const matGlass5 = new (real ? THREE.MeshStandardMaterial : THREE.MeshLambertMaterial)({ color: 0xF3D9B1, emissive: 0xE8B878, emissiveIntensity: real ? 0.9 : 0.55, ...(real ? { roughness: 0.3, metalness: 0 } : {}) });
  const matGlow = new THREE.MeshBasicMaterial({ color: 0xF1C488, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide });
  const matSlab5 = M(0xE9E4DA, 0.8);
  if (focus) for (const m of [matWall, matSlab, matGlass, matFrame, matRoof]) { m.transparent = true; m.opacity = 0.16; m.depthWrite = false; }
  const box = new THREE.BoxGeometry(1, 1, 1);
  const buckets = new Map(); // material → [matrix]
  const add = (mat, cx, cy, cz, sx, sy, sz, ry) => {
    const m4 = new THREE.Matrix4().compose(new THREE.Vector3(cx, cy, cz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(sx, sy, sz));
    if (!buckets.has(mat)) buckets.set(mat, { m: [], own: [] });
    const bk = buckets.get(mat); bk.m.push(m4); bk.own.push(curB);
  };
  let curB = null;
  for (const b of list) {
    curB = b;
    const D = b.detail;
    let ring = b.ring; if (ringArea(ring) < 0) ring = ring.slice().reverse();
    const g0 = b.base * S.ex;              // 室外地坪
    const top = g0 + b.h;
    // 主體量
    const shape = new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, -z)));
    const extrude = (y0, y1, mat) => {
      const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false });
      g.rotateX(-Math.PI / 2); g.translate(0, y0, 0);
      const m = new THREE.Mesh(g, mat); m.userData.building = b; detailGroup.add(m); return m;
    };
    const FF = D.focusFloor || 0;
    const y5b = g0 + D.h1 + D.hTyp * (FF - 2), y5t = y5b + D.hTyp;
    b.y5b = y5b; b.y5t = y5t;
    if (!focus || !FF) extrude(g0 - 1.5, top, matWall);
    else {
      extrude(g0 - 1.5, y5b, matWall);
      extrude(y5t, top, matWall);
      extrude(y5b, y5b + 0.3, matSlab5).renderOrder = 1;             // 5F 樓板
      const glow = extrude(y5b + 0.3, y5t - 0.05, matGlow); glow.renderOrder = 2; // 5F 室內空間
      // 5F 外框線（強調色）
      const pts = [];
      ring.forEach((A, i) => { const B = ring[(i + 1) % ring.length];
        for (const y of [y5b, y5t]) pts.push(A[0], y, A[1], B[0], y, B[1]);
        pts.push(A[0], y5b, A[1], A[0], y5t, A[1]); });
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const ln = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: COL.accent })); ln.renderOrder = 3; detailGroup.add(ln);
    }
    // 女兒牆（沿外緣內縮 0.1 m 的薄牆）
    ring.forEach((A, i) => {
      const B = ring[(i + 1) % ring.length];
      const dx = B[0] - A[0], dz = B[1] - A[1], L = Math.hypot(dx, dz);
      if (L < 0.5) return;
      const ry = -Math.atan2(dz, dx);
      const nx = dz / L, nz = -dx / L;     // 外法向
      const mx = (A[0] + B[0]) / 2, mz = (A[1] + B[1]) / 2;
      add(matWall, mx - nx * 0.1, top + D.parapet / 2, mz - nz * 0.1, L + 0.2, D.parapet, 0.2, ry);
      add(matSlab, mx, top + D.parapet + 0.04, mz, L + 0.25, 0.08, 0.35, ry); // 壓頂
      if (L < 2.2) return;
      // 樓板線
      for (let f = 1; f < D.floors; f++) {
        const y = g0 + D.h1 + D.hTyp * (f - 1);
        const is5 = !!D.focusFloor && (f === D.focusFloor - 1 || f === D.focusFloor);
        add(is5 && !focus ? matAccent : matSlab, mx + nx * 0.12, y, mz + nz * 0.12, L, is5 ? 0.34 : 0.28, is5 ? 0.3 : 0.24, ry);
      }
      // 1F 店面玻璃與雨遮
      const shopW = L - 1.2;
      if (shopW > 1) {
        add(matGlass, mx + nx * 0.04, g0 + 1.55, mz + nz * 0.04, shopW, 3.0, 0.06, ry);
        add(matFrame, mx + nx * 0.06, g0 + 3.1, mz + nz * 0.06, shopW, 0.12, 0.08, ry);
        add(matSlab, mx + nx * 0.7, g0 + 3.6, mz + nz * 0.7, L, 0.18, 1.4, ry);
      }
      // 標準層窗
      const nb = Math.max(1, Math.round(L / D.bay));
      const bay = L / nb, ww = bay * D.winRatio;
      for (let f = 1; f < D.floors; f++) {
        const yb = g0 + D.h1 + D.hTyp * (f - 1);
        const yc = yb + D.sill + D.winH / 2;
        for (let k = 0; k < nb; k++) {
          const t = (k + 0.5) / nb - 0.5;
          const cx = mx + (dx / L) * t * L, cz = mz + (dz / L) * t * L;
          add(D.focusFloor && f === D.focusFloor - 1 ? matGlass5 : matGlass, cx + nx * 0.03, yc, cz + nz * 0.03, ww, D.winH, 0.05, ry);
          add(matFrame, cx + nx * 0.07, yb + D.sill - 0.04, cz + nz * 0.07, ww + 0.16, 0.08, 0.14, ry); // 窗台
        }
      }
    });
    // 屋突：取最長邊內側、面積約 1/6 的矩形
    let li = 0, lmax = 0;
    ring.forEach((A, i) => { const B = ring[(i + 1) % ring.length]; const L = Math.hypot(B[0] - A[0], B[1] - A[1]); if (L > lmax) { lmax = L; li = i; } });
    const A = ring[li], B = ring[(li + 1) % ring.length];
    const dx = (B[0] - A[0]) / lmax, dz = (B[1] - A[1]) / lmax;
    let cxm = 0, czm = 0; ring.forEach(([x, z]) => { cxm += x; czm += z; }); cxm /= ring.length; czm /= ring.length;
    const ry = -Math.atan2(dz, dx);
    add(matWall, cxm, top + D.penthouse / 2, czm, 7.5, D.penthouse, 5.0, ry);
    add(matSlab, cxm, top + D.penthouse + 0.08, czm, 7.9, 0.16, 5.4, ry);
    add(matRoof, cxm + dx * 6.5, top + 1.1, czm + dz * 6.5, 2.2, 2.2, 2.2, ry);   // 水塔（示意）
    add(matFrame, cxm - dx * 6, top + 0.5, czm - dz * 6, 3.2, 1.0, 1.4, ry);      // 空調主機（示意）
    // 屋頂標記（強調色，僅一處）
  }
  for (const [mat, bk] of buckets) {
    const arr = bk.m;
    const im = new THREE.InstancedMesh(box, mat, arr.length);
    arr.forEach((m4, i) => im.setMatrixAt(i, m4));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.userData.owners = bk.own;
    detailGroup.add(im);
  }
  detailGroup.traverse((o) => { if (o.isMesh) { o.castShadow = real; o.receiveShadow = real; } });
  detailGroup.visible = S.layers.buildings;
  world.add(detailGroup);
}

function clearHighlight() { if (hiMesh) { world.remove(hiMesh); hiMesh.geometry.dispose(); hiMesh = null; } }
function highlight(b) {
  clearHighlight();
  const shape = new THREE.Shape(b.ring.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: b.y1 - b.y0 + 0.4, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, b.y0, 0);
  hiMesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: COL.accent }));
  world.add(hiMesh);
}

/* ---------- Labels ---------- */
const labelLayer = $('#labels');
let labelEls = [];
function buildLabels() {
  labelLayer.innerHTML = '';
  labelEls = [];
  const items = S.landmarks.filter((l) => l.kind !== 'village' || S.layers.villages);
  for (const l of items) {
    const el = document.createElement('div');
    el.className = 'lbl k-' + l.kind;
    el.innerHTML = `<span class="dot"></span><span class="tx">${l.name}${l.kind === 'peak' && l.ele ? ` <em>${Math.round(+l.ele)} m</em>` : ''}</span>`;
    el.title = `前往 ${l.name}`;
    el.addEventListener('click', (e) => { e.stopPropagation(); focusLandmark(l); });
    labelLayer.appendChild(el);
    labelEls.push({ el, l, v: new THREE.Vector3() });
  }
  fillPlaceList();
}

/* ---------- 點選地點縮放 ---------- */
const FOCUS_RANGE = { office: 0, bldg: 280, station: 650, temple: 220, gov: 300, sport: 420, park: 420, peak: 1100, river: 1600, village: 800 }; // 視距（m）
const FOCUS_PITCH = { peak: 32, river: 48 }; // 俯角（度），未列者 42°
function focusLandmark(l) {
  if (!S.hf) return;
  if (l.kind === 'office') { setFocus5(true); return; }
  const dist = FOCUS_RANGE[l.kind] ?? 500;
  const pitch = (FOCUS_PITCH[l.kind] ?? 42) * Math.PI / 180;
  const gy = heightAt(l.x, l.z) * S.ex;
  const T = new THREE.Vector3(l.x, gy + (l.kind === 'peak' ? 0 : 8), l.z);
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target); dir.y = 0;
  if (dir.lengthSq() < 1) dir.set(0.4, 0, 1);
  dir.normalize();
  const pos = T.clone().addScaledVector(dir, dist * Math.cos(pitch));
  pos.y = Math.max(T.y + dist * Math.sin(pitch), heightAt(pos.x, pos.z) * S.ex + 20);
  flyTo(T, pos, 1500);
  const sel = document.querySelector('#place'); if (sel) sel.value = '';
}
const KIND_ZH = { office: '事務所', bldg: '建築', station: '車站', temple: '廟宇', gov: '機關', sport: '運動設施', park: '公園', peak: '山頭', river: '河川' };
function fillPlaceList() {
  const sel = document.querySelector('#place');
  if (!sel) return;
  const items = S.landmarks.filter((l) => l.kind !== 'village');
  if (!items.length) return;
  const order = ['office', 'bldg', 'station', 'gov', 'temple', 'park', 'sport', 'peak', 'river'];
  let html = '<option value="">前往地點……</option>';
  for (const k of order) {
    const g = items.filter((l) => l.kind === k);
    if (!g.length) continue;
    html += `<optgroup label="${KIND_ZH[k]}">` + g.map((l) => `<option value="${S.landmarks.indexOf(l)}">${l.name}</option>`).join('') + '</optgroup>';
  }
  sel.innerHTML = html;
  if (!sel.dataset.bound) { sel.dataset.bound = '1'; sel.addEventListener('change', () => { const l = S.landmarks[+sel.value]; if (l) focusLandmark(l); }); }
}
function updateLabels() {
  if (!S.hf) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const show = S.layers.labels;
  const camDist = camera.position.distanceTo(controls.target);
  const placed = [];
  const sorted = labelEls.slice().sort((a, b) => a.l.pri - b.l.pri);
  for (const o of sorted) {
    if (!show) { o.el.style.display = 'none'; continue; }
    const y = heightAt(o.l.x, o.l.z) * S.ex + (o.l.lift || 12);
    o.v.set(o.l.x, y, o.l.z).project(camera);
    const sx = (o.v.x * 0.5 + 0.5) * w, sy = (-o.v.y * 0.5 + 0.5) * h;
    const off = o.v.z > 1 || sx < -50 || sx > w + 50 || sy < -20 || sy > h + 20;
    const small = w < 700;
    const tooFar = (o.l.kind === 'village' && camDist > (small ? 5000 : 9000)) || (o.l.pri >= 5 && camDist > (small ? 7000 : 14000)) || (small && o.l.pri >= 4 && camDist > 12000);
    let clash = false;
    if (!off && !tooFar) for (const p of placed) if (Math.abs(p[0] - sx) < (w < 700 ? 90 : 70) && Math.abs(p[1] - sy) < (w < 700 ? 24 : 18)) { clash = true; break; }
    if (off || tooFar || clash) { o.el.style.display = 'none'; continue; }
    placed.push([sx, sy]);
    o.el.style.display = 'flex';
    o.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
  }
}

/* ---------- Interaction ---------- */
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function terrainHit(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction;
  const { minX, maxX, minZ, maxZ } = S.ext;
  let t = 0, prevAbove = true;
  const stepLen = Math.max(4, camera.position.distanceTo(controls.target) / 600);
  for (let n = 0; n < 6000; n++) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
    if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) {
      const gh = heightAt(x, z) * S.ex;
      if (y <= gh) {
        if (!prevAbove) return null;
        return { x, z, h: heightAt(x, z) };
      }
    } else if (y < (S.allMin - 100) * S.ex) return null;
    t += stepLen;
  }
  return null;
}
let hoverRAF = 0;
canvas.addEventListener('pointermove', (e) => {
  if (!S.hf || hoverRAF) return;
  hoverRAF = requestAnimationFrame(() => {
    hoverRAF = 0;
    const hit = terrainHit(e.clientX, e.clientY);
    const el = $('#cursor');
    if (!hit) { el.textContent = '—'; return; }
    const lat = toLat(hit.z), lon = toLon(hit.x);
    const inside = S.mask[Math.round((hit.z - S.ext.minZ) / S.hf.step) * S.hf.nx + Math.round((hit.x - S.ext.minX) / S.hf.step)];
    el.textContent = `${lat.toFixed(5)}°N  ${lon.toFixed(5)}°E   H ${hit.h.toFixed(0)} m${inside ? '' : '  （區外）'}`;
  });
});
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
let lastTap = { t: 0, x: 0, y: 0 };
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > (e.pointerType === 'touch' ? 10 : 4)) return;
  // 雙擊（雙點）拉近至該點
  const now = performance.now();
  if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30 && S.hf) {
    lastTap.t = 0;
    const hit = terrainHit(e.clientX, e.clientY);
    if (hit) {
      const T = new THREE.Vector3(hit.x, hit.h * S.ex, hit.z);
      const off = new THREE.Vector3().subVectors(camera.position, controls.target).multiplyScalar(0.45);
      if (off.length() < 80) off.setLength(80);
      flyTo(T, T.clone().add(off), 700, false);
    }
    return;
  }
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  const info = $('#info');
  if (!bldgMesh || !bldgMesh.visible) return;
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObject(bldgMesh, false);
  const dh = detailGroup ? ray.intersectObject(detailGroup, true) : [];
  let b = null;
  if (dh.length && (!hits.length || dh[0].distance <= hits[0].distance)) { const o = dh[0].object; b = o.userData.owners ? o.userData.owners[dh[0].instanceId] : o.userData.building; clearHighlight(); }
  else if (hits.length) { b = S.buildings[bldgMesh.userData.triOwner[hits[0].faceIndex]]; if (b) highlight(b); }
  if (!b) { clearHighlight(); info.hidden = true; return; }
  const t = b.tags;
  const area = Math.abs(ringArea(b.ring));
  info.hidden = false;
  info.innerHTML = `<button class="info-x" aria-label="關閉" onclick="this.parentNode.hidden=true">×</button>
    <div class="info-h">${t.name || t['name:zh'] || '未命名建物'}</div>
    <table>
      <tr><th>類型 Type</th><td>${t.building === 'yes' ? '未分類' : t.building}</td></tr>
      <tr><th>高度 Height</th><td class="mono">${b.h.toFixed(1)} m${b.detail ? `（${b.detail.floors}F＋屋突 ${b.detail.penthouse} m）` : ''}</td></tr>
      <tr><th>來源 Source</th><td>${b.src}</td></tr>
      <tr><th>投影面積 Footprint</th><td class="mono">${area.toFixed(0)} m²</td></tr>
      <tr><th>基地高程 Base</th><td class="mono">${(b.y0 / S.ex + 1.5).toFixed(1)} m</td></tr>
      ${b.detail && b.detail.focusFloor ? `<tr><th>事務所樓層</th><td>${b.detail.focusFloor}F（樓板 +${(b.y5b - b.base * S.ex).toFixed(1)} m，假設）</td></tr>` : ''}
      <tr><th>OSM</th><td class="mono">way/${b.id}</td></tr>
    </table>`;
});

/* ---------- Camera presets ---------- */
let tween = null;
function flyTo(target, pos, ms = 1400, fit = true) {
  // 直式螢幕水平視野較窄，依長寬比拉遠，讓主體完整入鏡
  if (fit && camera.aspect < 1.2) pos = target.clone().add(pos.clone().sub(target).multiplyScalar(Math.min(1.7, Math.pow(1.2 / camera.aspect, 0.7))));
  const t0 = performance.now();
  const fromT = controls.target.clone(), fromP = camera.position.clone();
  tween = (now) => {
    let k = Math.min(1, (now - t0) / ms);
    k = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    controls.target.lerpVectors(fromT, target, k);
    camera.position.lerpVectors(fromP, pos, k);
    if (k >= 1) tween = null;
  };
}
function preset(name) {
  const { minX, maxX, minZ, maxZ } = S.ext;
  const cxm = (minX + maxX) / 2, czm = (minZ + maxZ) / 2;
  const span = Math.max(maxX - minX, maxZ - minZ);
  const gy = (x, z) => heightAt(x, z) * S.ex;
  if (name === 'overview') {
    const T = new THREE.Vector3(cxm, gy(cxm, czm), czm);
    flyTo(T, new THREE.Vector3(cxm - span * 0.25, T.y + span * 0.95, czm + span * 0.95));
  } else if (name === 'station') {
    const s = S.station;
    const T = new THREE.Vector3(s.x, gy(s.x, s.z), s.z);
    flyTo(T, new THREE.Vector3(s.x + 900, T.y + 1100, s.z + 1300));
  } else if (name === 'hills') {
    const T = new THREE.Vector3(cxm + span * 0.28, gy(cxm + span * 0.28, czm), czm);
    flyTo(T, new THREE.Vector3(minX - span * 0.05, (S.hMax + 250) * S.ex, czm + span * 0.2));
  } else if (name === 'river') {
    // 由南側低角度看大甲溪河谷與北界
    const T = new THREE.Vector3(cxm, gy(cxm, minZ + span * 0.1), minZ + span * 0.12);
    flyTo(T, new THREE.Vector3(cxm - span * 0.1, T.y + span * 0.28, czm + span * 0.25));
  } else if (name === 'office') {
    const b = S.buildings.find((x) => x.detail && x.detail.role === 'office');
    if (!b) return;
    let cx0 = 0, cz0 = 0; b.ring.forEach(([x, z]) => { cx0 += x; cz0 += z; }); cx0 /= b.ring.length; cz0 /= b.ring.length;
    const T = new THREE.Vector3(cx0, b.base * S.ex + b.h * 0.45, cz0);
    flyTo(T, new THREE.Vector3(cx0 + 70, T.y + 45, cz0 + 95), 1600);
  } else if (name === 'eye') {
    // 人視點：站前廣場南側，視高 1.6 m 望向車站
    const s = S.station;
    const ex = s.x - 40, ez = s.z + 230;
    const T = new THREE.Vector3(s.x, gy(s.x, s.z) + 12, s.z);
    controls.maxPolarAngle = Math.PI * 0.499;
    flyTo(T, new THREE.Vector3(ex, gy(ex, ez) + 1.6, ez), 1800);
  } else if (name === 'top') {
    const T = new THREE.Vector3(cxm, gy(cxm, czm), czm);
    flyTo(T, new THREE.Vector3(cxm, T.y + span * 1.6, czm + 1));
  }
}

/* ---------- 擬真模式 Realistic ---------- */
S.real = false;
let satTex = null, satState = 'none', sky = null;
const SUN = { date: new Date(), hour: 15 };
const skyUp = new THREE.Vector3();

function solarPosition(date, hour) {
  // 簡化 NOAA 公式；hour 為台灣時間（UTC+8）
  const lat = P.lat0 * Math.PI / 180, lon = P.lon0;
  const start = new Date(date.getFullYear(), 0, 0);
  const n = Math.floor((date - start) / 86400000);
  const g = 2 * Math.PI / 365 * (n - 1 + (hour - 12) / 24);
  const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tst = hour * 60 + eot + 4 * lon - 60 * 8;
  const ha = (tst / 4 - 180) * Math.PI / 180;
  const cosZ = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const alt = Math.PI / 2 - Math.acos(Math.max(-1, Math.min(1, cosZ)));
  let az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) + Math.PI; // 由北順時針
  return { alt, az };
}
function sunDir() {
  const { alt, az } = solarPosition(SUN.date, SUN.hour);
  // X 東、Z 南、Y 上
  return { v: new THREE.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt)).normalize(), alt, az };
}
function applySun() {
  if (!S.real) return;
  const { v, alt, az } = sunDir();
  const k = Math.max(0, Math.min(1, alt / 0.25));
  sun.intensity = 0.3 + 2.2 * k;
  sun.color.setHSL(0.09, 0.55 * (1 - k) + 0.05, 0.6 + 0.35 * k);
  hemi.intensity = 1.05 + 0.45 * k;
  if (sky) sky.material.uniforms.sunPosition.value.copy(v);
  S.sunV = v;
  const el = document.querySelector('#sun-read');
  if (el) el.textContent = `高度角 ${(alt * 180 / Math.PI).toFixed(1)}°  方位角 ${(az * 180 / Math.PI).toFixed(0)}°`;
}
function updateSunShadow() {
  const v = S.sunV || sunDir().v;
  const d = camera.position.distanceTo(controls.target);
  const half = Math.max(250, Math.min(6000, d * 0.9));
  sun.target.position.copy(controls.target);
  sun.position.copy(controls.target).addScaledVector(v, half * 3 + 2000);
  const sc = sun.shadow.camera;
  if (sc.right !== half) { sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.near = 10; sc.far = half * 6 + 6000; sc.updateProjectionMatrix(); }
}

async function loadSatellite() {
  if (satState === 'ok' || satState === 'loading') return;
  satState = 'loading';
  setStatus('下載衛星影像……');
  const { minX, maxX, minZ, maxZ } = S.ext;
  const z = 16;
  const W = maxX - minX, H = maxZ - minZ;
  const maxTex = Math.min(renderer.capabilities.maxTextureSize, TOUCH ? 4096 : 8192); // 行動裝置記憶體較小
  const ppm = Math.min(maxTex / Math.max(W, H), 1 / 1.1);
  const cw = Math.round(W * ppm), ch = Math.round(H * ppm);
  const cvs = document.createElement('canvas'); cvs.width = cw; cvs.height = ch;
  const cx = cvs.getContext('2d');
  cx.fillStyle = '#8A8B7C'; cx.fillRect(0, 0, cw, ch);
  const tx0 = Math.floor(lonToPx(toLon(minX), z) / 256), tx1 = Math.floor(lonToPx(toLon(maxX), z) / 256);
  const ty0 = Math.floor(latToPx(toLat(minZ), z) / 256), ty1 = Math.floor(latToPx(toLat(maxZ), z) / 256);
  const tileLon = (x) => x / 2 ** z * 360 - 180;
  const tileLat = (y) => { const n2 = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n2) - Math.exp(-n2))); };
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  log(`衛星影像：Esri World Imagery z${z}，${jobs.length} 張圖磚`);
  let ok = 0, fail = 0;
  const one = ([tx, ty]) => new Promise((res) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const x0 = (toX(tileLon(tx)) - minX) * ppm, x1 = (toX(tileLon(tx + 1)) - minX) * ppm;
      const y0 = (toZ(tileLat(ty)) - minZ) * ppm, y1 = (toZ(tileLat(ty + 1)) - minZ) * ppm;
      cx.drawImage(img, x0, y0, x1 - x0 + 0.6, y1 - y0 + 0.6);
      ok++; if ((ok + fail) % 20 === 0) setStatus(`下載衛星影像…… ${Math.round((ok + fail) / jobs.length * 100)}%`); res();
    };
    img.onerror = () => { fail++; res(); };
    setTimeout(() => { if (!img.complete) { img.src = ''; fail++; res(); } }, 20000);
    img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`;
  });
  const queue = jobs.slice();
  await Promise.all(Array.from({ length: 12 }, async () => { while (queue.length) await one(queue.shift()); }));
  if (ok === 0) { satState = 'fail'; log('衛星影像下載失敗，擬真模式改用地圖底色', 'warn'); setStatus('完成（無衛星影像）'); return; }
  // 區界與區外淡化
  const X = (x) => (x - minX) * ppm, Z = (zz) => (zz - minZ) * ppm;
  cx.fillStyle = 'rgba(236,234,229,0.22)';
  cx.beginPath(); cx.rect(0, 0, cw, ch);
  for (const r of S.boundaryLocal.outer) { r.forEach(([x, zz], k) => (k ? cx.lineTo(X(x), Z(zz)) : cx.moveTo(X(x), Z(zz)))); cx.closePath(); }
  cx.fill('evenodd');
  cx.strokeStyle = 'rgba(255,255,255,0.85)'; cx.lineWidth = Math.max(2, 6 * ppm); cx.setLineDash([40 * ppm, 16 * ppm]);
  for (const r of S.boundaryLocal.outer) { cx.beginPath(); r.forEach(([x, zz], k) => (k ? cx.lineTo(X(x), Z(zz)) : cx.moveTo(X(x), Z(zz)))); cx.closePath(); cx.stroke(); }
  satTex = new THREE.CanvasTexture(cvs);
  satTex.colorSpace = THREE.SRGBColorSpace;
  satTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  satState = 'ok';
  log(`衛星影像：完成 ${ok} 張${fail ? `，失敗 ${fail} 張` : ''}（約 ${(1 / ppm).toFixed(1)} m/px）`);
  setStatus('完成');
}

async function setReal(on) {
  S.real = on;
  document.body.classList.toggle('real', on);
  document.querySelectorAll('[data-real]').forEach((b) => b.classList.toggle('on', (b.dataset.real === 'on') === on));
  if (on) {
    if (!sky) {
      sky = new Sky();
      sky.scale.setScalar(60000);
      const u = sky.material.uniforms;
      u.turbidity.value = 5; u.rayleigh.value = 1.2; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.8;
    }
    scene.add(sky);
    scene.background = null;
    scene.fog = new THREE.FogExp2(0xC9D6DF, 0.000055);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    hemi.color.set(0xCFE0F2); hemi.groundColor.set(0x6F6552);
    sun.castShadow = true;
    controls.maxPolarAngle = Math.PI * 0.499;
    applySun();
    if (S.hf) {
      buildTerrain(); if (S.buildings.length) buildBuildings();
      await loadSatellite();
      if (S.real && satTex) buildTerrain();
    }
  } else {
    if (sky) scene.remove(sky);
    scene.background = new THREE.Color(COL.bg);
    scene.fog = new THREE.Fog(COL.bg, 16000, 40000);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
    hemi.color.set(0xffffff); hemi.groundColor.set(0xB8B2A6); hemi.intensity = 1.35;
    sun.intensity = 1.6; sun.color.set(0xffffff); sun.castShadow = false;
    sun.position.set(-6000, 9000, -4000); sun.target.position.set(0, 0, 0);
    controls.maxPolarAngle = Math.PI * 0.47;
    if (S.hf) { buildTerrain(); if (S.buildings.length) buildBuildings(); }
  }
}

/* ---------- WASD 水平移動（人視點漫遊用） ---------- */
const KEYS = new Set();
let lastMove = 0;
function moveWASD(now) {
  const dt = Math.min(0.05, (now - (lastMove || now)) / 1000); lastMove = now;
  if (!KEYS.size || tween) return;
  const f = new THREE.Vector3().subVectors(controls.target, camera.position); f.y = 0;
  if (f.lengthSq() < 1e-6) return;
  f.normalize();
  const r = new THREE.Vector3(-f.z, 0, f.x);
  const d = camera.position.distanceTo(controls.target);
  const sp = (KEYS.has('shift') ? 3 : 1) * Math.max(12, Math.min(600, d * 0.5));
  const m = new THREE.Vector3();
  if (KEYS.has('w')) m.add(f); if (KEYS.has('s')) m.sub(f);
  if (KEYS.has('d')) m.add(r); if (KEYS.has('a')) m.sub(r);
  if (!m.lengthSq()) return;
  m.normalize().multiplyScalar(sp * dt);
  camera.position.add(m); controls.target.add(m);
  if (S.hf) { const g = heightAt(controls.target.x, controls.target.z) * S.ex; if (controls.target.y < g) controls.target.y = g; }
}

/* ---------- Render loop ---------- */
const compass = $('#compass-needle');
function frame(now) {
  requestAnimationFrame(frame);
  if (tween) tween(now);
  moveWASD(now);
  controls.update();
  if (S.hf) { // 相機不得穿入地面
    const g = heightAt(camera.position.x, camera.position.z) * S.ex + 1.2;
    if (camera.position.y < g) camera.position.y = g;
  }
  if (S.real) updateSunShadow();
  const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
  compass.style.transform = `rotate(${(az * 180 / Math.PI).toFixed(1)}deg)`;
  renderer.render(scene, camera);
  updateLabels();
}

/* ---------- Load pipeline（OSM 資料已內嵌，地形 DEM 執行期下載） ---------- */
async function decodePack() {
  const b64 = window.__PACK_B64;
  if (!b64 || b64.length < 100) throw new Error('找不到內嵌 OSM 資料包');
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const txt = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const pk = JSON.parse(txt);
  const kx = 111320 * Math.cos(pk.lat0 * Math.PI / 180), kz = 110574, u = pk.unit;
  const geo = (d) => { const g = []; let x = 0, z = 0; for (let i = 0; i < d.length; i += 2) { x += d[i]; z += d[i + 1]; g.push({ lon: x * u / kx + pk.lon0, lat: -z * u / kz + pk.lat0 }); } return g; };
  const W = (arr) => arr.map(([id, tags, d]) => ({ type: 'way', id, tags, geometry: geo(d) }));
  const R = (arr) => arr.map(([id, tags, ms]) => ({ type: 'relation', id, tags, members: ms.map(([inner, d]) => ({ type: 'way', role: inner ? 'inner' : 'outer', geometry: geo(d) })) }));
  return {
    fetched: pk.fetched,
    boundary: { elements: R(pk.boundary) },
    features: { elements: [...W(pk.roads), ...W(pk.water), ...R(pk.waterRel)] },
    buildings: { elements: W(pk.bldg) },
    landmarks: { elements: pk.lm.map(([x, z, tags]) => ({ type: 'node', lon: x * u / kx + pk.lon0, lat: -z * u / kz + pk.lat0, tags })) },
  };
}

function flatDEM() {
  const step = CFG.gridStep;
  const nx = Math.ceil((S.ext.maxX - S.ext.minX) / step) + 1, nz = Math.ceil((S.ext.maxZ - S.ext.minZ) / step) + 1;
  return { nx, nz, step, data: new Float32Array(nx * nz).fill(200) };
}

async function main() {
  resize();
  requestAnimationFrame(frame);
  try {
    setStatus('解壓內嵌資料……');
    const PK = await decodePack();
    log(`OSM 資料包：擷取於 ${PK.fetched.slice(0, 10)}（內嵌，不需連線）`);
    const rel = PK.boundary.elements.find((e) => e.type === 'relation');
    if (!rel) throw new Error('資料包缺少行政界');
    const outerW = [], innerW = [];
    for (const m of rel.members) (m.role === 'inner' ? innerW : outerW).push(m.geometry);
    const outer = stitchRings(outerW), inner = stitchRings(innerW);
    let w = 180, e = -180, s = 90, n = -90;
    for (const r of outer) for (const [lon, lat] of r) { w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
    setOrigin((s + n) / 2, (w + e) / 2);
    S.boundary = { outer, inner };
    S.boundaryLocal = {
      outer: outer.map((r) => r.map(([lon, lat]) => [toX(lon), toZ(lat)])),
      inner: inner.map((r) => r.map(([lon, lat]) => [toX(lon), toZ(lat)])),
    };
    const areaKm2 = (S.boundaryLocal.outer.reduce((a, r) => a + Math.abs(ringArea(r)), 0) - S.boundaryLocal.inner.reduce((a, r) => a + Math.abs(ringArea(r)), 0)) / 1e6;
    $('#st-area').textContent = `${areaKm2.toFixed(2)} km²`;
    log(`行政界：${outer.length} 個外環，面積 ${areaKm2.toFixed(2)} km²（OSM 幾何計算）`);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const r of S.boundaryLocal.outer) for (const [x, z] of r) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    const M = CFG.margin;
    S.ext = { minX: minX - M, maxX: maxX + M, minZ: minZ - M, maxZ: maxZ + M };
    $('#st-ext').textContent = `${((maxX - minX) / 1000).toFixed(1)} × ${((maxZ - minZ) / 1000).toFixed(1)} km`;

    // 圖層資料先解析，地形失敗也不影響
    S.features = parseFeatures(PK.features);
    log(`圖層：道路 ${S.features.roads.length}、鐵路 ${S.features.rails.length}、水道 ${S.features.waterways.length}、水域 ${S.features.waterAreas.length}、綠地 ${S.features.parks.length}`);
    $('#st-road').textContent = S.features.roads.length.toLocaleString();

    setStatus('下載地形 DEM……');
    try { S.hf = await loadDEM(); }
    catch (err) { log(`地形 DEM 下載失敗（${err.message}），改以平面顯示`, 'warn'); S.hf = flatDEM(); }
    S.mask = buildMask();
    drawMap();
    buildTerrain();
    $('#st-h').textContent = `${S.hMin.toFixed(0)} – ${S.hMax.toFixed(0)} m`;
    log(`高程（區內）：${S.hMin.toFixed(0)} – ${S.hMax.toFixed(0)} m`);

    S.landmarks = parseLandmarks(PK.landmarks);
    const st = S.landmarks.find((l) => l.kind === 'station' && /豐原/.test(l.name)) || S.landmarks.find((l) => l.kind === 'station');
    S.station = st ? { x: st.x, z: st.z, lat: st.lat, lon: st.lon }
      : { x: toX(CFG.stationFallback[1]), z: toZ(CFG.stationFallback[0]), lat: CFG.stationFallback[0], lon: CFG.stationFallback[1] };
    const rivers = {};
    for (const wv of S.features.waterways) if (wv.kind === 'river' && wv.name) {
      const L = wv.pts.length;
      if (!rivers[wv.name] || rivers[wv.name].L < L) rivers[wv.name] = { L, p: wv.pts[Math.floor(L / 2)] };
    }
    for (const [name, r] of Object.entries(rivers)) S.landmarks.push({ name, kind: 'river', pri: 3, x: r.p[0], z: r.p[1] });
    buildLabels();
    log(`地標：${S.landmarks.length} 處，河川標籤 ${Object.keys(rivers).length} 條`);

    S.buildings = parseBuildings(PK.buildings);
    const grp = new Map(); // 同名細化建物合併一個標籤（取群組形心）
    for (const b of S.buildings) if (b.detail) {
      const k = b.detail.name;
      if (!grp.has(k)) grp.set(k, { D: b.detail, h: b.h, xs: 0, zs: 0, n: 0 });
      const g = grp.get(k);
      b.ring.forEach(([x, z]) => { g.xs += x; g.zs += z; g.n++; });
    }
    for (const [name, g] of grp) {
      const office = g.D.role === 'office';
      S.landmarks.push({ name, kind: office ? 'office' : 'bldg', pri: office ? 0 : 3, x: g.xs / g.n, z: g.zs / g.n, lift: g.h + g.D.penthouse + 6 });
    }
    buildLabels();
    buildBuildings();
    const est = S.buildings.filter((b) => b.est).length;
    $('#st-bldg').textContent = S.buildings.length.toLocaleString();
    $('#st-bldg-est').textContent = S.buildings.length ? `${Math.round(est / S.buildings.length * 100)}%` : '—';
    log(`建物：${S.buildings.length} 棟，其中 ${est} 棟無高度標籤採推估`);

    preset('overview');
    setStatus('完成');
    window.__fy.state = 'ready';
  } catch (err) {
    console.error(err);
    window.__fy.state = 'error';
    window.__fy.errors.push(String(err && err.message || err));
    log(`錯誤：${err.message || err}`, 'err');
    setStatus('載入失敗，詳見紀錄');
  }
}

/* ---------- Controls wiring ---------- */
// 手機／平板直式：面板改為底部抽屜
if (SMALL()) document.body.classList.add('sheet-min');
document.querySelector('.sheet-head').addEventListener('click', () => { if (SMALL()) document.body.classList.toggle('sheet-min'); });
const collapseSheet = () => { if (SMALL()) document.body.classList.add('sheet-min'); };
document.querySelectorAll('[data-preset],[data-focus5]').forEach((b) => b.addEventListener('click', collapseSheet));
document.querySelector('#place').addEventListener('change', collapseSheet);
document.body.classList.toggle('touch', TOUCH);
S.focus5 = false;
function setFocus5(on) {
  S.focus5 = on;
  document.querySelectorAll('[data-focus5]').forEach((x) => x.classList.toggle('on', on));
  buildDetails();
  if (bldgMesh) { bldgMesh.material.transparent = on; bldgMesh.material.opacity = on ? 0.35 : 1; bldgMesh.material.depthWrite = !on; bldgMesh.material.needsUpdate = true; }
  const lm = S.landmarks.find((l) => l.kind === 'office'); const b = S.buildings.find((x) => x.detail && x.detail.role === 'office');
  if (lm && b) { lm.lift = on ? (b.y5t - b.base * S.ex) + 4 : b.h + b.detail.penthouse + 6; lm.name = on ? `${b.detail.name} · ${b.detail.focusFloor}F` : b.detail.name; buildLabels(); }
  if (on) preset('office');
}
document.querySelectorAll('[data-focus5]').forEach((x) => x.addEventListener('click', () => { if (S.buildings.length) setFocus5(!S.focus5); }));
document.querySelectorAll('[data-real]').forEach((b) => b.addEventListener('click', () => { if (S.ext) setReal(b.dataset.real === 'on'); }));
{
  const dEl = document.querySelector('#sun-date'), hEl = document.querySelector('#sun-hour'), hv = document.querySelector('#sun-hour-val');
  const t = new Date();
  dEl.value = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  const fmt = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  hv.textContent = fmt(SUN.hour);
  dEl.addEventListener('change', () => { const [y, m, d] = dEl.value.split('-').map(Number); if (y) { SUN.date = new Date(y, m - 1, d); applySun(); } });
  hEl.addEventListener('input', () => { SUN.hour = +hEl.value; hv.textContent = fmt(SUN.hour); applySun(); });
  document.querySelectorAll('[data-season]').forEach((b) => b.addEventListener('click', () => {
    const y = SUN.date.getFullYear(); const [m, d] = b.dataset.season.split('-').map(Number);
    SUN.date = new Date(y, m - 1, d); dEl.value = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; applySun();
  }));
}
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.tool === 'extents') { if (S.ext) preset('overview'); return; }
  setTool(b.dataset.tool);
}));
let spaceHeld = false, toolBeforeSpace = 'orbit';
window.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'h' && !e.metaKey && !e.ctrlKey) setTool('pan');
  else if (k === 'o' && !e.metaKey && !e.ctrlKey) setTool('orbit');
  else if (k === 'z' && e.shiftKey && S.ext) preset('overview');
  else if (e.code === 'Space' && !spaceHeld) { spaceHeld = true; toolBeforeSpace = TOOL.mode; setTool('pan'); e.preventDefault(); }
});
window.addEventListener('keydown', (e) => { if (e.target.closest && e.target.closest('input, textarea')) return; const k = e.key.toLowerCase(); if ('wasd'.includes(k) && k.length === 1 && !e.metaKey && !e.ctrlKey) KEYS.add(k); if (k === 'shift') KEYS.add('shift'); });
window.addEventListener('keyup', (e) => { const k = e.key.toLowerCase(); KEYS.delete(k); if (k === 'shift') KEYS.delete('shift'); });
window.addEventListener('blur', () => KEYS.clear());
window.addEventListener('keyup', (e) => { if (e.code === 'Space' && spaceHeld) { spaceHeld = false; setTool(toolBeforeSpace); } });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

document.querySelectorAll('[data-layer]').forEach((cb) => {
  cb.checked = S.layers[cb.dataset.layer];
  cb.addEventListener('change', () => {
    S.layers[cb.dataset.layer] = cb.checked;
    const k = cb.dataset.layer;
    if (k === 'terrain') { if (terrainMesh) terrainMesh.visible = cb.checked; if (baseMesh) baseMesh.visible = cb.checked; }
    else if (k === 'buildings') { if (detailGroup) detailGroup.visible = cb.checked; if (bldgMesh) { bldgMesh.visible = cb.checked; bldgEdges.visible = cb.checked && !S.real; } if (!cb.checked) clearHighlight(); }
    else if (k === 'labels') { /* handled per frame */ }
    else if (k === 'villages') buildLabels();
    else if (S.hf) drawMap();
  });
});
const exEl = $('#ex'), exVal = $('#ex-val');
exEl.addEventListener('input', () => { exVal.textContent = `${(+exEl.value).toFixed(1)}×`; });
exEl.addEventListener('change', () => {
  S.ex = +exEl.value;
  if (!S.hf) return;
  buildTerrain();
  if (S.buildings.length) buildBuildings();
});
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => S.ext && preset(b.dataset.preset)));
$('#reload').addEventListener('click', async () => { await idb.clear(); location.reload(); }); // 僅清除 DEM 快取
$('#toggle-panel').addEventListener('click', () => document.body.classList.toggle('panel-off'));
$('#shot').addEventListener('click', () => {
  renderer.render(scene, camera);
  const a = document.createElement('a');
  a.href = renderer.domElement.toDataURL('image/png');
  a.download = `fengyuan-3d-${new Date().toISOString().slice(0, 10)}.png`;
  a.click();
});

main();
