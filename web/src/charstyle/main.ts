import * as THREE from "three";
import { ANIME_KINDS } from "./animeChars";
import { AGENT_COLORS } from "../scene3d/palette";
import "./charstyle.css";

/**
 * 角色風格試作頁：把動漫（cel shading）風的候選角色排成一列比較，
 * 跟 scene3d.html 的低多邊形寫實風是兩套並存的方案，還沒決定要採用哪個。
 * 這頁不進 production build，純粹拿來看樣。
 */

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const caption = document.getElementById("caption") as HTMLElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
// toon 的重點是平塗色塊，走 tone mapping 會把色階壓成灰灰的
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);

// ---------- 燈光：一盞主光決定色階邊界，其餘只負責不讓暗部死黑 ----------
scene.add(new THREE.HemisphereLight(0xffffff, 0xc9b6e0, 1.15));
const key = new THREE.DirectionalLight(0xfff4e8, 1.9);
key.position.set(3.5, 5.5, 4.5);
scene.add(key);
const rim = new THREE.DirectionalLight(0xa8c8ff, 0.85);
rim.position.set(-4, 2.5, -3.5);
scene.add(rim);

// ---------- 角色一字排開 ----------
const SPACING = 1.62;
const cast = ANIME_KINDS.map((kind, i) => {
  const accent = AGENT_COLORS[i % AGENT_COLORS.length]!.accent;
  const c = kind.build(accent);
  const x = (i - (ANIME_KINDS.length - 1) / 2) * SPACING;
  c.group.position.x = x;
  // 兩側的人稍微轉向鏡頭，一整排全部正面會像證件照
  c.group.rotation.y = -x * 0.06;
  scene.add(c.group);
  return { kind, char: c, x };
});

// 站台：一片中央亮、邊緣透明的地面，免得角色像浮在空中
const stageTex = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(128, 128, 10, 128, 128, 126);
  grad.addColorStop(0, "rgba(255, 246, 236, 0.95)");
  grad.addColorStop(0.7, "rgba(255, 235, 220, 0.5)");
  grad.addColorStop(1, "rgba(255, 235, 220, 0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
})();
const stage = new THREE.Mesh(
  new THREE.PlaneGeometry(16, 16),
  new THREE.MeshBasicMaterial({ map: stageTex, transparent: true, depthWrite: false }),
);
stage.rotation.x = -Math.PI / 2;
scene.add(stage);

// ---------- 視角 ----------
type View = {
  target: THREE.Vector3;
  dist: number;
  fov: number;
  label: string;
  /** 只顯示這一個角色；不指定就是全體 */
  focus?: number;
};

const LINEUP: View = {
  target: new THREE.Vector3(0, 1.02, 0),
  dist: 9.6,
  fov: 30,
  label: "五種動漫風候選角色 —— 拖曳可轉動，數字鍵 1-5 看特寫",
};

function closeUp(i: number): View {
  const e = cast[i]!;
  return {
    target: new THREE.Vector3(e.x, 1.04, 0),
    dist: 5.1,
    fov: 26,
    label: `${e.kind.label} —— cel shading + 反向外殼描邊 + 貼圖式五官`,
    focus: i,
  };
}

let view = LINEUP;
let yaw = 0;
let pitch = 0.06;

function applyView(v: View): void {
  view = v;
  caption.textContent = v.label;
  yaw = 0;
  pitch = 0.06;
  // 看單一角色時把其他人收起來，旁邊站著人會干擾對造型的判斷
  cast.forEach((e, i) => (e.char.group.visible = v.focus === undefined || v.focus === i));
}

function updateCamera(): void {
  camera.fov = view.fov;
  camera.updateProjectionMatrix();
  const d = view.dist;
  camera.position.set(
    view.target.x + Math.sin(yaw) * Math.cos(pitch) * d,
    view.target.y + Math.sin(pitch) * d,
    view.target.z + Math.cos(yaw) * Math.cos(pitch) * d,
  );
  camera.lookAt(view.target);
}

// ---------- 互動 ----------
let dragging = false;
let lastX = 0;
let lastY = 0;
canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  yaw -= (e.clientX - lastX) * 0.006;
  pitch = Math.max(-0.25, Math.min(0.5, pitch + (e.clientY - lastY) * 0.004));
  lastX = e.clientX;
  lastY = e.clientY;
});
for (const ev of ["pointerup", "pointercancel"] as const) {
  canvas.addEventListener(ev, () => (dragging = false));
}

const bar = document.getElementById("views") as HTMLElement;
function addButton(label: string, v: () => View): void {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", () => {
    applyView(v());
    for (const other of bar.querySelectorAll("button")) other.classList.remove("on");
    b.classList.add("on");
  });
  bar.appendChild(b);
}
addButton("全體", () => LINEUP);
ANIME_KINDS.forEach((k, i) => addButton(k.label, () => closeUp(i)));
// 預設全體視角；下面的 ?view= 會蓋掉它
(bar.children[0] as HTMLButtonElement).click();

addEventListener("keydown", (e) => {
  const n = Number(e.key);
  if (n >= 1 && n <= cast.length) (bar.children[n] as HTMLButtonElement).click();
  if (e.key === "0") (bar.children[0] as HTMLButtonElement).click();
});

// 截圖用：?view=2 直接開在該角色的特寫，不用手動點
const wanted = new URLSearchParams(location.search).get("view");
if (wanted !== null) {
  const i = Number(wanted);
  if (Number.isInteger(i) && i >= 0 && i < cast.length) {
    (bar.children[i + 1] as HTMLButtonElement).click();
  }
}
// 動畫定格在固定時間點，截圖才不會每次姿勢都不一樣
const frozen = new URLSearchParams(location.search).get("t");

// 拿 canvas.width 比對會永遠不相等（那是乘過 pixelRatio 又取整的裝置像素），變成每幀都重設 size
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

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  resize();
  const t = frozen !== null ? Number(frozen) : clock.getElapsedTime();
  for (const e of cast) {
    e.char.update(t + e.x);
    // 共通的待機浮動，跟 scene3d 的做法一致：由場景統一處理
    e.char.group.position.y = Math.sin(t * 1.5 + e.x) * 0.022;
  }
  updateCamera();
  renderer.render(scene, camera);
});
