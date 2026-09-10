import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildOffice, CAST_LAYER } from "./office";
import { AGENT_COLORS, PALETTES, type ScenePalette } from "./palette";
import { CHARACTER_KINDS } from "./characters";
import "./scene3d.css";

const canvas = document.querySelector<HTMLCanvasElement>("#scene")!;
const hint = document.querySelector<HTMLParagraphElement>("#drop-hint")!;
const themeBar = document.querySelector<HTMLDivElement>("#themes")!;
const kindBar = document.querySelector<HTMLDivElement>("#kinds")!;
const dropZone = document.body;

let palette: ScenePalette = PALETTES[0]!;

// ---------- renderer / camera ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// 高 DPI 螢幕上不設上限的話，4K 筆電會直接掉到 20fps
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
camera.position.set(7.6, 5.6, 9.6);

const controls = new OrbitControls(camera, canvas);
// 對準工位那一排而不是房間幾何中心：地板前半是空的，對中心會讓畫面下半留白
controls.target.set(0, 1.3, -1.6);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2.05; // 不讓相機鑽到地板下面
controls.minDistance = 4;
controls.maxDistance = 30;

// ---------- lights ----------
const ambient = new THREE.HemisphereLight(0xffffff, 0x8a7060, 1);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(-6, 11, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 40;
sun.shadow.camera.left = -12;
sun.shadow.camera.right = 12;
sun.shadow.camera.top = 12;
sun.shadow.camera.bottom = -12;
// 低多邊形加軟陰影很容易出現條紋自陰影
sun.shadow.bias = -0.0006;
scene.add(sun);

// 角色專用補光：只設在 CAST_LAYER，所以照得到人、照不到牆壁與桌子。
// 用 hemisphere 而不是 directional —— toon 的色塊分界由主光決定，
// 這盞只要整體抬高亮度，不該再切出第二道明暗交界
const castFill = new THREE.HemisphereLight(0xffffff, 0xa9adc4, 0);
castFill.layers.set(CAST_LAYER);
scene.add(castFill);

// ---------- 場景 ----------
const office = buildOffice(palette);
scene.add(office.root);

const loadedModels = new THREE.Group();
scene.add(loadedModels);

function applyPalette(p: ScenePalette): void {
  palette = p;
  office.applyPalette(p);
  scene.background = new THREE.Color(p.fog);
  scene.fog = new THREE.Fog(p.fog, 26, 55);
  ambient.color.setHex(p.ambient);
  ambient.intensity = p.ambientIntensity;
  sun.color.setHex(p.sun);
  sun.intensity = p.sunIntensity;
  castFill.color.setHex(p.castFill);
  castFill.intensity = p.castFillIntensity;
  for (const btn of themeBar.querySelectorAll("button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.theme === p.id));
  }
}

// ---------- HUD ----------
for (const p of PALETTES) {
  const btn = document.createElement("button");
  btn.textContent = p.label;
  btn.dataset.theme = p.id;
  btn.addEventListener("click", () => applyPalette(p));
  themeBar.append(btn);
}
applyPalette(palette);

// 測試頁的「住戶」就是 config 裡那三個 agent，狀態固定當作在工作
const CAST = AGENT_COLORS.map((a) => ({
  id: a.id,
  accent: a.accent,
  resident: true,
  activity: "working" as const,
}));

for (const kind of CHARACTER_KINDS) {
  const btn = document.createElement("button");
  btn.textContent = kind.label;
  btn.dataset.kind = kind.id;
  btn.addEventListener("click", () => applyKind(kind.id));
  kindBar.append(btn);
}
office.setOccupants(CAST);
applyKind(CHARACTER_KINDS[0]!.id);

function applyKind(id: string): void {
  const kind = CHARACTER_KINDS.find((k) => k.id === id) ?? CHARACTER_KINDS[0]!;
  office.setFactory(({ mats, accentMat }) => kind.build(mats, accentMat));
  for (const btn of kindBar.querySelectorAll("button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.kind === id));
  }
}

// ---------- 拖入 .glb 試真模型 ----------
const gltfLoader = new GLTFLoader();

// dragenter / dragleave 都會從子元素冒泡上來，指標從畫布移到 HUD 面板時
// 會先收到一個 dragleave —— 直接靠它關掉外框，拖過面板時邊框就會閃。
// 用進出計數，歸零才是真的離開了整個視窗。
let dragDepth = 0;
function setDragging(on: boolean): void {
  document.body.classList.toggle("dragging", on);
}
dropZone.addEventListener("dragenter", () => {
  dragDepth += 1;
  setDragging(true);
});
dropZone.addEventListener("dragover", (e) => {
  // 不擋掉預設行為的話瀏覽器不會發 drop
  e.preventDefault();
});
dropZone.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDragging(false);
});
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  setDragging(false);
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!/\.(glb|gltf)$/i.test(file.name)) {
    hint.textContent = `${file.name} 不是 .glb / .gltf`;
    return;
  }
  hint.textContent = `載入 ${file.name}…`;
  file
    .arrayBuffer()
    .then((buf) =>
      gltfLoader.parse(
        buf,
        "",
        (gltf) => {
          placeModel(gltf.scene);
          hint.textContent = `已載入 ${file.name} —— 再拖一個會取代它`;
        },
        // .gltf 常帶外部貼圖、.glb 可能是 Draco 壓縮的，兩種在這裡都會失敗
        (err) => {
          const reason = err instanceof Error ? err.message : String(err);
          hint.textContent = `載入失敗：${reason.slice(0, 120)}`;
        },
      ),
    )
    .catch((err: unknown) => {
      hint.textContent = `讀檔失敗：${String(err)}`;
    });
});

/**
 * 釋放一整棵子樹的 GPU 資源。
 * clear() 只是把子節點拔掉，幾何、材質、貼圖都還在顯卡上；
 * 貼圖尤其是大宗，幾張 2K 的就足以把 VRAM 吃光。
 */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const used = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of used) {
      if (!m) continue;
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
}

/** 外部模型的單位與原點完全不可信，一律量測後歸一化到房間中央的地毯上 */
function placeModel(model: THREE.Object3D): void {
  // HUD 明講「再拖一個會取代它」，所以重複拖放是預期用法 —— 舊的一定要先丟掉
  for (const old of [...loadedModels.children]) disposeTree(old);
  loadedModels.clear();

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 2.4 / maxDim;

  model.scale.setScalar(scale);
  model.position.set(
    1 - center.x * scale,
    -box.min.y * scale + 0.04,
    1.8 - center.z * scale,
  );
  model.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  loadedModels.add(model);
}

// ---------- loop ----------
// 拿 canvas.width 比對會永遠不相等（那是乘過 pixelRatio 的裝置像素），變成每幀都重設 size
let lastW = 0;
let lastH = 0;

function resize(): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === lastW && h === lastH) return;
  lastW = w;
  lastH = h;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// 測試場景：把相機掛到 window 方便從 console 檢查取景
(window as unknown as Record<string, unknown>).__scene3d = { camera, controls, scene };

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  resize();
  office.update(clock.getElapsedTime());
  controls.update();
  renderer.render(scene, camera);
});
