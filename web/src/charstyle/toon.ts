import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Cel shading 的兩件事：階梯狀的明暗，以及外框線。
 * 這兩件都不能靠 MeshStandardMaterial 硬調參數模擬出來，
 * 所以動漫風角色整套材質獨立於 scene3d/ 的寫實低多邊形那套。
 */

/** 三階漸層貼圖 —— 階數就是這張 1×N 貼圖的像素數，NearestFilter 才不會被插值成平滑漸層 */
export function makeToonGradient(steps: number[] = [120, 200, 255]): THREE.DataTexture {
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => {
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  });
  const tex = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const GRADIENT = makeToonGradient();
// 皮膚用平一點的色階：臉上那道明暗交界會橫切過眼睛，
// 布料需要的硬色塊感在臉上只會變成一塊髒污
const SKIN_GRADIENT = makeToonGradient([208, 234, 255]);

const cache = new Map<string, THREE.MeshToonMaterial>();

/** 同色共用同一份材質：一個角色身上重複的布料/皮膚不需要各自編譯一次 shader */
export function toonMat(color: number, soft = false): THREE.MeshToonMaterial {
  const key = `${color}:${soft}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const m = new THREE.MeshToonMaterial({
    color,
    gradientMap: soft ? SKIN_GRADIENT : GRADIENT,
  });
  cache.set(key, m);
  return m;
}

/**
 * 標記「這份材質是這個角色自己的」。
 * toonMat 那種以顏色為 key 的共用快取跨角色共用，丟掉會波及還在場上的人；
 * 這裡標起來的則是每個角色現做的，角色 dispose 時必須跟著丟，
 * 否則 job 來來去去會把材質與貼圖無上限累積在 GPU 上。
 */
export function markOwned<T extends THREE.Material>(mat: T): T {
  mat.userData.owned = true;
  return mat;
}

/** 這份材質是不是角色自有（可丟）的 */
export function isOwned(mat: THREE.Material): boolean {
  return mat.userData.owned === true;
}

/**
 * 丟掉一份角色自有材質，連同它自己做的貼圖。
 * 描邊材質同時要從 outlineMats 移除 —— 不然換主題時會一直遍歷到早就死掉的材質。
 */
export function disposeOwnedMaterial(mat: THREE.Material): void {
  outlineMats.delete(mat as THREE.ShaderMaterial);
  const withMap = mat as THREE.Material & { map?: THREE.Texture | null };
  withMap.map?.dispose();
  mat.dispose();
}

/** 自發光（兜帽角色的眼睛、螢幕）不吃燈光，直接給 basic。無法以顏色共用，屬角色自有 */
export function glowMat(color: number): THREE.MeshBasicMaterial {
  return markOwned(new THREE.MeshBasicMaterial({ color, toneMapped: false }));
}

/**
 * 反向外殼描邊：同一份幾何沿法線推出去一點、只畫背面。
 * 用 ShaderMaterial 而不是「整體放大 1.03」——後者在細長物件上會把線畫成粗細不均。
 */
// 用 Set 而不是陣列：角色 dispose 時要能把自己那份描邊材質移除。
// 陣列只進不出的話，長時間 churn 之後這裡會壓著幾百份死材質，
// 而每次切主題都得整批遍歷改寫。
const outlineMats = new Set<THREE.ShaderMaterial>();
let outlineColor = 0x4a3340;

/**
 * 統一換描邊顏色。深色背景配深色描邊，剪影會整個糊進背景 ——
 * 讓輪廓線跟著主題走，是暗場景裡最有效的一招（比把角色打亮有效得多）。
 */
export function setOutlineColor(color: number): void {
  // 也要記起來：套主題時角色可能還沒生出來，之後才建的描邊得拿到同一個顏色
  outlineColor = color;
  for (const m of outlineMats) (m.uniforms.uColor!.value as THREE.Color).setHex(color);
}

function outlineMaterial(width: number, color: number): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uWidth: { value: width }, uColor: { value: new THREE.Color(color) } },
    vertexShader: `
      uniform float uWidth;
      void main() {
        vec3 p = position + normalize(normal) * uWidth;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor, 1.0); }
    `,
  });
  outlineMats.add(markOwned(mat));
  return mat;
}

const shellGeos = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

/**
 * 描邊殼專用的幾何。直接拿原幾何外推會在 UV 接縫裂開：接縫上的頂點是為了
 * 給兩組 UV 而複製出來的，法線各自朝外，殼在那一條線上就對不起來，
 * 看起來像身上被畫了一刀。這裡把 UV 丟掉、合併重複頂點後重算法線，
 * 得到一份接縫連續的「只有位置」幾何。
 */
function shellGeometry(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const hit = shellGeos.get(geo);
  if (hit) return hit;
  const pos = geo.getAttribute("position");
  const bare = new THREE.BufferGeometry();
  bare.setAttribute("position", pos.clone());
  if (geo.index) bare.setIndex(geo.index.clone());
  const merged = mergeVertices(bare, 1e-4);
  merged.computeVertexNormals();
  shellGeos.set(geo, merged);
  return merged;
}

/**
 * 幫整棵子樹加描邊。殼掛在原 mesh 底下，之後不管誰去動 mesh 的 transform，
 * 描邊都自動跟著走 —— 這是把描邊做成兄弟節點時最常見的破圖來源。
 * 不想要描邊的（貼在臉上的五官、發光眼）標 userData.noOutline = true。
 */
export function addOutlines(root: THREE.Object3D, width = 0.016, color = outlineColor): void {
  const mat = outlineMaterial(width, color);
  const targets: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.userData.noOutline !== true) targets.push(m);
  });
  for (const m of targets) {
    const shell = new THREE.Mesh(shellGeometry(m.geometry), mat);
    shell.userData.noOutline = true;
    // 標起來給場景端認：描邊殼靠頂點位移撐開，而 shadow pass 會換成自己的
    // depth material、完全忽略那個 shader，所以它對陰影零貢獻，不該投影
    shell.userData.outlineShell = true;
    shell.renderOrder = -1;
    m.add(shell);
  }
}

/** 腳下的軟陰影：真陰影在 toon 風格會變成硬邊黑塊，這裡改用一張徑向漸層貼片 */
export function makeBlobShadow(radius = 0.55): THREE.Mesh {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, "rgba(74, 51, 64, 0.42)");
  grad.addColorStop(0.55, "rgba(74, 51, 64, 0.18)");
  grad.addColorStop(1, "rgba(74, 51, 64, 0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.012;
  mesh.userData.noOutline = true;
  // 標起來給場景端認：有真陰影的場景（office3d）會把這片拆掉，
  // 兩層疊起來腳下會糊成一塊。沒標的話那邊的拆除分支等於死碼，
  // 貼片會留在場上、進 shadow pass，材質與貼圖也跟著漏。
  mesh.userData.blobShadow = true;
  return mesh;
}
