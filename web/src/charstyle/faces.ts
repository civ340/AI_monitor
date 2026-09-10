import * as THREE from "three";

/**
 * 動漫臉不能用幾何體堆 —— 大眼睛的高光、睫毛、腮紅在 low-poly 球體上做不出來，
 * 而且五官只要是獨立的 mesh，遲早會跟臉部曲面互相穿插。
 * 這裡整張臉畫在 canvas 上，貼到一片「貼著頭骨的球面」，
 * 貼片是頭的子節點，頭怎麼轉怎麼縮放，五官都不會脫落。
 */

export type Expression = "smile" | "wink" | "cat" | "calm";

export type FaceOpts = {
  /** 虹膜色，通常呼應該角色的主題色 */
  iris: string;
  /** 眉毛與睫毛色，通常跟髮色同系 */
  ink: string;
  expression: Expression;
  blush?: boolean;
};

const S = 512;

function drawEye(
  x: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  o: FaceOpts,
  closed: boolean,
): void {
  // 大小抓 pixiv chibi 常見的比例：單眼寬約臉寬的 1/4，高略大於寬
  const w = 66;
  const h = 84;

  if (closed) {
    // 眨眼：一條上凸的弧線，比畫成「>」自然
    x.strokeStyle = o.ink;
    x.lineWidth = 15;
    x.lineCap = "round";
    x.beginPath();
    x.moveTo(cx - w, cy + 12);
    x.quadraticCurveTo(cx, cy - 34, cx + w, cy + 12);
    x.stroke();
    return;
  }

  // 眼白
  x.save();
  x.beginPath();
  x.ellipse(cx, cy, w, h, 0, 0, Math.PI * 2);
  x.fillStyle = "#fffdf9";
  x.fill();
  x.clip();

  // 虹膜：上深下亮，動漫眼的通透感全靠這道漸層
  const g = x.createLinearGradient(cx, cy - h, cx, cy + h);
  g.addColorStop(0, shade(o.iris, -0.45));
  g.addColorStop(0.55, o.iris);
  g.addColorStop(1, shade(o.iris, 0.5));
  x.beginPath();
  x.ellipse(cx, cy + 6, w * 0.9, h * 0.88, 0, 0, Math.PI * 2);
  x.fillStyle = g;
  x.fill();

  // 瞳孔與下緣的環境反光。那片反光要夠大：動漫眼睛的通透感
  // 有一半來自下半虹膜這塊亮區，畫細一條就只是「有反光」而已
  x.beginPath();
  x.ellipse(cx, cy + 10, w * 0.4, h * 0.44, 0, 0, Math.PI * 2);
  x.fillStyle = "#2c1d2b";
  x.fill();
  x.beginPath();
  x.ellipse(cx, cy + h * 0.46, w * 0.72, h * 0.3, 0, 0, Math.PI * 2);
  x.fillStyle = "rgba(255,255,255,0.62)";
  x.fill();

  // 上眼瞼在眼球上壓出的陰影
  x.beginPath();
  x.ellipse(cx, cy - h * 0.85, w * 1.1, h * 0.45, 0, 0, Math.PI * 2);
  x.fillStyle = "rgba(60,40,60,0.35)";
  x.fill();
  x.restore();

  // 高光：大的在左上、小的在右下，兩顆不同大小才有立體感
  x.beginPath();
  x.arc(cx - w * 0.32, cy - h * 0.36, w * 0.3, 0, Math.PI * 2);
  x.fillStyle = "#ffffff";
  x.fill();
  x.beginPath();
  x.arc(cx + w * 0.36, cy + h * 0.34, w * 0.14, 0, Math.PI * 2);
  x.fillStyle = "rgba(255,255,255,0.85)";
  x.fill();

  // 上睫毛：一條粗弧線包住眼睛上緣
  x.strokeStyle = o.ink;
  x.lineWidth = 17;
  x.lineCap = "round";
  x.beginPath();
  x.ellipse(cx, cy, w + 2, h, 0, Math.PI * 1.06, Math.PI * 1.94);
  x.stroke();
  // 外眼角往上翹一點
  x.lineWidth = 13;
  x.beginPath();
  x.moveTo(cx + (cx > S / 2 ? w : -w) * 0.98, cy - h * 0.28);
  x.lineTo(cx + (cx > S / 2 ? w : -w) * 1.28, cy - h * 0.62);
  x.stroke();
}

function drawMouth(x: CanvasRenderingContext2D, cy: number, o: FaceOpts): void {
  x.strokeStyle = o.ink;
  x.lineWidth = 9;
  x.lineCap = "round";
  const cx = S / 2;
  if (o.expression === "cat") {
    // ω 嘴
    x.beginPath();
    x.arc(cx - 15, cy, 15, Math.PI * 0.05, Math.PI * 0.95);
    x.stroke();
    x.beginPath();
    x.arc(cx + 15, cy, 15, Math.PI * 0.05, Math.PI * 0.95);
    x.stroke();
    return;
  }
  if (o.expression === "calm") {
    x.beginPath();
    x.moveTo(cx - 16, cy);
    x.lineTo(cx + 16, cy);
    x.stroke();
    return;
  }
  // 張口的小笑臉
  x.beginPath();
  x.moveTo(cx - 26, cy - 6);
  x.quadraticCurveTo(cx, cy + 30, cx + 26, cy - 6);
  x.closePath();
  x.fillStyle = "#8c4a5c";
  x.fill();
  x.strokeStyle = o.ink;
  x.lineWidth = 7;
  x.stroke();
}

/** 把 #rrggbb 往亮/暗推；amount 正數變亮 */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.round(amount >= 0 ? v + (255 - v) * amount : v * (1 + amount)),
  );
  return `rgb(${ch[0]}, ${ch[1]}, ${ch[2]})`;
}

export function makeFaceTexture(o: FaceOpts): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d")!;

  const eyeY = 232;
  // 眼距約一個眼睛寬，眼睛外緣貼近臉的兩側
  const lx = 158;
  const rx = S - 158;

  // 眉毛
  x.strokeStyle = o.ink;
  x.lineWidth = 13;
  x.lineCap = "round";
  for (const [bx, dir] of [
    [lx, -1],
    [rx, 1],
  ] as const) {
    x.beginPath();
    x.moveTo(bx - 52 * dir, eyeY - 120);
    x.quadraticCurveTo(bx + 6 * dir, eyeY - 144, bx + 56 * dir, eyeY - 110);
    x.stroke();
  }

  if (o.blush !== false) {
    for (const bx of [lx - 84, rx + 84]) {
      x.beginPath();
      x.ellipse(bx, eyeY + 92, 42, 23, 0, 0, Math.PI * 2);
      x.fillStyle = "rgba(255, 140, 150, 0.42)";
      x.fill();
    }
  }

  drawEye(x, lx, eyeY, o, o.expression === "wink");
  drawEye(x, rx, eyeY, o, false);
  drawMouth(x, eyeY + 140, o);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * 臉部貼片：一片貼著頭骨的球面，UV 正好鋪滿整張 canvas。
 * 半徑比頭大一點點避免 z-fighting；用 basic 材質，
 * 動漫的臉本來就不吃明暗，跟著 toon 一起被打暗反而會髒。
 */
export function makeFacePatch(headRadius: number, o: FaceOpts): THREE.Mesh {
  const phiLen = 1.5;
  const thetaLen = 1.45;
  const geo = new THREE.SphereGeometry(
    headRadius + 0.006,
    40,
    32,
    Math.PI / 2 - phiLen / 2,
    phiLen,
    Math.PI / 2 - thetaLen * 0.46,
    thetaLen,
  );
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ map: makeFaceTexture(o), transparent: true }),
  );
  mesh.userData.noOutline = true;
  return mesh;
}
