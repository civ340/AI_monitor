import type { AgentState, StreamEvent } from "@shared/types.js";
import { appendHistory, diffHistory, HISTORY_FILE, serverStartEvent, shutdownHistory, snapshotHistory } from "./history.js";

/** 畫面容量：超過的 transient 不上場，只計入 overflow */
const MAX_TRANSIENT = 4;

/** working 但超過這麼久沒有真實活動 → stalled */
export const STALL_MS = 10 * 60_000;
/** 重新評估 stalled 的週期 */
export const STALL_CHECK_MS = 30_000;

type Listener = (ev: StreamEvent) => void;

export type StoreOptions = {
  /** 歷史事件 jsonl 路徑；null＝不記錄。預設 .data/history.jsonl */
  historyFile?: string | null;
};

/**
 * 記憶體狀態。不落地 —— 監控看的是當下，重啟從各 agent 的狀態檔重建即可。
 * 每個 collector 交出的是「該來源目前的完整清單」，store 負責跟上一輪 diff。
 */
export class Store {
  private historyFile: string | null;
  /** 上一輪（未裁切、未加 stalled）的全部 agent，歷史事件的 diff 基準 */
  private lastAll = new Map<string, AgentState>();
  /** recordShutdown() 之後不再寫歷史：離場事件已經落地，collector 停下來時的清空不是真的離場 */
  private closed = false;
  private stallTimer: NodeJS.Timeout | undefined;
  private midnightTimer: NodeJS.Timeout | undefined;
  private bySource = new Map<string, Map<string, AgentState>>();
  private listeners = new Set<Listener>();
  /** 上一次實際推給前端的上場名單，publish() 的 diff 基準 */
  private lastSent = new Map<string, AgentState>();
  private lastOverflow = 0;

  constructor(opts: StoreOptions = {}) {
    this.historyFile = opts.historyFile === undefined ? HISTORY_FILE : opts.historyFile;
  }

  /** 開始定期重算 stalled（時間流逝本身不會觸發 collector，所以要自己敲） */
  startStallTimer(intervalMs: number = STALL_CHECK_MS): void {
    this.stopStallTimer();
    this.stallTimer = setInterval(() => this.publish(), intervalMs);
    // 不要因為這個計時器擋住 process 結束
    this.stallTimer.unref?.();
  }

  stopStallTimer(): void {
    clearInterval(this.stallTimer);
    this.stallTimer = undefined;
  }

  /**
   * 本地跨日（00:00）時對當下所有 agent 各寫一筆快照事件（from === to === 當下 state）。
   * 這樣新的一天的歷史窗口從 since 起就有每個 agent 的起始狀態，
   * 不用靠「今天以前就在場」的推測（長時間不動的 agent 整天都沒有轉換事件）。
   * 可停止（stopMidnightTimer），計時基於 Date.now()，測試可用 fake timers。
   */
  startMidnightTimer(): void {
    this.stopMidnightTimer();
    // 用 setHours 取下一個本地午夜，DST 當天不是剛好 24 小時
    const d = new Date();
    d.setHours(24, 0, 0, 0);
    const at = d.getTime();
    this.midnightTimer = setTimeout(() => {
      // timer 可能早幾 ms 觸發；ts 不能早於午夜，否則會落在昨天的窗口
      const ts = Math.max(Date.now(), at);
      if (this.historyFile && !this.closed) appendHistory(this.historyFile, snapshotHistory(this.lastAll.values(), ts));
      this.startMidnightTimer();
    }, Math.max(0, at - Date.now()));
    this.midnightTimer.unref?.();
  }

  stopMidnightTimer(): void {
    clearTimeout(this.midnightTimer);
    this.midnightTimer = undefined;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(ev: StreamEvent): void {
    for (const fn of this.listeners) fn(ev);
  }

  /**
   * collector 回報該來源的完整清單。
   *
   * diff 一律以 visible() 的結果為基準，不是原始清單 —— 否則超出上限的 transient
   * 會經由 upsert 溜到前端，而 overflow 因為只在 snapshot 帶，會停在舊值。
   */
  replaceSource(source: string, agents: AgentState[]): void {
    const now = Date.now();
    this.bySource.set(source, new Map(agents.map((a) => [a.id, withStateSince(a, this.lastAll.get(a.id), now)])));
    this.recordHistory();
    this.publish();
  }

  /**
   * server 啟動時寫一筆 server-start 標記。消費端遇到標記，會把仍開著的段落
   * 結束在標記前最後一筆事件（處理上次非正常結束、沒來得及寫離場的情況）。
   */
  recordServerStart(ts: number = Date.now(), lastAliveAt?: number): void {
    if (this.historyFile) appendHistory(this.historyFile, [serverStartEvent(ts, lastAliveAt)]);
  }

  /**
   * shutdown（SIGINT/SIGTERM）時呼叫：同步替目前所有 agent 寫離場事件（to:null），
   * 確保在 process.exit 之前落地。之後 store 不再寫歷史。
   */
  recordShutdown(ts: number = Date.now()): void {
    if (this.closed) return;
    this.closed = true;
    if (this.historyFile) appendHistory(this.historyFile, shutdownHistory(this.lastAll.values(), ts));
  }

  /** 只記 state 轉換（進場／離場／變化），心跳與 detail 變動不記 */
  private recordHistory(): void {
    if (this.closed) return;
    const next = new Map(this.all().map((a) => [a.id, a]));
    if (this.historyFile) appendHistory(this.historyFile, diffHistory(this.lastAll, next, Date.now()));
    this.lastAll = next;
  }

  /** 把「目前該上場的人」與上一次推播的狀態比對，只推真正變動的部分 */
  private publish(): void {
    const { agents, overflow } = this.visible();
    const next = new Map(agents.map((a) => [a.id, a]));

    for (const [id, agent] of next) {
      const before = this.lastSent.get(id);
      if (!before || !sameAgent(before, agent)) this.emit({ type: "upsert", agent });
    }
    for (const id of this.lastSent.keys()) {
      if (!next.has(id)) this.emit({ type: "remove", id });
    }

    // overflow 沒有自己的事件型別，變動時補一份 snapshot 讓「還有 N 位在加班」跟上
    if (overflow !== this.lastOverflow) {
      this.emit({ type: "snapshot", agents, overflow });
      this.lastOverflow = overflow;
    }

    this.lastSent = next;
  }

  /** 全部 agent，resident 優先排前面 */
  all(): AgentState[] {
    const out: AgentState[] = [];
    for (const m of this.bySource.values()) out.push(...m.values());
    return out.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "resident" ? -1 : 1,
    );
  }

  /** 上場名單 + 溢出人數，避免房間被 subagent 塞爆 */
  visible(): { agents: AgentState[]; overflow: number } {
    const raw = this.all();
    const byId = new Map(raw.map((a) => [a.id, a]));
    const now = Date.now();
    const all = raw.map((a) => withStalled(a, byId, now));
    const residents = all.filter((a) => a.kind === "resident");
    const transients = all.filter((a) => a.kind === "transient");
    return {
      agents: [...residents, ...transients.slice(0, MAX_TRANSIENT)],
      overflow: Math.max(0, transients.length - MAX_TRANSIENT),
    };
  }
}

/**
 * 算 stateSince：跟上一輪同 state 就沿用，state 變了（或新進場）才重設。
 * 新進場且 idle、collector 有給 lastActivityAt 時用它當初值 —— server 剛啟動時，
 * 「閒置多久」比「server 看到它多久」準。（working 等狀態沒有這種對應，用 now。）
 */
function withStateSince(a: AgentState, prev: AgentState | undefined, now: number): AgentState {
  let since: number;
  if (prev && prev.state === a.state && prev.stateSince !== undefined) since = prev.stateSince;
  else if (!prev && a.state === "idle" && a.lastActivityAt !== undefined) since = Math.min(a.lastActivityAt, now);
  else since = now;
  return { ...a, stateSince: since };
}

/**
 * working 且最後真實活動距今超過 STALL_MS → 帶 stalled: true，否則不帶。
 * 臨時人力（例如 session 內 subagent）沒有自己的活動訊號，借 parent 的 lastActivityAt：
 * parent 還在動就代表它派出去的人沒被晾著。
 */
function withStalled(a: AgentState, byId: ReadonlyMap<string, AgentState>, now: number): AgentState {
  if (a.state !== "working") return a;
  const parentAt = a.parent ? byId.get(a.parent)?.lastActivityAt : undefined;
  const last = Math.max(a.lastActivityAt ?? a.updatedAt, parentAt ?? 0);
  return now - last > STALL_MS ? { ...a, stalled: true } : a;
}

/** updatedAt 之外的欄位有沒有實質變動 —— 只是心跳就不用推播 */
export function sameAgent(a: AgentState, b: AgentState): boolean {
  return (
    a.state === b.state &&
    a.waitingReason === b.waitingReason &&
    a.error === b.error &&
    a.stalled === b.stalled &&
    sameUsage(a.usage, b.usage) &&
    a.detail === b.detail &&
    a.name === b.name &&
    a.tasks.length === b.tasks.length &&
    a.tasks.every((t, i) => {
      const o = b.tasks[i];
      return o !== undefined && t.id === o.id && t.status === o.status && t.progress === o.progress;
    })
  );
}

function sameUsage(a: AgentState["usage"], b: AgentState["usage"]): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.model === b.model &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens
  );
}

export const store = new Store();
