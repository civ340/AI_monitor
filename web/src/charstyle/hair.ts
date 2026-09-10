import * as THREE from "three";

/**
 * 一片有厚度的頭髮殼：內外兩層球面 + 把邊緣封起來。
 *
 * 為什麼不用現成的 SphereGeometry 切一塊：
 * 1. 球面補丁的下緣一定是等 theta 的規則圓弧，正面看就是西瓜皮；
 *    要參差的髮際線只能靠拼很多塊，拼出來是階梯狀的。
 * 2. 反向外殼描邊只對封閉的量體有效。單層開放曲面在髮際線那一圈畫不出線，
 *    而髮際線正是動漫風最吃重的一條邊。
 *
 * 這裡下緣深度由 edge(u) 決定，u 從 0 到 1 掃過 phi 範圍，
 * 回傳該處的頭髮要蓋到多深（弧度，0 是頭頂）。
 */
export function hairShell(o: {
  phiStart: number;
  phiLength: number;
  /** 內層半徑：埋進頭骨裡，免得跟臉部貼片打架 */
  inner: number;
  outer: number;
  edge: (u: number) => number;
  /** 上緣。預設從頭頂（0）開始；給了值就變成一條帶子，用來做頭髮高光 */
  edgeTop?: (u: number) => number;
  cols?: number;
  rows?: number;
}): THREE.BufferGeometry {
  const cols = o.cols ?? 60;
  const rows = o.rows ?? 14;
  const top = o.edgeTop;
  const pos: number[] = [];
  const idx: number[] = [];

  // 跟 three 的 SphereGeometry 同一套座標慣例：phi = π/2 是正前方 +Z
  const push = (r: number, phi: number, theta: number): void => {
    pos.push(
      -r * Math.cos(phi) * Math.sin(theta),
      r * Math.cos(theta),
      r * Math.sin(phi) * Math.sin(theta),
    );
  };

  const stride = rows + 1;
  const layer = (cols + 1) * stride;
  for (const radius of [o.outer, o.inner]) {
    for (let j = 0; j <= cols; j++) {
      const u = j / cols;
      const phi = o.phiStart + u * o.phiLength;
      const t0 = top ? top(u) : 0;
      const t1 = o.edge(u);
      for (let i = 0; i <= rows; i++) push(radius, phi, t0 + (i / rows) * (t1 - t0));
    }
  }

  const O = (j: number, i: number): number => j * stride + i;
  const I = (j: number, i: number): number => layer + j * stride + i;

  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < rows; i++) {
      // 外層：先 +theta 再 +phi 的繞法在球面上是朝外的；內層整個反過來
      idx.push(O(j, i), O(j, i + 1), O(j + 1, i + 1), O(j, i), O(j + 1, i + 1), O(j + 1, i));
      idx.push(I(j, i), I(j + 1, i + 1), I(j, i + 1), I(j, i), I(j + 1, i), I(j + 1, i + 1));
    }
    // 下緣：髮際線那一圈的厚度
    idx.push(O(j, rows), I(j, rows), I(j + 1, rows), O(j, rows), I(j + 1, rows), O(j + 1, rows));
    // 有上緣時要一起封起來，否則帶子頂端是個開口，描邊與明暗都會破
    if (top) idx.push(O(j, 0), I(j + 1, 0), I(j, 0), O(j, 0), O(j + 1, 0), I(j + 1, 0));
  }
  // 左右兩道切口
  for (let i = 0; i < rows; i++) {
    idx.push(O(0, i), I(0, i), I(0, i + 1), O(0, i), I(0, i + 1), O(0, i + 1));
    idx.push(O(cols, i), O(cols, i + 1), I(cols, i + 1), O(cols, i), I(cols, i + 1), I(cols, i));
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * 瀏海的下緣曲線：中間短、兩側長，再疊一道小波浪。
 * 兩側拉長之後自然就變成框住臉的鬢髮，不用另外掛髮束
 * （掛上去的髮束跟頭是兩個獨立量體，一轉頭就會露餡）。
 */
export function bangEdge(
  center: number,
  side: number,
  /** 最外側要收回到的深度，接後腦那片的下緣 */
  back = 1.62,
  waves = 7,
): (u: number) => number {
  const peak = 0.72; // 鬢髮最長的位置，留最後一段慢慢收回去
  return (u) => {
    const s = Math.abs(u - 0.5) * 2;
    const wave = 0.06 * Math.sin(u * Math.PI * waves + 0.6);
    if (s <= peak) return center + (side - center) * Math.pow(s / peak, 1.7) + wave;
    // 不收的話瀏海尾端會比後腦低一大截，側面會看到一個方形缺口
    const t = (s - peak) / (1 - peak);
    return side + (back - side) * t + wave * (1 - t);
  };
}
