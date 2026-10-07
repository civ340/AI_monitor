import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentState, HistoryEvent, TodaySummary } from "@shared/types.js";

export const HISTORY_FILE = fileURLToPath(new URL("../.data/history.jsonl", import.meta.url));

/** 超過就 rotate 成 .1（只保留一份舊檔） */
export const HISTORY_ROTATE_BYTES = 5 * 1024 * 1024;
/** error 摘要上限 */
export const MAX_ERROR_CHARS = 120;
/** GET /api/history 一次最多回這麼多筆（取最新）。今日摘要不套這個上限 */
export const HISTORY_LIMIT = 5000;

/** server-start 標記事件的固定 id */
export const SERVER_MARKER_ID = "server";

/** 本地今天 00:00（epoch ms） */
export function startOfToday(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 由前後兩次的 agent 快照算出 state 轉換事件：進場、離場、state 變化。心跳不產生事件。 */
export function diffHistory(
  prev: ReadonlyMap<string, AgentState>,
  next: ReadonlyMap<string, AgentState>,
  ts: number,
): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  for (const [id, a] of next) {
    const before = prev.get(id);
    if (!before) out.push(toEvent(a, ts, null, a.state));
    else if (before.state !== a.state) out.push(toEvent(a, ts, before.state, a.state));
  }
  for (const [id, a] of prev) {
    if (!next.has(id)) out.push(toEvent(a, ts, a.state, null));
  }
  return out;
}

/** 跨日快照：每個 agent 一筆 from === to === 當下 state 的事件 */
export function snapshotHistory(agents: Iterable<AgentState>, ts: number): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  for (const a of agents) out.push(toEvent(a, ts, a.state, a.state));
  return out;
}

/** shutdown：替每個在場 agent 寫一筆離場事件（from 為當下 state、to=null） */
export function shutdownHistory(agents: Iterable<AgentState>, ts: number): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  for (const a of agents) out.push(toEvent(a, ts, a.state, null));
  return out;
}

/** server 啟動標記。見 HistoryEvent.marker */
export function serverStartEvent(ts: number, lastAliveAt?: number): HistoryEvent {
  const e: HistoryEvent = { ts, id: SERVER_MARKER_ID, name: "server", kind: "resident", from: null, to: null, marker: "server-start" };
  if (typeof lastAliveAt === "number" && Number.isFinite(lastAliveAt)) e.lastAliveAt = lastAliveAt;
  return e;
}

/** 不存 detail（可能含使用者內容）；只在轉成 error 時存一行錯誤摘要 */
function toEvent(a: AgentState, ts: number, from: HistoryEvent["from"], to: HistoryEvent["to"]): HistoryEvent {
  const ev: HistoryEvent = { ts, id: a.id, name: a.name, kind: a.kind, from, to };
  if (a.parent) ev.parent = a.parent;
  if (a.cwd) ev.cwd = a.cwd;
  if (to === "error" && typeof a.error === "string" && a.error) ev.error = a.error.slice(0, MAX_ERROR_CHARS);
  return ev;
}

// ---------- 今日快取 ----------

type Cache = {
  /** 快取涵蓋的「今天 00:00」；跨日時過濾掉昨天的 */
  dayStart: number;
  events: HistoryEvent[];
  ready: boolean;
  /** 載入進行中時 append 進來的事件，載入完成後併入 */
  pending: HistoryEvent[];
  loading?: Promise<void>;
};

const caches = new Map<string, Cache>();

/** 測試用：清掉快取（不給檔案就全清） */
export function resetHistoryCache(file?: string): void {
  if (file === undefined) caches.clear();
  else caches.delete(file);
}

function rollDay(c: Cache, now: number): void {
  const day = startOfToday(now);
  if (day !== c.dayStart) {
    c.dayStart = day;
    c.events = c.events.filter((e) => e.ts >= day);
  }
}

/** 追加事件到 jsonl（同步，shutdown 時要能在 exit 前落地）；失敗只 warn，絕不讓 server 崩 */
export function appendHistory(file: string, events: HistoryEvent[]): void {
  if (events.length === 0) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > HISTORY_ROTATE_BYTES) renameSync(file, file + ".1");
    } catch {
      // 檔案還不存在或 rename 失敗，都不擋寫入
    }
    appendFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  } catch (err) {
    console.warn("[history] 寫入失敗:", err);
    return;
  }
  const c = caches.get(file);
  if (!c) return;
  if (c.ready) {
    rollDay(c, Date.now());
    c.events.push(...events);
  } else {
    c.pending.push(...events);
  }
}

/** 舊版會把 detail（內容文字）寫進檔案：讀出時剝掉；舊的 error 事件把摘要搬到 error 欄位 */
function sanitize(e: HistoryEvent & { detail?: unknown }): HistoryEvent {
  const { detail, ...rest } = e;
  if (rest.to === "error" && rest.error === undefined && typeof detail === "string" && detail) {
    return { ...rest, error: detail.slice(0, MAX_ERROR_CHARS) };
  }
  return rest;
}

async function readJsonl(file: string): Promise<HistoryEvent[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: HistoryEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as HistoryEvent;
      if (typeof e.ts === "number" && typeof e.id === "string") out.push(sanitize(e));
    } catch {
      // 壞行略過
    }
  }
  return out;
}

/**
 * 非同步讀 ts >= since 的事件（含 rotate 出去的 .1），依時間排序，超過 limit 取最新的。
 * 不快取；今天的事件請用 readTodayEvents。
 */
export async function readHistory(file: string, since: number, limit: number = HISTORY_LIMIT): Promise<HistoryEvent[]> {
  const [old, cur] = await Promise.all([readJsonl(file + ".1"), readJsonl(file)]);
  const all = [...old, ...cur].filter((e) => e.ts >= since);
  all.sort((a, b) => a.ts - b.ts);
  return all.length > limit ? all.slice(all.length - limit) : all;
}

/**
 * 今天（本地 00:00 起）的全部事件，記憶體快取。
 * 第一次呼叫非同步載入；之後 appendHistory 會同步更新快取，跨日自動丟掉昨天的。
 * 回傳的陣列是快取本體，呼叫端不得修改。不套筆數上限（今日摘要要完整資料）。
 */
export async function readTodayEvents(file: string, now: number = Date.now()): Promise<HistoryEvent[]> {
  let c = caches.get(file);
  if (!c) {
    const created: Cache = { dayStart: startOfToday(now), events: [], ready: false, pending: [] };
    c = created;
    caches.set(file, created);
    created.loading = readHistory(file, created.dayStart, Number.POSITIVE_INFINITY).then((loaded) => {
      // 載入期間的 append 可能已經在檔案裡（被讀到）也在 pending 裡：用內容去重
      const seen = new Set(loaded.map((e) => JSON.stringify(e)));
      const extra = created.pending.filter((e) => !seen.has(JSON.stringify(e)));
      created.events = [...loaded, ...extra].sort((a, b) => a.ts - b.ts);
      created.pending = [];
      created.ready = true;
    });
  }
  if (!c.ready) await c.loading;
  rollDay(c, now);
  return c.events;
}

/**
 * server-start 標記處，開著的段落該結束在哪：上一輪最後存活時間（心跳，marker.lastAliveAt）；
 * 沒有心跳就退回前一筆非標記事件。心跳比前一筆事件舊（寫入失敗等）時以事件為準，也不得超過標記本身。
 */
export function markerEnd(marker: HistoryEvent, lastEventTs: number): number {
  const alive = typeof marker.lastAliveAt === "number" ? Math.max(marker.lastAliveAt, lastEventTs) : lastEventTs;
  return Math.min(alive, marker.ts);
}

type Seg = { state: HistoryEvent["to"]; since: number };

/**
 * 今日摘要，純函式。
 *
 * - 常駐 agent：working/waiting 累積時間，由 state 轉換事件切段，進行中的段落算到 now。
 *   窗口內第一筆事件若 from 非 null（今天以前就在場），把 from 的狀態視為從 since 起算。
 * - 臨時人力：kind === "transient" 的進場／離場配對；進場時已有未結束的同 id（server 重啟後重新進場）
 *   不重複計數，只把前段在重啟時結清、新段另起。
 * - server-start 標記：server 停機期間沒人記錄，不能算成工作時間。遇到標記就把所有仍開著的段落
 *   （常駐與臨時）結束在 markerEnd()：標記帶的 lastAliveAt（心跳），沒有就是「標記前最後一筆事件的 ts」。
 *   正常關閉時 shutdown 已寫了離場事件，這裡處理的是被強制結束、沒來得及寫離場的情況。
 * - 臨時人力 count 以 id 去重：跨重啟同 id 再進場不重複計數。
 * - usage：直接加總「目前」store 內各 agent 的 usage。這是近似值 ——
 *   今天以前就啟動的 session，其累計量也被算進來；已離場的 agent 則不在內。
 */
export function computeTodaySummary(
  events: readonly HistoryEvent[],
  current: readonly AgentState[],
  since: number,
  now: number,
): TodaySummary {
  const sorted = events.filter((e) => e.ts >= since).sort((a, b) => a.ts - b.ts);

  const residents = new Map<string, TodaySummary["agents"][number] & { seg?: Seg }>();
  const byType: TodaySummary["subagents"]["byType"] = {};
  let subCount = 0;
  let subTotal = 0;
  /** 今天已計數的臨時人力 id：跨重啟同 id 再進場、或強制結束後再進場，count 都只加一次（時間照段落累加） */
  const counted = new Set<string>();
  const countSub = (id: string, name: string): void => {
    if (counted.has(id)) return;
    counted.add(id);
    subCount++;
    (byType[name] ??= { count: 0, totalMs: 0 }).count++;
  };
  const openSub = new Map<string, { name: string; since: number }>();

  const closeResident = (r: NonNullable<ReturnType<typeof residents.get>>, at: number): void => {
    if (!r.seg) return;
    const dur = Math.max(0, at - r.seg.since);
    if (r.seg.state === "working") r.workingMs += dur;
    else if (r.seg.state === "waiting") r.waitingMs += dur;
    r.seg = undefined;
  };
  const closeSub = (id: string, at: number): void => {
    const o = openSub.get(id);
    if (!o) return;
    const dur = Math.max(0, at - o.since);
    subTotal += dur;
    const t = (byType[o.name] ??= { count: 0, totalMs: 0 });
    t.totalMs += dur;
    openSub.delete(id);
  };

  /** 標記前最後一筆（非標記）事件的 ts */
  let lastTs = since;

  for (const e of sorted) {
    if (e.marker === "server-start") {
      const end = markerEnd(e, lastTs);
      for (const r of residents.values()) {
        if (r.seg) {
          closeResident(r, end);
          r.lastSeen = Math.max(r.lastSeen, end);
        }
      }
      for (const id of [...openSub.keys()]) closeSub(id, end);
      continue;
    }
    lastTs = e.ts;

    if (e.kind === "transient") {
      if (e.to !== null) {
        if (!openSub.has(e.id)) {
          countSub(e.id, e.name);
          // 今天以前就在場（from 非 null）的，時間從 since 起算
          openSub.set(e.id, { name: e.name, since: e.from === null ? e.ts : since });
        } else if (e.from === null) {
          // 重新進場：結清舊段、換新段，不重複計數
          closeSub(e.id, e.ts);
          openSub.set(e.id, { name: e.name, since: e.ts });
        }
      } else {
        if (!openSub.has(e.id)) {
          // 今天以前就進場的：離場前的時間從 since 起算，且算一位
          countSub(e.id, e.name);
          openSub.set(e.id, { name: e.name, since });
        }
        closeSub(e.id, e.ts);
      }
      continue;
    }

    let r = residents.get(e.id);
    if (!r) {
      r = {
        id: e.id,
        name: e.name,
        kind: e.kind,
        cwd: e.cwd,
        workingMs: 0,
        waitingMs: 0,
        firstSeen: e.from === null ? e.ts : since,
        lastSeen: e.ts,
      };
      if (e.from !== null) r.seg = { state: e.from, since };
      residents.set(e.id, r);
    }
    closeResident(r, e.ts);
    r.name = e.name;
    if (e.cwd) r.cwd = e.cwd;
    r.lastSeen = e.ts;
    if (e.to !== null) r.seg = { state: e.to, since: e.ts };
  }

  for (const r of residents.values()) {
    if (r.seg) r.lastSeen = now;
    closeResident(r, now);
  }
  for (const id of [...openSub.keys()]) closeSub(id, now);

  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
  for (const a of current) {
    if (!a.usage) continue;
    usage.inputTokens += a.usage.inputTokens;
    usage.outputTokens += a.usage.outputTokens;
    usage.cacheReadTokens += a.usage.cacheReadTokens;
    usage.cacheCreationTokens += a.usage.cacheCreationTokens;
    usage.costUsd += a.usage.costUsd ?? 0;
  }

  return {
    since,
    agents: [...residents.values()].map(({ seg: _seg, ...rest }) => rest),
    subagents: { count: subCount, totalMs: subTotal, byType },
    usage,
  };
}
