// 配件大亂鬥 3D 畫面模組：Three.js 場景、固定斜上方鏡頭、角色（暫代模型或 .glb）、特效與頭上標籤
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export const GEAR_INFO = {
  // tag 類型、stats [威力, 距離, 速度]（1~5，大廳顯示用）、light/heavy 招式說明、ult [大絕名, 說明]
  flame:   { name: '炎拳手套', color: '#ff5a1f', range: 50, hrange: 56, tag: '近戰・爆發', stats: [5, 2, 3],
    light: '三段重拳，近身傷害最高', heavy: '蓄力重擊，打中擊倒', ult: ['爆炎衝拳', '向前突進，可破防並擊飛'] },
  staff:   { name: '疾風長棍', color: '#38c6a5', range: 80, hrange: 90, tag: '近戰・範圍', stats: [3, 5, 2],
    light: '三段棍擊，攻擊距離最長', heavy: '長距離重擊，打中擊倒', ult: ['旋風斬', '原地迴旋，打飛周圍所有人'] },
  blaster: { name: '雷光砲',   color: '#5ab4ff', range: 48, hrange: 62, tag: '射擊・速攻', stats: [2, 3, 4],
    light: '出手最快，第三段噴出五顆散彈', heavy: '砲身重擊，打中擊倒', ult: ['電漿彈', '遠距離射擊，冷卻最短'] },
  greatsword: { name: '巨劍', color: '#e8c15a', range: 74, hrange: 82, tag: '重裝・蓄力', stats: [5, 4, 1],
    light: '三段揮砍，最慢但最遠', heavy: '按住 C 蓄力，最多 2 倍傷害', ult: ['破山斬', '跳起砸地，衝擊波擊飛周圍'] },
  axe:     { name: '戰斧',     color: '#d07a3e', range: 58, hrange: 62, tag: '投擲・均衡', stats: [4, 3, 3],
    light: '三段劈砍，速度平均', heavy: '丟出短程飛斧，打中擊倒', ult: ['迴旋飛斧', '丟出後飛回，去回都能打中'] },
  dagger:  { name: '影匕首',   color: '#a87bff', range: 42, hrange: 46, tag: '刺客・連擊', stats: [2, 1, 5],
    light: '五段快速連擊，第五段擊倒', heavy: '突刺重擊，打中擊倒', ult: ['影襲', '瞬移到敵人背後背刺並暈眩'] },
  wand:    { name: '冰霜魔杖', color: '#8fe3ff', range: 50, hrange: 56, tag: '法術・控制', stats: [2, 4, 3],
    light: '發射冰彈，第三段大冰彈擊倒', heavy: '近身重擊，打中擊倒', ult: ['冰霜新星', '冰凍周圍敵人 1.2 秒'] },
};

const CAM_PITCH = THREE.MathUtils.degToRad(55); // 鏡頭俯角（跟英雄聯盟差不多）
const CAM_FOV = 35;
const BODY_SCALE = 1.5; // 角色外觀放大倍率（讓斜上方視角看得清楚，也比較接近碰撞半徑）

let renderer, scene, camera, overlay, octx, MAP = null;
let W = 1, H = 1, dpr = 1;
// 角色素材：manifest.json 設定可選角色、共用動作檔、動作名稱對照
const manifest = { characters: {}, animations: [], clips: {}, handBones: {} };
let readyResolve;
export const ready = new Promise((r) => { readyResolve = r; }); // manifest 讀完後 resolve
const modelCache = new Map();   // 模型檔路徑 → { gltf } 或 { loading: true }
const animClips = {};           // 動作名稱(小寫) → AnimationClip（所有共用動作檔合併）
const loader = new GLTFLoader();
let shake = 0;
let reticle = null;
const camTarget = new THREE.Vector3();
const rigs = new Map();
const crateMeshes = new Map();
const projMeshes = new Map();
const floaters = [];
const particles = [];
const texts = [];
const tmpV = new THREE.Vector3();

/* ------------------------------------------------------------ 共用材質與小工具 */

const MATS = {
  skin: new THREE.MeshStandardMaterial({ color: '#ffd7b0', roughness: 0.6 }),
  dark: new THREE.MeshStandardMaterial({ color: '#2b2440', roughness: 0.7 }),
  white: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.5 }),
  hair: new THREE.MeshStandardMaterial({ color: '#3b2a22', roughness: 0.8 }),
  eye: new THREE.MeshBasicMaterial({ color: '#1b1b2b' }),
  glove: new THREE.MeshStandardMaterial({ color: '#ff5a1f', emissive: '#ff3a00', emissiveIntensity: 0.35, roughness: 0.4 }),
  cuff: new THREE.MeshStandardMaterial({ color: '#ffd166', roughness: 0.4, metalness: 0.3 }),
  wood: new THREE.MeshStandardMaterial({ color: '#a8743c', roughness: 0.8 }),
  teal: new THREE.MeshStandardMaterial({ color: '#38c6a5', roughness: 0.3, metalness: 0.5 }),
  navy: new THREE.MeshStandardMaterial({ color: '#3b4a6b', roughness: 0.4, metalness: 0.4 }),
  steel: new THREE.MeshStandardMaterial({ color: '#6f84b3', roughness: 0.3, metalness: 0.6 }),
  glowCyan: new THREE.MeshBasicMaterial({ color: '#bfeaff' }),
};

// 建立會投影的 mesh 並放到指定位置
function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

// 發光用的半透明疊加材質
function glowMat(color, opacity = 0.6) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
}

// 固定亂數（讓地圖裝飾每次都長一樣）
function seeded(seed) {
  return () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
}

// 用 canvas 畫圖當貼圖
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------ 初始化 */

// 建立 WebGL 畫布、場景與鏡頭；若 manifest 有指定角色模型就載入
export function init(glCanvas, overlayCanvas) {
  renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  scene = new THREE.Scene();
  scene.background = canvasTex(4, 512, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#0b1230');
    gr.addColorStop(1, '#2a3f78');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
  camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 10, 9000);
  overlay = overlayCanvas;
  octx = overlay.getContext('2d');
  resize();
  addEventListener('resize', resize);
  fetch('assets/manifest.json').then((r) => (r.ok ? r.json() : {})).then((m) => {
    Object.assign(manifest, m || {});
    for (const file of manifest.animations || []) {
      loader.load('assets/' + file, (g) => {
        for (const c of g.animations) animClips[c.name.toLowerCase()] = c;
      }, undefined, (e) => console.warn('動作檔載入失敗', file, e));
    }
  }).catch(() => {}).finally(() => readyResolve());
}

// 大廳用：列出可選角色 [{ key, name }]
export function characterList() {
  return Object.entries(manifest.characters || {}).map(([key, c]) => ({ key, name: c.name || key, en: c.en || key.toUpperCase() }));
}

// 依玩家選的角色找出設定；沒選（例如電腦）就依 id 平均分配
function charDef(p) {
  const keys = Object.keys(manifest.characters || {});
  if (!keys.length) return null;
  const key = manifest.characters[p.ch] ? p.ch : keys[Math.abs(p.id | 0) % keys.length];
  return manifest.characters[key];
}

// 取得已載入的模型；還沒載入就開始載入並先回傳 null
function getModel(file) {
  const c = modelCache.get(file);
  if (c) return c.gltf || null;
  modelCache.set(file, { loading: true });
  loader.load('assets/' + file, (g) => modelCache.set(file, { gltf: g }),
    undefined, (e) => { console.warn('角色模型載入失敗', file, e); modelCache.set(file, { failed: true }); });
  return null;
}

// 角色應該使用的模型識別碼（模型載入完成後會改變，觸發重建）
function rigKey(p) {
  const def = charDef(p);
  const base = def && getModel(def.file) ? def.file : 'prim';
  const gm = (manifest.gearModels || {})[p.g];
  return base + (gm && getModel(gm.file) ? '|' + gm.file : ''); // 配件模型載入完也要重建
}

// 視窗大小改變時調整畫布與鏡頭比例
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  renderer.setPixelRatio(dpr);
  renderer.setSize(W, H, false);
  overlay.width = W * dpr; overlay.height = H * dpr;
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
}

/* ------------------------------------------------------------ 地圖 */

// 該位置的地面高度：柱子頂上是柱子高度，其他地方是 0（跟伺服器 ground_z 一致）
function groundZ(x, y) {
  if (MAP) for (const r of MAP.pillars) if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.hgt || 0;
  return 0;
}

// 角色是否在空中（站在柱子頂上不算）
function airborne(p) {
  return p.z - groundZ(p.x, p.y) > 1;
}

// 收到地圖資料後建立整個浮空競技場
export function setMap(map) {
  if (MAP) return;
  MAP = map;
  const P = MAP.platform;
  const cx = P.x + P.w / 2, cz = P.y + P.h / 2;
  camTarget.set(cx, 0, cz);

  // 光源：天光 + 左上方的太陽（有陰影）
  scene.add(new THREE.HemisphereLight('#c8d8ff', '#3a2d55', 1.3));
  const sun = new THREE.DirectionalLight('#fff4e0', 2.4);
  sun.position.set(cx - 600, 1200, cz + 350);
  sun.target.position.set(cx, 0, cz);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -900, right: 900, top: 900, bottom: -900, near: 100, far: 3500 });
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);

  // 平台本體
  const floor = new THREE.MeshStandardMaterial({ map: floorTexture(P), roughness: 0.85 });
  floor.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const side = new THREE.MeshStandardMaterial({ color: '#6b5a8a', roughness: 1 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(P.w, 28, P.h), [side, side, floor, side, side, side]);
  slab.position.set(cx, -14, cz);
  slab.receiveShadow = true;
  scene.add(slab);

  // 平台底下的倒錐形岩塊（浮島感）
  const rnd = seeded(11);
  const rockMat = new THREE.MeshStandardMaterial({ color: '#4b3d63', roughness: 1, flatShading: true });
  const coneGeo = new THREE.ConeGeometry(1, 1, 10, 4);
  const pos = coneGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0.49) continue;
    pos.setXYZ(i, pos.getX(i) * (0.85 + rnd() * 0.3), pos.getY(i) + (rnd() - 0.5) * 0.08, pos.getZ(i) * (0.85 + rnd() * 0.3));
  }
  coneGeo.computeVertexNormals();
  const cone = new THREE.Mesh(coneGeo, rockMat);
  cone.scale.set(P.w * 0.62, 460, P.h * 0.72);
  cone.rotation.x = Math.PI;
  cone.position.set(cx, -28 - 230, cz);
  scene.add(cone);

  // 柱子
  const pillarSide = new THREE.MeshStandardMaterial({ color: '#8a93b8', roughness: 0.9 });
  const pillarTop = new THREE.MeshStandardMaterial({ color: '#b3bde0', roughness: 0.8 });
  for (const r of MAP.pillars) {
    const ph = r.hgt || 56; // 柱頂高度＝可以跳上去站的高度（跟伺服器一致）
    const m = new THREE.Mesh(new THREE.BoxGeometry(r.w, ph - 4, r.h), [pillarSide, pillarSide, pillarTop, pillarSide, pillarSide, pillarSide]);
    m.position.set(r.x + r.w / 2, (ph - 4) / 2, r.y + r.h / 2);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(r.w + 10, 8, r.h + 10), pillarTop);
    cap.position.set(r.x + r.w / 2, ph - 4, r.y + r.h / 2);
    cap.castShadow = cap.receiveShadow = true;
    scene.add(cap);
  }

  // 周圍漂浮的小岩塊
  const grass = new THREE.MeshStandardMaterial({ color: '#6c8f5a', roughness: 1, flatShading: true });
  for (let i = 0; i < 14; i++) {
    let x, z;
    do { x = -300 + rnd() * (MAP.w + 600); z = -200 + rnd() * (MAP.h + 500); }
    while (x > P.x - 120 && x < P.x + P.w + 120 && z > P.y - 120 && z < P.y + P.h + 200);
    const s = 18 + rnd() * 40;
    const g = new THREE.Group();
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rockMat);
    rock.scale.y = 1.3;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.95, s * 0.95, 6, 7), grass);
    top.position.y = s * 0.9;
    g.add(rock, top);
    g.position.set(x, -80 - rnd() * 200, z);
    g.userData = { base: g.position.y, phase: rnd() * 6 };
    scene.add(g);
    floaters.push(g);
  }

  // 下方深空的星星
  const starPos = [];
  for (let i = 0; i < 700; i++) starPos.push(-2500 + rnd() * (MAP.w + 5000), -3000 + rnd() * 2600, -2500 + rnd() * (MAP.h + 5000));
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: '#dfe7ff', size: 3, sizeAttenuation: false })));

  // 瞄準準心（地上四個角）
  reticle = new THREE.Group();
  const rm = glowMat('#ff4d6d', 0.95);
  for (let i = 0; i < 4; i++) {
    const a = new THREE.Mesh(new THREE.RingGeometry(30, 36, 8, 1, i * Math.PI / 2 + 0.25, Math.PI / 2 - 0.5).rotateX(-Math.PI / 2), rm);
    reticle.add(a);
  }
  reticle.visible = false;
  scene.add(reticle);
}

// 平台地面的貼圖：地磚、中央徽章、邊緣警示線
function floorTexture(P) {
  const w = 2048, h = Math.round(2048 * P.h / P.w);
  return canvasTex(w, h, (g) => {
    const tiles = P.w / 55;
    const t = w / tiles;
    for (let y = 0; y * t < h; y++) {
      for (let x = 0; x < tiles; x++) {
        g.fillStyle = (x + y) % 2 ? '#8d9cc4' : '#8293bd';
        g.fillRect(x * t, y * t, t, t);
        g.strokeStyle = 'rgba(40,50,90,0.25)';
        g.lineWidth = 2;
        g.strokeRect(x * t, y * t, t, t);
      }
    }
    const k = w / P.w;
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 12 * k;
    g.beginPath(); g.arc(w / 2, h / 2, 90 * k, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(255,180,61,0.25)';
    g.beginPath(); g.arc(w / 2, h / 2, 40 * k, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#ffd166';
    g.lineWidth = 12 * k;
    g.setLineDash([44 * k, 28 * k]);
    g.strokeRect(10 * k, 10 * k, w - 20 * k, h - 20 * k);
    g.setLineDash([]);
  });
}

/* ------------------------------------------------------------ 角色 */

// 建立一個角色（有 .glb 用模型，沒有就用程式拼的暫代模型）
export function makeRig(p) {
  const rig = { id: p.id, gear: null, color: null, root: new THREE.Group(), body: new THREE.Group(), gearObjs: [], tintMats: [] };
  rig.root.add(rig.body);
  rig.body.scale.setScalar(BODY_SCALE);
  rig.key = rigKey(p);
  const def = charDef(p);
  const gltf = rig.key !== 'prim' ? getModel(def.file) : null;
  let skinned = false;
  if (gltf) gltf.scene.traverse((o) => { if (o.isSkinnedMesh) skinned = true; });
  if (gltf && skinned) buildModelBody(rig, gltf, def);
  else if (gltf) buildSegmentedBody(rig, gltf, def);
  else buildPrimitiveBody(rig);
  buildRigFx(rig);
  // 腳下的玩家顏色光圈（模型無法換色時靠它分辨玩家）
  rig.ringMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false });
  rig.ring = new THREE.Mesh(new THREE.RingGeometry(24, 30, 40).rotateX(-Math.PI / 2), rig.ringMat);
  rig.ring.position.y = 0.6;
  rig.root.add(rig.ring);
  applyLook(rig, p);
  return rig;
}

// 暫代模型：Q 版大頭、頭帶、手腳
function buildPrimitiveBody(rig) {
  const b = rig.body;
  rig.prim = true;
  rig.bodyMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.45 });
  rig.tintMats.push(rig.bodyMat);
  rig.flashMats = [rig.bodyMat];
  rig.handRest = { L: new THREE.Vector3(-15, 24, 2), R: new THREE.Vector3(15, 24, 2) };
  b.add(mesh(new THREE.CapsuleGeometry(11, 8, 4, 14), rig.bodyMat, 0, 21, 0));
  const belt = mesh(new THREE.TorusGeometry(11.3, 1.8, 8, 24), MATS.dark, 0, 17, 0);
  belt.rotation.x = Math.PI / 2;
  b.add(belt);
  const head = new THREE.Group();
  head.position.set(0, 46, 0);
  head.add(mesh(new THREE.SphereGeometry(16, 28, 20), MATS.skin));
  const hair = mesh(new THREE.SphereGeometry(16.8, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.5), MATS.hair, 0, 1, -1);
  hair.rotation.x = -0.3;
  head.add(hair);
  const band = mesh(new THREE.TorusGeometry(16.4, 2.1, 8, 28), MATS.white, 0, 5, 0);
  band.rotation.x = Math.PI / 2 - 0.15;
  head.add(band);
  for (const s of [-1, 1]) {
    const tail = mesh(new THREE.BoxGeometry(3, 2, 14), MATS.white, s * 3, 4, -20);
    tail.rotation.set(0.5, s * 0.35, 0);
    head.add(tail);
    head.add(mesh(new THREE.CapsuleGeometry(1.9, 3.2, 4, 8), MATS.eye, s * 5.5, 0, 14.6));
    head.add(mesh(new THREE.SphereGeometry(0.8, 8, 6), MATS.white, s * 5.5 + 0.6, 1.6, 16.2));
  }
  b.add(head);
  rig.footL = mesh(new THREE.BoxGeometry(8, 6, 13), MATS.dark, -6, 3, 1);
  rig.footR = mesh(new THREE.BoxGeometry(8, 6, 13), MATS.dark, 6, 3, 1);
  b.add(rig.footL, rig.footR);
  rig.handL = new THREE.Group();
  rig.handR = new THREE.Group();
  rig.fistL = mesh(new THREE.SphereGeometry(4.8, 14, 10), MATS.skin);
  rig.fistR = mesh(new THREE.SphereGeometry(4.8, 14, 10), MATS.skin);
  rig.handL.add(rig.fistL);
  rig.handR.add(rig.fistR);
  b.add(rig.handL, rig.handR);
}

// 分件式模型（沒有骨架、但手腳頭是分開的零件）：依名稱分組，在肩膀/髖部/脖子建立轉軸
function buildSegmentedBody(rig, gltf, def) {
  const src = gltf.scene.clone(true);
  src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src);
  const s = 62 / Math.max(1e-6, box.max.y - box.min.y);
  const model = new THREE.Group();
  model.scale.setScalar(s);
  model.position.y = -box.min.y * s;
  rig.body.add(model);
  const tint = (def.tint || []).map((t) => t.toLowerCase());
  const groups = { armL: [], armR: [], legL: [], legR: [], head: [], torso: [] };
  const meshes = [];
  src.traverse((o) => { if (o.isMesh) meshes.push(o); });
  rig.flashMats = [];
  for (const m of meshes) {
    const bb = new THREE.Box3().setFromObject(m);
    const n = m.name.toLowerCase();
    const side = (bb.min.x + bb.max.x) / 2 > 0 ? 'R' : 'L';
    let cat = 'torso';
    if (/shoulder|arm|glove|finger|thumb|hand/.test(n)) cat = 'arm' + side;
    else if (/pants|leg|cuff|shoe|sole|strap|foot|boot/.test(n)) cat = 'leg' + side;
    else if (/head|ear|hair|spike|band|ribbon|eye|iris|glint|brow|smile|mouth|nose|neck/.test(n)) cat = 'head';
    groups[cat].push({ m, bb, n });
    m.material = m.material.clone();
    if (!m.material.map && m.material.metalness > 0.5) { // 沒材質的檔案預設是金屬，會一片黑
      m.material.metalness = 0;
      m.material.roughness = 0.6;
    }
    m.castShadow = true;
    rig.flashMats.push(m.material);
    if (tint.some((t) => n.startsWith(t)) || /tint/i.test(m.material.name)) rig.tintMats.push(m.material);
  }
  const union = (list) => list.reduce((b, it) => b.union(it.bb), new THREE.Box3());
  const find = (list, re) => list.find((it) => re.test(it.n));
  // 把一組零件搬到以 pivot 為原點的群組下
  const mk = (list, pivot) => {
    const g = new THREE.Group();
    g.position.copy(pivot);
    model.add(g);
    for (const { m } of list) {
      m.matrixWorld.decompose(m.position, m.quaternion, m.scale);
      m.position.sub(pivot);
      g.add(m);
    }
    return g;
  };
  const toBody = (v) => new THREE.Vector3(v.x * s, v.y * s + model.position.y, v.z * s);
  const segs = {};
  rig.handRest = {};
  for (const side of ['L', 'R']) {
    const list = groups['arm' + side];
    const ub = union(list);
    const sh = find(list, /shoulder/);
    const pivot = sh ? sh.bb.getCenter(new THREE.Vector3())
      : new THREE.Vector3(side === 'R' ? ub.min.x + (ub.max.x - ub.min.x) * 0.2 : ub.max.x - (ub.max.x - ub.min.x) * 0.2, ub.max.y - (ub.max.y - ub.min.y) * 0.15, (ub.min.z + ub.max.z) / 2);
    const gl = find(list, /glove(?!_cuff)|hand|fist/);
    const handPt = gl ? gl.bb.getCenter(new THREE.Vector3()) : new THREE.Vector3((side === 'R' ? ub.max.x : ub.min.x), ub.min.y, (ub.min.z + ub.max.z) / 2);
    segs['arm' + side] = mk(list, pivot);
    const shB = toBody(pivot), hB = toBody(handPt);
    segs['sh' + side] = shB;
    segs['len' + side] = shB.distanceTo(hB);
    segs['rest' + side] = hB.clone().sub(shB).normalize();
    rig.handRest[side] = hB;
    const lb = union(groups['leg' + side]);
    segs['leg' + side] = mk(groups['leg' + side], new THREE.Vector3((lb.min.x + lb.max.x) / 2, lb.max.y, (lb.min.z + lb.max.z) / 2));
  }
  const hb = union(groups.head);
  segs.head = mk(groups.head, new THREE.Vector3(0, hb.min.y, (hb.min.z + hb.max.z) / 2));
  mk(groups.torso, new THREE.Vector3());
  rig.segs = segs;
  rig.handL = new THREE.Group();
  rig.handR = new THREE.Group();
  rig.handL.position.copy(rig.handRest.L);
  rig.handR.position.copy(rig.handRest.R);
  rig.body.add(rig.handL, rig.handR);
}

// 分件式模型：腿擺動、頭微動、手臂轉向手部目標位置（簡易 IK）
const _q = new THREE.Quaternion();
const _d = new THREE.Vector3();
function poseSegments(rig, p, now, sw) {
  const S = rig.segs;
  let la = -sw * 0.7, lb = sw * 0.7;
  if (airborne(p)) { la = -0.6; lb = 0.3; }
  if (p.s === 'airatk') { la = 0.2; lb = -1.3; }
  if (p.s === 'guard') { la = -0.2; lb = 0.25; }
  S.legL.rotation.set(la, 0, 0);
  S.legR.rotation.set(lb, 0, 0);
  S.head.rotation.set(p.s === 'hitstun' ? -0.25 : 0, 0, Math.sin(now / 600) * 0.04);
  for (const side of ['L', 'R']) {
    const hand = side === 'L' ? rig.handL : rig.handR;
    _d.copy(hand.position).sub(S['sh' + side]);
    if (_d.lengthSq() < 1e-4) continue;
    _d.normalize();
    _q.setFromUnitVectors(S['rest' + side], _d);
    S['arm' + side].quaternion.copy(_q);
    hand.position.copy(S['sh' + side]).addScaledVector(_d, S['len' + side]);
  }
}

// 正式模型：複製 .glb、縮放到身高約 62、找出要染色的材質與手部骨頭
function buildModelBody(rig, gltf, def) {
  const model = cloneSkinned(gltf.scene);
  const box = new THREE.Box3().setFromObject(model);
  const s = 62 / Math.max(1e-6, box.max.y - box.min.y);
  model.scale.setScalar(s);
  model.position.y = -box.min.y * s;
  const tint = (def.tint || []).map((t) => t.toLowerCase());
  const hb = manifest.handBones || {};
  rig.flashMats = [];
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.frustumCulled = false; // 蒙皮模型的包圍盒不跟著動作更新，避免被誤裁掉
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const cloned = mats.map((m) => {
        const c = m.clone();
        rig.flashMats.push(c);
        if (/tint/i.test(m.name) || tint.some((t) => o.name.toLowerCase().startsWith(t))) rig.tintMats.push(c);
        return c;
      });
      o.material = Array.isArray(o.material) ? cloned : cloned[0];
    }
    if (o.isBone) {
      // Three.js 載入時會拿掉名稱裡的「.」等符號（handslot.r → handslotr），比對時兩邊都去掉
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const n = o.name.toLowerCase();
      if (hb.R && norm(o.name) === norm(hb.R)) rig.boneR = o;
      if (hb.L && norm(o.name) === norm(hb.L)) rig.boneL = o;
      if (!hb.R && !rig.boneR && /(right.?hand|hand[._]r)$/.test(n)) rig.boneR = o;
      if (!hb.L && !rig.boneL && /(left.?hand|hand[._]l)$/.test(n)) rig.boneL = o;
    }
  });
  rig.body.add(model);
  rig.model = model;
  rig.mixer = new THREE.AnimationMixer(model);
  rig.clips = {};
  for (const c of gltf.animations) rig.clips[c.name.toLowerCase()] = c;
  rig.handR = rig.boneR || new THREE.Group();
  rig.handL = rig.boneL || new THREE.Group();
  if (!rig.boneR) { rig.handR.position.set(15, 24, 4); rig.body.add(rig.handR); }
  if (!rig.boneL) { rig.handL.position.set(-15, 24, 4); rig.body.add(rig.handL); }
}

// 角色身上的特效物件：刀光、防禦盾、旋風、衝刺火焰、蓄力光、暈眩星星、頭上木箱
function buildRigFx(rig) {
  rig.slash = new THREE.Mesh(new THREE.RingGeometry(0.78, 1, 28, 1, -Math.PI / 2 - 0.85, 1.7).rotateX(-Math.PI / 2), glowMat('#ffffff', 0.7));
  rig.slash.position.y = 28;
  rig.shield = new THREE.Mesh(new THREE.CylinderGeometry(32, 32, 46, 20, 1, true, -1.1, 2.2), glowMat('#6ebeff', 0.45));
  rig.shield.position.y = 28;
  rig.spinRing = new THREE.Mesh(new THREE.RingGeometry(66, 92, 48).rotateX(-Math.PI / 2), glowMat('#38c6a5', 0.4));
  rig.spinRing.position.y = 24;
  rig.aura = new THREE.Mesh(new THREE.SphereGeometry(26, 16, 12), glowMat('#ff7a1a', 0.55));
  rig.aura.position.set(0, 28, 24);
  rig.stars = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const st = new THREE.Mesh(new THREE.OctahedronGeometry(4), new THREE.MeshBasicMaterial({ color: '#ffe066' }));
    rig.stars.add(st);
  }
  rig.stars.position.y = 74 * BODY_SCALE;
  rig.heldCrate = mesh(new THREE.BoxGeometry(30, 30, 30), crateMat(), 0, 80, 0);
  rig.charge = new THREE.Mesh(new THREE.SphereGeometry(6, 14, 10), glowMat('#ffffff', 0.8));
  // 被冰凍時包住角色的冰塊
  rig.ice = new THREE.Mesh(new THREE.BoxGeometry(46, 100, 46),
    new THREE.MeshStandardMaterial({ color: '#bfefff', transparent: true, opacity: 0.45, roughness: 0.1, metalness: 0.1, depthWrite: false }));
  rig.ice.position.y = 50;
  rig.root.add(rig.ice);
  // 冰霜魔杖詠唱時腳下的魔法陣
  rig.circle = new THREE.Mesh(new THREE.RingGeometry(30, 40, 6).rotateX(-Math.PI / 2), glowMat('#8fe3ff', 0.7));
  rig.circle.position.y = 1;
  rig.root.add(rig.circle);
  rig.root.add(rig.slash, rig.shield, rig.spinRing, rig.aura, rig.stars);
  rig.body.add(rig.heldCrate);
  rig.handR.add(rig.charge);
  rig.chargeBase = handUnscale(rig, rig.handR);
}

// 掛在骨頭上的物件要乘上的縮放，讓它跟身體同比例（骨頭常帶模型縮放，例如 KayKit 手部骨頭是 54 倍）
function handUnscale(rig, hand) {
  if (!hand.isBone) return 1;
  rig.root.updateMatrixWorld(true);
  const bs = rig.body.getWorldScale(new THREE.Vector3()).x;
  return bs / hand.getWorldScale(new THREE.Vector3()).x;
}

// 依玩家資料更新顏色與配件（有變才重建）
function applyLook(rig, p) {
  if (rig.color !== p.c) {
    rig.color = p.c;
    for (const m of rig.tintMats) m.color.set(p.c);
    if (rig.ringMat) rig.ringMat.color.set(p.c);
  }
  if (rig.gear !== p.g) {
    rig.gear = p.g;
    setGear(rig, p.g);
    rig.charge.material.color.set(GEAR_INFO[p.g].color);
  }
}

// 把不是照手部骨頭做的模型（例如 AI 生成的 GLB）置中並縮到指定大小，再套 manifest 的角度與位移
// size = 最長邊的長度（身體單位）；gm.rotation 為度數 [x,y,z]，gm.offset 為 [x,y,z]
function fitGearModel(gltf, size, gm) {
  const inner = gltf.scene.clone(true);
  inner.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    // AI 生成的 GLB 常沒寫金屬度（glTF 預設 1 = 全金屬），沒環境貼圖時會整個變黑，用 manifest 覆寫
    if (gm.metalness != null) for (const m of [].concat(o.material)) m.metalness = gm.metalness;
  });
  const box = new THREE.Box3().setFromObject(inner);
  const dim = box.getSize(new THREE.Vector3());
  const k = size / (Math.max(dim.x, dim.y, dim.z) || 1);
  inner.scale.setScalar(k);
  inner.position.copy(box.getCenter(new THREE.Vector3()).multiplyScalar(-k));
  const pivot = new THREE.Group(); // 旋轉繞著模型中心
  pivot.add(inner);
  if (gm.rotation) pivot.rotation.set(...gm.rotation.map((d) => THREE.MathUtils.degToRad(d)));
  if (gm.offset) pivot.position.set(...gm.offset);
  return pivot;
}

// 把配件模型掛到手上
function setGear(rig, gear) {
  for (const o of rig.gearObjs) o.parent && o.parent.remove(o);
  rig.gearObjs = [];
  rig.staff = rig.gun = null;
  if (rig.prim) rig.fistL.visible = rig.fistR.visible = gear !== 'flame';
  const gr = manifest.gearRotation; // 骨頭座標軸跟配件不同時，用 manifest 調整角度（度）
  // native = 模型本來就是照這根骨頭做的（例如 KayKit 武器配 handslot），不做任何縮放旋轉
  const attach = (hand, obj, native) => {
    hand.add(obj);
    rig.gearObjs.push(obj);
    if (hand.isBone && !native) { // 骨頭帶有模型縮放，換算成跟身體一樣的大小
      obj.scale.multiplyScalar(handUnscale(rig, hand));
      if (gr) obj.rotation.set(...gr.map((d) => THREE.MathUtils.degToRad(d)));
    }
  };
  // manifest.gearModels 有指定模型就優先使用
  const gm = (manifest.gearModels || {})[gear];
  const gltf = gm ? getModel(gm.file) : null;
  if (gltf && gm.hands === 'both') { // 兩手各掛一份（例如炎拳手套），左手鏡像
    const onBone = rig.handR.isBone;
    for (const hand of [rig.handL, rig.handR]) {
      const g = new THREE.Group();
      g.add(fitGearModel(gltf, onBone ? (gm.boneSize || 10) : (gm.size || 18), gm));
      attach(hand, g);
      if (hand === rig.handL && gm.mirrorLeft !== false) g.scale.x *= -1;
    }
    return;
  }
  if (gltf) {
    const g = new THREE.Group();
    const inner = gltf.scene.clone(true);
    inner.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.add(inner);
    if (rig.handR.isBone) attach(rig.handR, g, true);
    else { // 沒骨架的角色：換算成身體單位，長軸從 +Y 轉到 +Z（跟程式動畫的方向一致）
      inner.scale.setScalar(gm.scale || 36);
      inner.rotation.x = Math.PI / 2;
      attach(rig.handR, g);
    }
    if (gear === 'staff') rig.staff = g; else rig.gun = g;
    return;
  }
  if (gear === 'flame') {
    const onBone = rig.handR.isBone;
    for (const hand of [rig.handL, rig.handR]) {
      const g = new THREE.Group();
      // 骨架角色的手比較小，拳套縮小並拿掉護腕，避免浮在手外面
      g.add(mesh(new THREE.SphereGeometry(onBone ? 4.5 : 8.5, 18, 14), MATS.glove));
      if (!onBone) {
        const cuff = mesh(new THREE.CylinderGeometry(6, 6.5, 5, 14), MATS.cuff, 0, 0, -7);
        cuff.rotation.x = Math.PI / 2;
        g.add(cuff);
      }
      attach(hand, g);
    }
  } else if (gear === 'staff') {
    const g = new THREE.Group();
    g.add(mesh(new THREE.CylinderGeometry(2.6, 2.6, 120, 10).rotateX(Math.PI / 2), MATS.wood, 0, 0, 20));
    g.add(mesh(new THREE.CylinderGeometry(3.6, 3.6, 10, 10).rotateX(Math.PI / 2), MATS.teal, 0, 0, 78));
    g.add(mesh(new THREE.CylinderGeometry(3.4, 3.4, 8, 10).rotateX(Math.PI / 2), MATS.teal, 0, 0, -38));
    attach(rig.handR, g);
    rig.staff = g;
  } else {
    const g = new THREE.Group();
    g.add(mesh(new THREE.BoxGeometry(11, 12, 30), MATS.navy, 0, 2, 10));
    g.add(mesh(new THREE.BoxGeometry(11.5, 12.5, 6), MATS.steel, 0, 2, 4));
    g.add(mesh(new THREE.CylinderGeometry(4, 4, 10, 12).rotateX(Math.PI / 2), MATS.steel, 0, 2, 28));
    g.add(mesh(new THREE.SphereGeometry(4.2, 12, 10), MATS.glowCyan, 0, 2, 33));
    attach(rig.handR, g);
    rig.gun = g;
  }
}

/* ------------------------------------------------------------ 角色動作 */

// 依伺服器狀態擺出角色姿勢與特效
export function poseRig(rig, p, now, dt) {
  applyLook(rig, p);
  const root = rig.root;
  root.visible = p.s !== 'dead' && !(p.iv && p.s !== 'falling' && Math.floor(now / 90) % 2 === 0);
  root.position.set(p.x, p.z, p.y);
  root.rotation.y = Math.atan2(p.fx, p.fy);
  let sc = 1;
  if (p.s === 'falling') {
    const k = Math.min(1, p.t / 0.8);
    sc = 1 - k * 0.6;
    root.position.y -= k * k * 260;
  }
  root.scale.setScalar(sc);
  const b = rig.body;
  b.position.set(0, 0, 0);
  b.rotation.set(0, 0, 0);
  for (const o of [rig.slash, rig.shield, rig.spinRing, rig.aura, rig.stars, rig.heldCrate, rig.charge, rig.ice, rig.circle]) o.visible = false;
  const prog = p.du > 0 ? Math.min(1, p.t / p.du) : 0;
  const strike = Math.sin(Math.PI * prog);

  if (rig.mixer) poseModel(rig, p, dt);
  else posePrimitive(rig, p, now, prog, strike);

  // 受擊閃白
  const flash = p.s === 'hitstun' && Math.floor(now / 45) % 2 ? '#ffffff' : '#000000';
  for (const m of rig.flashMats) { if (m.emissive) { m.emissive.set(flash); m.emissiveIntensity = 0.7; } }

  // 共用的身體傾斜（有骨架動作的模型只補動作檔沒有的部分）
  if (p.s === 'dash') b.rotation.x = rig.mixer ? 0.25 : 0.5;
  if (p.s === 'spin') b.rotation.y = p.t * 30;
  if (!rig.mixer) {
    if (p.s === 'down') { b.rotation.x = -Math.PI / 2; b.position.y = 11; }
    if (p.s === 'airatk') b.rotation.x = 0.7;
    if (p.s === 'hitstun') b.rotation.x = -0.35;
  }
  if (p.s === 'guardbreak') b.rotation.z = Math.sin(now / 70) * 0.25;

  // 特效
  const g = GEAR_INFO[p.g];
  const rangedLight = p.g === 'wand' || (p.g === 'blaster' && p.cb === 2);
  if (p.s === 'attack' && prog > 0.2 && prog < 0.65 && !rangedLight) {
    const r = g.range + 6;
    rig.slash.visible = true;
    rig.slash.scale.set(r, 1, r);
    rig.slash.material.color.set('#ffffff');
    rig.slash.material.opacity = 0.75 * (1 - Math.abs(prog - 0.42) * 4);
  }
  if (p.s === 'charge') { // 巨劍蓄力：手上光球越來越大，蓄滿會閃爍
    const k = Math.min(1, p.t / (p.du || 1));
    rig.charge.visible = true;
    const pulse = k >= 1 ? 1 + Math.sin(now / 40) * 0.25 : 1;
    rig.charge.scale.setScalar((0.6 + k * 3) * pulse * rig.chargeBase);
    b.position.x = Math.sin(now / 25) * k * 1.5; // 蓄越久身體越抖
  }
  if (p.s === 'heavy') {
    if (prog < 0.38) {
      rig.charge.visible = true;
      rig.charge.scale.setScalar((0.5 + prog * 4) * rig.chargeBase);
    } else if (prog < 0.62 && p.g !== 'axe') {
      const r = (g.hrange + 10) * (1 + 0.25 * (p.ck || 0));
      rig.slash.visible = true;
      rig.slash.scale.set(r, 1, r);
      rig.slash.material.color.set(g.color);
      rig.slash.material.opacity = 0.9;
    }
  }
  if (p.s === 'guard') rig.shield.visible = true;
  if (p.s === 'spin') { rig.spinRing.visible = true; rig.spinRing.rotation.y = -now / 40; }
  if (p.s === 'dash') { rig.aura.visible = true; rig.aura.scale.setScalar(1 + Math.sin(now / 40) * 0.15); }
  if (p.s === 'guardbreak') {
    rig.stars.visible = true;
    rig.stars.children.forEach((st, i) => {
      const a = now / 200 + (i * Math.PI * 2) / 3;
      st.position.set(Math.cos(a) * 16, Math.sin(a * 2) * 2, Math.sin(a) * 16);
      st.rotation.y = now / 100;
    });
  }
  if (p.h) rig.heldCrate.visible = true;
  if (p.s === 'frozen') rig.ice.visible = true;
  if (p.s === 'nova' && prog < 0.5) {
    rig.circle.visible = true;
    rig.circle.rotation.y = now / 300;
    rig.circle.scale.setScalar(0.6 + prog * 2);
  }
  if (p.s === 'stab' && prog < 0.45) { // 背刺刀光
    rig.slash.visible = true;
    rig.slash.scale.set(50, 1, 50);
    rig.slash.material.color.set(g.color);
    rig.slash.material.opacity = 0.85;
  }
}

// 暫代模型的程式動畫
function posePrimitive(rig, p, now, prog, strike) {
  const b = rig.body;
  const mv = p.mv && p.s === 'idle';
  const sw = mv ? Math.sin(now / 85) : 0;
  b.position.y = mv ? Math.abs(sw) * 3 : Math.sin(now / 420) * 0.8;
  if (rig.footL) {
    rig.footL.position.set(-6, airborne(p) ? 7 : 3, 1 + sw * 6);
    rig.footR.position.set(6, airborne(p) ? 7 : 3, 1 - sw * 6);
  }
  const hr = rig.handRest;
  rig.handL.position.set(hr.L.x, hr.L.y, hr.L.z - sw * 5);
  rig.handR.position.set(hr.R.x, hr.R.y, hr.R.z + sw * 5);
  if (rig.staff) rig.staff.rotation.set(-0.9, 0.3, 0);
  if (rig.gun) rig.gun.rotation.set(0, 0, 0);

  const s = p.s;
  if (s === 'attack') {
    const e = strike * 26;
    if (p.g === 'flame') {
      if (p.cb !== 1) rig.handR.position.z += e;
      if (p.cb !== 0) rig.handL.position.z += e;
      if (p.cb === 2) b.rotation.x = 0.25 * strike;
    } else if (p.g === 'staff') {
      if (p.cb === 2) { rig.staff.rotation.set(0, 0, 0); rig.handR.position.z += e * 1.2; }
      else { const dir = p.cb === 0 ? 1 : -1; rig.staff.rotation.set(0, dir * (1.4 - 2.8 * prog), 0); }
    } else {
      rig.handR.position.z += e * 0.7;
    }
  } else if (s === 'heavy') {
    if (prog < 0.38) {
      b.rotation.x = -0.2;
      rig.handR.position.z = -8;
      rig.handL.position.z = -8;
      if (rig.staff) rig.staff.rotation.set(-1.8, 0, 0);
    } else {
      const k = Math.sin(Math.PI * Math.min(1, (prog - 0.38) / 0.62));
      b.rotation.x = 0.3 * k;
      rig.handR.position.z += 30 * k;
      if (p.g === 'flame') rig.handL.position.z += 30 * k;
      if (rig.staff) rig.staff.rotation.set(-1.8 + 2.2 * Math.min(1, (prog - 0.38) / 0.2), 0, 0);
    }
  } else if (s === 'dash') {
    rig.handL.position.z = rig.handR.position.z = 22;
  } else if (s === 'spin') {
    if (rig.staff) rig.staff.rotation.set(0, Math.PI / 2, 0);
    rig.handR.position.set(18, 26, 0);
  } else if (s === 'guard') {
    rig.handL.position.set(-6, 30, 14);
    rig.handR.position.set(6, 30, 14);
    if (rig.staff) rig.staff.rotation.set(0, -Math.PI / 2, 0);
  } else if (s === 'airatk') {
    if (rig.footR) rig.footR.position.z = 14;
  } else if (s === 'recover' && p.g === 'blaster' && p.t < 0.15) {
    rig.handR.position.z -= 6;
  }
  if (p.h) {
    rig.handL.position.set(-10, 58, 4);
    rig.handR.position.set(10, 58, 4);
  }
  if (rig.segs) poseSegments(rig, p, now, sw);
}

// 遊戲狀態 → 要找的動作代號（依序嘗試，找不到就往後退）
function wantedSlots(p) {
  switch (p.s) {
    case 'idle':
      if (airborne(p)) return ['jump', 'idle'];
      if (p.h) return p.mv ? ['carryrun', 'run', 'idle'] : ['carry', 'idle'];
      return p.mv ? ['run', 'idle'] : ['idle'];
    case 'attack': return [`attack${p.cb + 1}`, p.cb % 2 ? 'attack2' : 'attack1', 'attack1'];
    case 'charge': return ['charge', 'guard', 'idle'];
    case 'heavy': return ['heavy', 'attack3', 'attack1'];
    case 'guard': return ['guard', 'idle'];
    case 'hitstun': return ['hit', 'idle'];
    case 'guardbreak': return ['stun', 'hit', 'idle'];
    case 'down': return ['down', 'hit'];
    case 'airatk': return ['airattack', 'attack1'];
    case 'dash': case 'spin': case 'leap': case 'stab': case 'nova': return ['ultimate', 'heavy', 'attack1'];
    case 'frozen': return ['stun', 'hit', 'idle'];
    case 'recover': return (p.g === 'blaster' || p.g === 'axe') && p.du >= 0.25 ? ['ultimate', 'shoot', 'idle'] : ['idle'];
    case 'falling': return ['fall', 'jump', 'idle'];
    default: return ['idle'];
  }
}

// 只播一次的狀態（會依遊戲判定時間調整播放速度）；跳躍類照原速
const ONE_SHOT = new Set(['attack', 'heavy', 'hitstun', 'guardbreak', 'down', 'airatk', 'recover', 'stab', 'nova', 'leap']);
const NATURAL_SPEED = new Set(['down', 'leap', 'airatk']);

// 動作代號 → 實際動作片段：先查「配件.代號」，再查「代號」，最後直接當動作名稱找
function findClip(rig, gear, slot) {
  const clips = manifest.clips || {};
  const name = (clips[`${gear}.${slot}`] || clips[slot] || slot).toLowerCase();
  return rig.clips[name] || animClips[name] || null;
}

// 有骨架的模型：依狀態切換動作片段，一次性動作的長度對齊伺服器的招式時間
function poseModel(rig, p, dt) {
  if (p.s === 'frozen') { rig.animT = p.t; return; } // 冰凍：動作停在當下
  let clip = null;
  for (const s of wantedSlots(p)) { clip = findClip(rig, p.g, s); if (clip) break; }
  if (clip) {
    const loopOnce = ONE_SHOT.has(p.s);
    const key = `${p.s}:${p.cb}:${clip.name}`;
    const restarted = loopOnce && p.t + 0.02 < (rig.animT || 0);
    if (key !== rig.animKey || restarted) {
      const next = rig.mixer.clipAction(clip);
      next.reset();
      next.setLoop(loopOnce ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = loopOnce;
      // 一次性動作壓縮到招式長度內播完；倒地動作照原速
      next.timeScale = loopOnce && !NATURAL_SPEED.has(p.s) && p.du > 0.05 ? clip.duration / p.du : 1;
      if (rig.action && rig.action !== next) rig.action.fadeOut(0.08);
      next.fadeIn(0.08).play();
      rig.action = next;
      rig.animKey = key;
    }
  }
  rig.animT = p.t;
  rig.mixer.update(dt);
}

/* ------------------------------------------------------------ 特效（粒子畫在 2D 疊加層） */

// 依伺服器事件產生粒子與浮動文字
export function fx(f) {
  const z = f.z || 0;
  switch (f.k) {
    case 'hit':
      burst(f.x, f.y, z, f.heavy ? 18 : 9, f.heavy ? '#ffe066' : '#fff3b0', f.heavy ? 320 : 200);
      texts.push({ x: f.x, y: f.y, z: z + 30, text: String(f.dmg), color: f.heavy ? '#ffb43d' : '#fff', life: 0.8, max: 0.8 });
      if (f.heavy) shake = Math.max(shake, 8);
      break;
    case 'block': burst(f.x, f.y, z, 8, '#7cc8ff', 180); break;
    case 'gb':
      burst(f.x, f.y, 30, 14, '#7cc8ff', 260);
      texts.push({ x: f.x, y: f.y, z: 90, text: '破防！', color: '#7cc8ff', life: 1, max: 1 });
      shake = Math.max(shake, 5);
      break;
    case 'fall': ring(f.x, f.y, '#9fb3ff'); break;
    case 'break': burst(f.x, f.y, z + 15, 14, '#b07a3c', 240, true); break;
    case 'pop': burst(f.x, f.y, z, 6, f.c === 'ice' ? '#e6fbff' : '#7fd8ff', 140); break;
    case 'zap': burst(f.x, f.y, z, 12, f.c === 'pellet' ? '#ffd166' : f.c === 'ice' ? '#e6fbff' : '#aee9ff', 260); break;
    case 'shot': burst(f.x, f.y, 26, 6, '#bfeaff', 120); break;
    case 'jump': burst(f.x, f.y, 0, 5, '#cfd6ea', 80); break;
    case 'crate': ring(f.x, f.y, '#e0b070'); break;
    case 'quake': // 巨劍落地衝擊波
      ring(f.x, f.y, '#ffe08a', 105); ring(f.x, f.y, '#fff3c4', 70);
      burst(f.x, f.y, 0, 22, '#d9c08a', 300, true);
      shake = Math.max(shake, 12);
      break;
    case 'nova': // 冰霜新星
      ring(f.x, f.y, '#8fe3ff', 120); ring(f.x, f.y, '#e6fbff', 80);
      burst(f.x, f.y, 20, 26, '#bfefff', 340);
      break;
    case 'freeze': burst(f.x, f.y, 40, 10, '#e6fbff', 120); break;
    case 'blink': // 影襲：出發點與落點各一團煙
      burst(f.x, f.y, 25, 14, '#6b4fa8', 160);
      burst(f.x2, f.y2, 25, 14, '#a87bff', 160);
      break;
  }
}

// 噴出一團粒子
function burst(x, y, z, n, color, speed, chips) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.4 + Math.random() * 0.6);
    particles.push({ x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: 80 + Math.random() * 200,
      life: 0.5, max: 0.5, color, size: chips ? 4 : 2.5, chips });
  }
}

// 地面擴散光環
function ring(x, y, color, size = 70) {
  particles.push({ x, y, z: 0, vx: 0, vy: 0, vz: 0, life: 0.6, max: 0.6, color, ring: true, size });
}

// 世界座標轉成疊加層的螢幕座標
function toScreen(x, y, z) {
  tmpV.set(x, z, y).project(camera);
  return { sx: (tmpV.x + 1) / 2 * W * dpr, sy: (1 - tmpV.y) / 2 * H * dpr, ok: tmpV.z < 1 };
}

/* ------------------------------------------------------------ 每幀繪製 */

// 畫出一整幀：同步角色/木箱/子彈、鏡頭跟隨、粒子與頭上標籤
export function render(st, myId, now, dt) {
  if (!MAP) { renderer.render(scene, camera); return; }
  const seen = new Set();
  let me = null;
  if (st) {
    for (const p of st.p) {
      seen.add(p.id);
      let rig = rigs.get(p.id);
      if (rig && rig.key !== rigKey(p)) { scene.remove(rig.root); rig = null; } // 換角色或模型剛載入完
      if (!rig) { rig = makeRig(p); rigs.set(p.id, rig); scene.add(rig.root); }
      poseRig(rig, p, now, dt);
      if (p.id === myId) me = p;
    }
  }
  for (const [id, rig] of rigs) if (!seen.has(id)) { scene.remove(rig.root); rigs.delete(id); }
  syncCrates(st);
  syncProjs(st, dt);

  for (const g of floaters) g.position.y = g.userData.base + Math.sin(now / 900 + g.userData.phase) * 8;

  // 瞄準準心
  const tgt = me && me.am && st ? st.p.find((p) => p.id === me.am) : null;
  reticle.visible = !!tgt;
  if (tgt) { reticle.position.set(tgt.x, 1.5, tgt.y); reticle.rotation.y = now / 500; }

  updateCamera(me, dt);
  renderer.render(scene, camera);
  drawOverlay(st, myId, dt);
}

// 鏡頭固定 55° 俯角，輕微跟著自己的角色移動
function updateCamera(me, dt) {
  const P = MAP.platform;
  let tx = P.x + P.w / 2, tz = P.y + P.h / 2;
  if (me && me.s !== 'dead' && me.s !== 'falling') {
    tx += (me.x - tx) * 0.35;
    tz += (me.y - tz) * 0.3;
  }
  const k = Math.min(1, dt * 4);
  camTarget.x += (tx - camTarget.x) * k;
  camTarget.z += (tz - camTarget.z) * k;
  const half = Math.tan(THREE.MathUtils.degToRad(CAM_FOV / 2));
  const dist = Math.max(1080, 620 / (half * camera.aspect));
  shake *= Math.pow(0.02, dt);
  const sx = (Math.random() - 0.5) * shake, sz = (Math.random() - 0.5) * shake;
  camera.position.set(camTarget.x + sx, Math.sin(CAM_PITCH) * dist, camTarget.z + Math.cos(CAM_PITCH) * dist + sz);
  camera.lookAt(camTarget.x + sx, 0, camTarget.z + sz);
}

// 木箱
let crateMaterial = null;
// 木箱貼圖材質（共用一份）
function crateMat() {
  if (!crateMaterial) {
    crateMaterial = new THREE.MeshStandardMaterial({ roughness: 0.9, map: canvasTex(128, 128, (g) => {
      g.fillStyle = '#9a6a35'; g.fillRect(0, 0, 128, 128);
      g.strokeStyle = '#5a3a18'; g.lineWidth = 12; g.strokeRect(6, 6, 116, 116);
      g.lineWidth = 9;
      g.beginPath(); g.moveTo(10, 10); g.lineTo(118, 118); g.moveTo(118, 10); g.lineTo(10, 118); g.stroke();
    }) });
  }
  return crateMaterial;
}

// 同步場上的木箱
function syncCrates(st) {
  const seen = new Set();
  for (const c of st ? st.cr : []) {
    if (c.s === 'held') continue;
    seen.add(c.id);
    let m = crateMeshes.get(c.id);
    if (!m) {
      m = mesh(new THREE.BoxGeometry(30, 30, 30), crateMat());
      m.receiveShadow = true;
      scene.add(m);
      crateMeshes.set(c.id, m);
    }
    m.visible = true;
    m.position.set(c.x, c.z + 15, c.y);
    m.rotation.y = c.s === 'fly' ? performance.now() / 80 : 0;
  }
  for (const [id, m] of crateMeshes) if (!seen.has(id)) m.visible = false;
}

// 同步飛行物：雷光砲能量彈、迴旋飛斧
function syncProjs(st, dt) {
  const seen = new Set();
  for (const b of st ? st.pj : []) {
    seen.add(b.id);
    let m = projMeshes.get(b.id);
    if (!m) {
      m = new THREE.Group();
      if (b.k === 'axe') { // 迴旋飛斧：有模型用模型，沒有用簡單斧頭
        const gm = (manifest.gearModels || {}).axe;
        const gltf = gm ? getModel(gm.file) : null;
        const spin = new THREE.Group();
        if (gltf) {
          const inner = gltf.scene.clone(true);
          inner.scale.setScalar(gm.projectileScale || 54);
          inner.rotation.z = Math.PI / 2; // 斧柄橫躺，旋轉起來像迴力鏢
          spin.add(inner);
        } else {
          spin.add(mesh(new THREE.BoxGeometry(6, 6, 44), MATS.wood));
          spin.add(mesh(new THREE.BoxGeometry(4, 22, 16), MATS.steel, 0, 0, 18));
        }
        m.add(spin);
        m.userData.spin = spin;
      } else if (b.k === 'ice') { // 冰霜魔杖冰彈：白色冰晶 + 淡藍光暈
        const crystal = mesh(new THREE.OctahedronGeometry(7), new THREE.MeshStandardMaterial({ color: '#e6fbff', emissive: '#8fe3ff', emissiveIntensity: 0.6, roughness: 0.2 }));
        crystal.scale.set(1, 1, 1.8);
        m.add(crystal);
        m.add(new THREE.Mesh(new THREE.SphereGeometry(13, 14, 10), glowMat('#8fe3ff', 0.4)));
        m.userData.trail = '#bfefff';
        m.userData.face = true;
      } else if (b.k === 'pellet') { // 雷光砲散彈：小顆黃光
        m.add(new THREE.Mesh(new THREE.SphereGeometry(3, 8, 6), new THREE.MeshBasicMaterial({ color: '#fff6c2' })));
        m.add(new THREE.Mesh(new THREE.SphereGeometry(7, 10, 8), glowMat('#ffd166', 0.6)));
        m.userData.trail = '#ffd166';
      } else {
        m.add(new THREE.Mesh(new THREE.SphereGeometry(6, 12, 10), MATS.glowCyan));
        m.add(new THREE.Mesh(new THREE.SphereGeometry(15, 14, 10), glowMat('#5ab4ff', 0.5)));
        m.userData.trail = '#7fd8ff';
      }
      scene.add(m);
      projMeshes.set(b.id, m);
    }
    m.position.set(b.x, b.z, b.y);
    if (m.userData.spin) m.userData.spin.rotation.y = performance.now() / 45;
    else if (Math.random() < dt * 40) particles.push({ x: b.x, y: b.y, z: b.z, vx: 0, vy: 0, vz: 0, life: 0.25, max: 0.25, color: m.userData.trail, size: 4 });
    if (m.userData.face) m.rotation.y = Math.atan2(b.vx, b.vy); // 冰晶尖端朝飛行方向
  }
  for (const [id, m] of projMeshes) if (!seen.has(id)) { scene.remove(m); projMeshes.delete(id); }
}

// 2D 疊加層：粒子、傷害數字、名字與血條
function drawOverlay(st, myId, dt) {
  const c = octx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, overlay.width, overlay.height);
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    q.life -= dt;
    if (q.life <= 0) { particles.splice(i, 1); continue; }
    const k = q.life / q.max;
    if (q.ring) {
      const a = toScreen(q.x, q.y, 1);
      const b2 = toScreen(q.x + q.size * (0.15 + (1 - k) * 0.85), q.y, 1);
      const r = Math.abs(b2.sx - a.sx);
      c.strokeStyle = q.color; c.lineWidth = (4 * k + 0.5) * dpr; c.globalAlpha = k;
      c.beginPath(); c.ellipse(a.sx, a.sy, r, r * Math.sin(CAM_PITCH), 0, 0, Math.PI * 2); c.stroke();
      continue;
    }
    q.x += q.vx * dt; q.y += q.vy * dt;
    q.vz -= 700 * dt; q.z = Math.max(0, q.z + q.vz * dt);
    const s = toScreen(q.x, q.y, q.z);
    if (!s.ok) continue;
    c.globalAlpha = k;
    c.fillStyle = q.color;
    const sz = q.size * dpr * (0.5 + k);
    if (q.chips) c.fillRect(s.sx - sz, s.sy - sz, sz * 2, sz * 2);
    else { c.beginPath(); c.arc(s.sx, s.sy, sz, 0, Math.PI * 2); c.fill(); }
  }
  c.globalAlpha = 1;
  c.textAlign = 'center';
  c.font = `bold ${18 * dpr}px sans-serif`;
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i];
    t.life -= dt;
    if (t.life <= 0) { texts.splice(i, 1); continue; }
    t.z += 50 * dt;
    const s = toScreen(t.x, t.y, t.z);
    c.globalAlpha = Math.min(1, (t.life / t.max) * 2);
    c.lineWidth = 4 * dpr; c.strokeStyle = 'rgba(0,0,0,0.7)';
    c.strokeText(t.text, s.sx, s.sy);
    c.fillStyle = t.color;
    c.fillText(t.text, s.sx, s.sy);
  }
  c.globalAlpha = 1;
  if (st) {
    c.font = `bold ${13 * dpr}px "Microsoft JhengHei", sans-serif`;
    for (const p of st.p) {
      if (p.s === 'dead' || p.s === 'falling') continue;
      const s = toScreen(p.x, p.y, p.z + (p.h ? 160 : 112));
      const isMe = p.id === myId;
      c.lineWidth = 3 * dpr; c.strokeStyle = 'rgba(0,0,0,0.75)';
      c.strokeText(p.n, s.sx, s.sy);
      c.fillStyle = isMe ? '#ffd166' : '#fff';
      c.fillText(p.n, s.sx, s.sy);
      const bw = 44 * dpr, bh = 5 * dpr, by = s.sy + 5 * dpr;
      c.fillStyle = 'rgba(0,0,0,0.6)';
      c.fillRect(s.sx - bw / 2 - dpr, by - dpr, bw + 2 * dpr, bh + 2 * dpr);
      c.fillStyle = p.hp > 50 ? '#4ade80' : p.hp > 25 ? '#facc15' : '#f87171';
      c.fillRect(s.sx - bw / 2, by, bw * p.hp / 100, bh);
      if (isMe) {
        c.fillStyle = '#ffd166';
        c.beginPath();
        c.moveTo(s.sx - 6 * dpr, s.sy - 26 * dpr); c.lineTo(s.sx + 6 * dpr, s.sy - 26 * dpr); c.lineTo(s.sx, s.sy - 17 * dpr);
        c.fill();
      }
    }
  }
  c.textAlign = 'start';
}

/* ------------------------------------------------------------ 大廳預覽 */

// 大廳的大型預覽：待機慢慢轉、可拖曳旋轉；換配件時示範一次「攻擊 → 重攻擊 → 大絕」
export function createPreview(canvas) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight('#c8d8ff', '#3a2d55', 1.4));
  const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
  sun.position.set(-150, 300, 200);
  sc.add(sun);
  const rim = new THREE.DirectionalLight('#9fb8ff', 1.2); // 背光勾邊
  rim.position.set(120, 140, -220);
  sc.add(rim);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(66, 72, 10, 48), new THREE.MeshStandardMaterial({ color: '#1d2547', roughness: 0.6 }));
  disc.position.y = -5;
  sc.add(disc);
  const glow = new THREE.Mesh(new THREE.RingGeometry(68, 76, 64).rotateX(-Math.PI / 2), glowMat('#ffffff', 0.8));
  glow.position.y = 0.6;
  sc.add(glow);
  const cam = new THREE.PerspectiveCamera(30, 1, 1, 2000);
  cam.position.set(0, 150, 430);
  cam.lookAt(0, 46, 0);
  let rig = null;
  let drag = 0, dragging = false, lastX = 0, lastGear = null, demoStart = -1e9;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) { drag += (e.clientX - lastX) * 0.012; lastX = e.clientX; } });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointercancel', () => { dragging = false; });
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  return {
    // 每幀更新預覽：設定變了就重建角色
    update(setup, now, dt) {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        r.setPixelRatio(dpr);
        r.setSize(w, h, false);
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      }
      const fake = { id: 0, ch: setup.ch, c: setup.color, g: setup.gear };
      if (!rig || rig.key !== rigKey(fake)) {
        if (rig) sc.remove(rig.root);
        rig = makeRig(fake);
        sc.add(rig.root);
      }
      if (setup.gear !== lastGear) { lastGear = setup.gear; demoStart = now; }
      glow.material.color.set(GEAR_INFO[setup.gear].color);
      // 換配件後的示範：0~0.9 秒三段攻擊、1.1~1.7 重攻擊、1.9~2.5 大絕，之後回到待機
      const d = (now - demoStart) / 1000;
      let s = 'idle', t = 0, du = 0, cb = 0;
      const ult = { flame: 'dash', staff: 'spin', greatsword: 'leap', dagger: 'stab', wand: 'nova' }[setup.gear] || 'recover';
      if (d < 0.9) { cb = Math.floor(d / 0.3); s = 'attack'; t = d % 0.3; du = 0.3; }
      else if (d > 1.1 && d < 1.7) { s = 'heavy'; t = d - 1.1; du = 0.6; }
      else if (d > 1.9 && d < 2.5) { s = ult; t = d - 1.9; du = 0.6; }
      if (!dragging && !reduceMotion.matches) drag += dt * 0.35; // 待機自動慢慢轉
      const ang = drag;
      poseRig(rig, { id: 0, ch: setup.ch, x: 0, y: 0, z: 0, fx: Math.sin(ang), fy: Math.cos(ang), c: setup.color, g: setup.gear,
        s, t, du, cb, mv: 0, h: 0, cd: 0, iv: 0, hp: 100 }, now, dt);
      rig.root.position.set(0, 0, 0);
      r.render(sc, cam);
    },
  };
}
