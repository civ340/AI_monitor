/** 名牌防重疊：純幾何，不碰 DOM，方便測試。座標是螢幕 px，名牌以 (x 置中, y 為底邊) 定位。 */

export type LabelBox = {
  id: string;
  /** 錨點（頭頂）螢幕座標 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 越大越先佔位置（先佔的不會被擠開） */
  priority: number;
  /** 完整卡片：塞不下時也不能被藏掉 */
  full: boolean;
  /** 要不要避開 obstacles（白板）。被指著／選中的卡片不避，它是使用者正在看的 */
  avoid?: boolean;
};

export type LabelPlacement = {
  id: string;
  /** 名牌底邊中點 */
  x: number;
  y: number;
  /** 擠不進畫面時（只會發生在精簡名牌）為 true */
  hidden: boolean;
};

export type Rect = { left: number; top: number; right: number; bottom: number };

const GAP = 3;

function rectOf(x: number, y: number, w: number, h: number): Rect {
  return { left: x - w / 2, right: x + w / 2, top: y - h, bottom: y };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * 依優先順序貼名牌：x 夾進畫面，碰到已放好的就往上疊（疊到對方上緣再留一點縫）。
 * 同優先級由畫面下方（離鏡頭近）的先放，後方的人被往上推，符合遠近直覺。
 */
export function layoutLabels(
  items: LabelBox[],
  width: number,
  height: number,
  obstacles: Rect[] = [],
): LabelPlacement[] {
  const order = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => b.it.priority - a.it.priority || b.it.y - a.it.y || a.i - b.i);
  const placed: Rect[] = [];
  const out = new Map<string, LabelPlacement>();

  for (const { it } of order) {
    const half = it.w / 2;
    const x = Math.min(Math.max(it.x, half + 4), Math.max(half + 4, width - half - 4));
    let y = Math.min(it.y, height - 4);
    // 每次被擋就跳到擋住者的上緣；最多繞 items 數次就必定收斂
    for (let n = 0; n <= items.length + obstacles.length; n++) {
      const r = rectOf(x, y, it.w, it.h);
      const hit = placed.find((p) => overlaps(r, p)) ?? (it.avoid ? obstacles.find((p) => overlaps(r, p)) : undefined);
      if (!hit) break;
      y = hit.top - GAP;
    }
    const r = rectOf(x, y, it.w, it.h);
    let hidden = false;
    if (r.top < 4) {
      if (it.full) y = it.h + 4;
      else hidden = true;
    }
    const final = rectOf(x, y, it.w, it.h);
    if (!hidden) placed.push(final);
    out.set(it.id, { id: it.id, x, y, hidden });
  }
  return items.map((it) => out.get(it.id)!);
}

/** 名牌跟某個區域（白板）重疊的比例 0..1，用來決定要淡多少 */
export function overlapRatio(box: Rect, area: Rect): number {
  const w = Math.min(box.right, area.right) - Math.max(box.left, area.left);
  const h = Math.min(box.bottom, area.bottom) - Math.max(box.top, area.top);
  if (w <= 0 || h <= 0) return 0;
  const total = (box.right - box.left) * (box.bottom - box.top);
  return total <= 0 ? 0 : (w * h) / total;
}

export { rectOf };
