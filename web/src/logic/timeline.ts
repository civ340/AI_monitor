import type { AgentKind, AgentRunState, HistoryEvent } from "@shared/types";

/** 時間軸上的一個色段。offline 不畫（留白），所以不出現在 segs 裡 */
export type Seg = {
  state: Exclude<AgentRunState, "offline">;
  start: number;
  end: number;
};

export type TimelineRow = {
  id: string;
  name: string;
  kind: AgentKind;
  cwd?: string;
  segs: Seg[];
};

/**
 * 由 state 轉換事件推出每個 agent 的色段。
 * - 事件 to=X 表示從 ts 起是 X，到下一個事件為止；最後一段（未結束）算到 now
 * - to=null（離場）結束目前的段落
 * - 區間內第一個事件如果 from 不是 null，代表 since 之前就已經在場：補一段 since→ts 的 from 狀態
 * - 亂序、壞資料（缺 ts／id）略過；同狀態相鄰段落合併
 * 只回 resident（transient 由 summary 的 subagents 統計）。
 */
export function buildTimelines(events: HistoryEvent[], since: number, now: number): TimelineRow[] {
  const valid: HistoryEvent[] = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e.ts !== "number" || typeof e.id !== "string") continue;
    // server-start 標記要留著（它會結束開著的段落），但它本身不是 agent
    if (e.marker !== "server-start" && e.kind !== "resident") continue;
    valid.push(e);
  }
  // 穩定排序：同 ts 維持原順序（標記先於重啟後的進場事件）
  valid.sort((a, b) => a.ts - b.ts);

  type Acc = { first: HistoryEvent; last: HistoryEvent; segs: Seg[]; cur: AgentRunState | null; curStart: number };
  const accs = new Map<string, Acc>();
  const push = (acc: Acc, state: AgentRunState | null, start: number, end: number): void => {
    if (state === null || state === "offline") return;
    const s = Math.max(start, since);
    const e = Math.min(end, now);
    if (e <= s) return;
    const last = acc.segs[acc.segs.length - 1];
    if (last && last.state === state && last.end === s) last.end = e;
    else acc.segs.push({ state, start: s, end: e });
  };

  /** 標記前最後一筆（非標記）事件的 ts */
  let lastTs = since;
  for (const e of valid) {
    if (e.marker === "server-start") {
      // server 停機期間沒人記錄：開著的段落結束在上一輪最後存活時間（心跳 lastAliveAt），
      // 沒有就結在標記前最後一筆事件；不得超過標記本身。之後視為不在場
      const end = Math.min(typeof e.lastAliveAt === "number" ? Math.max(e.lastAliveAt, lastTs) : lastTs, e.ts);
      for (const acc of accs.values()) {
        push(acc, acc.cur, acc.curStart, end);
        acc.cur = null;
      }
      continue;
    }
    lastTs = e.ts;
    let acc = accs.get(e.id);
    if (!acc) {
      acc = { first: e, last: e, segs: [], cur: null, curStart: 0 };
      accs.set(e.id, acc);
      if (e.from !== null) push(acc, e.from, since, e.ts);
    }
    push(acc, acc.cur, acc.curStart, e.ts);
    acc.cur = e.to;
    acc.curStart = e.ts;
    acc.last = e;
  }

  const rows: TimelineRow[] = [];
  for (const [id, acc] of accs) {
    push(acc, acc.cur, acc.curStart, now);
    rows.push({ id, name: acc.last.name, kind: acc.last.kind, cwd: acc.last.cwd ?? acc.first.cwd, segs: acc.segs });
  }
  // 順序穩定：先到先排，同時間用 id
  rows.sort((a, b) => (a.segs[0]?.start ?? 0) - (b.segs[0]?.start ?? 0) || a.id.localeCompare(b.id));
  return rows;
}

/** 時間軸刻度：範圍 ≤12 小時每小時一格，否則每 3 小時；ts 對齊本地整點 */
export function axisTicks(since: number, now: number): number[] {
  if (!(now > since)) return [];
  const stepH = now - since <= 12 * 3_600_000 ? 1 : 3;
  const d = new Date(since);
  d.setMinutes(0, 0, 0);
  const out: number[] = [];
  for (let t = d.getTime(); t <= now; ) {
    if (t >= since) out.push(t);
    const n = new Date(t);
    n.setHours(n.getHours() + stepH);
    t = n.getTime();
  }
  return out;
}
