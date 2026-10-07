/**
 * 依專案（cwd）分組的工位配置。純函式：輸入 resident 清單，輸出每張桌子的 x 座標
 * 與每個專案區的範圍（給地上的專案牌用）。
 *
 * 穩定性靠「確定性排序」：專案依名稱排、組內依 id 排，沒有任何隨進場先後而變的狀態，
 * 所以多一個／少一個 agent 時，其他人的相對順序不變，只是整排等比例收攏。
 */

export type DeskInput = { id: string; cwd?: string };
export type DeskSlot = { id: string; x: number; group: string };
export type DeskGroup = {
  /** 正規化後的 cwd；沒有 cwd 的是空字串 */
  key: string;
  /** 原始 cwd（顯示名由呼叫端用 projectName 取） */
  cwd?: string;
  /** 該組桌子 x 範圍的中心與左右端 */
  cx: number;
  x0: number;
  x1: number;
  count: number;
};

export type DeskLayout = { slots: DeskSlot[]; groups: DeskGroup[] };

type Opts = {
  /** 同組相鄰桌子的間距 */
  step?: number;
  /** 組與組之間額外多留的空隙 */
  groupGap?: number;
  /** 整排最寬能展開多少，超過就等比例收攏 */
  maxSpan?: number;
};

/** 大小寫與斜線方向不影響分組（Windows 路徑） */
export function cwdKey(cwd: string | undefined): string {
  if (!cwd) return "";
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function layoutDesks(list: DeskInput[], opts: Opts = {}): DeskLayout {
  const step = opts.step ?? 2.95;
  const gap = opts.groupGap ?? 0.9;
  const maxSpan = opts.maxSpan ?? 10.4;

  const buckets = new Map<string, DeskInput[]>();
  for (const a of list) {
    const k = cwdKey(a.cwd);
    const b = buckets.get(k) ?? [];
    b.push(a);
    buckets.set(k, b);
  }
  // 沒有 cwd 的放最後；其餘依 key 排
  const keys = [...buckets.keys()].sort((a, b) =>
    a === b ? 0 : a === "" ? 1 : b === "" ? -1 : a.localeCompare(b),
  );

  // 先用「單位座標」排好，再整體縮放與置中
  const raws: { id: string; pos: number; key: string }[] = [];
  const spans: { key: string; cwd?: string; p0: number; p1: number; count: number }[] = [];
  let pos = 0;
  keys.forEach((key, gi) => {
    const members = buckets.get(key)!.slice().sort((a, b) => a.id.localeCompare(b.id));
    if (gi > 0) pos += step + gap;
    const p0 = pos;
    members.forEach((m, i) => {
      if (i > 0) pos += step;
      raws.push({ id: m.id, pos, key });
    });
    spans.push({ key, cwd: members[0]?.cwd, p0, p1: pos, count: members.length });
  });

  if (raws.length === 0) return { slots: [], groups: [] };
  const total = pos;
  const scale = total > maxSpan ? maxSpan / total : 1;
  const toX = (p: number): number => (p - total / 2) * scale;

  return {
    slots: raws.map((r) => ({ id: r.id, x: toX(r.pos), group: r.key })),
    groups: spans.map((s) => ({
      key: s.key,
      cwd: s.cwd,
      cx: toX((s.p0 + s.p1) / 2),
      x0: toX(s.p0),
      x1: toX(s.p1),
      count: s.count,
    })),
  };
}
