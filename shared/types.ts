/**
 * 前後端唯一真相。collector 之後的每一層都只認識這裡的型別。
 * 任何 agent 的原始格式差異，都必須在 collector 內被吃掉。
 */

/** 常駐＝有固定工位的長命 agent；臨時＝被派出後很快結束的 subagent */
export type AgentKind = "resident" | "transient";

/**
 * working＝在做事；idle＝閒置；waiting＝停下來等使用者（見 AgentState.waitingReason）；
 * error＝失敗了（見 AgentState.error）；offline＝下班／已死。
 */
export type AgentRunState = "working" | "idle" | "waiting" | "error" | "offline";

/** waiting 的原因：permission＝等使用者核准權限；input＝Claude 回完話、等使用者下一步 */
export type WaitingReason = "permission" | "input";

/**
 * 一個 agent 目前累計的 token 用量。只有數字與模型名，絕不含任何對話文字。
 * 沒有 transcript／事件可讀的 agent 整個 usage 不填，不要塞 0。
 */
export type AgentUsage = {
  /** 最近一則 assistant 訊息用的模型名（原樣，可能帶日期後綴） */
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 最近一輪的 input + cacheRead + cacheCreation，代表目前 context 大小 */
  contextTokens?: number;
  /** 該模型的 context 上限（token）；模型不在價格表內時不填 */
  contextLimit?: number;
  /** 依 server/pricing.ts 的估算價格算出的美元成本；模型不明時不填（Codex 一律不填） */
  costUsd?: number;
};

export type AgentTask = {
  id: string;
  subject: string;
  /** 原始狀態字串，直接顯示在 pill 上（如 completed / in_progress / queued） */
  status: string;
  /** 0–1。無法得知時給 0，不要猜 */
  progress: number;
  /** 現在進行式的說法（「跑測試中」），agent 自己寫的，適合當狀態列與泡泡台詞 */
  activeForm?: string;
};

export type AgentState = {
  /** 全域唯一，格式 "<source>:<原始 id>"，例：claude:28c66620 */
  id: string;
  kind: AgentKind;
  /** transient 專用，指向所屬 resident 的 id */
  parent?: string;
  /** 顯示名，例：Claude Code / codex-rescue */
  name: string;
  state: AgentRunState;
  /** 一句話現況，來自 agent 自己的 log。空的時候前端才退回 phrase bank */
  detail?: string;
  /** 工作目錄，用來區分同時開多個專案的 session */
  cwd?: string;
  tasks: AgentTask[];
  /** epoch ms */
  updatedAt: number;
  /** state 為 waiting 時的原因 */
  waitingReason?: WaitingReason;
  /** state 為 error 時的一行摘要（≤160 字） */
  error?: string;
  /** 由 store 計算：working 但太久（STALL_MS）沒有真實活動。沒卡住時不帶這個欄位 */
  stalled?: boolean;
  /** epoch ms。collector 能得知的「最後真實活動時間」（transcript／log mtime 等），不知道就不填 */
  lastActivityAt?: number;
  usage?: AgentUsage;
  /**
   * epoch ms。進入目前 state 的時間，由 store 計算（collector 不用填）：
   * state 變了才更新，其餘重新回報都沿用；新進場為進場時間（idle 且 collector 有給 lastActivityAt 時用它，較貼近真實）。
   * 不參與 sameAgent 比對 —— 它只會跟著 state 一起變，不會單獨造成推播。
   */
  stateSince?: number;
};

/**
 * 歷史事件（GET /api/history）。只記 state 轉換，不記心跳。
 * from=null 是進場，to=null 是離場。
 * from 與 to 相同的事件是「快照」：本地跨日 00:00 時對當下所有 agent 各寫一筆，
 * 讓今天的視窗從 since 起就有每個 agent 的起始狀態（消費端把它當一般轉換處理即可，相鄰同狀態段落會合併）。
 */
export type HistoryEvent = {
  /** epoch ms */
  ts: number;
  id: string;
  name: string;
  kind: AgentKind;
  parent?: string;
  cwd?: string;
  from: AgentRunState | null;
  to: AgentRunState | null;
  /**
   * 只在 to === "error" 時有：錯誤摘要（≤120 字）。
   * 歷史檔刻意不存 detail（可能是使用者 prompt 開頭或 subagent 描述），避免內容文字落地。
   */
  error?: string;
  /**
   * 特殊標記事件。"server-start"＝monitor server 在這個時間點啟動（id 固定 "server"、from/to 皆 null）。
   * 消費端（今日摘要、前端時間軸）遇到標記時，要把所有「仍開著」的段落結束在
   * 「標記前最後一筆事件的 ts」（若有 lastAliveAt 則用它）——server 停機期間沒有人在記錄，那段時間不能算成工作時間
   * （正常關閉時 shutdown 會先替每個 agent 寫離場事件，這裡處理的是被強制結束、沒來得及寫的情況）。
   * 標記本身不是 agent，不要畫成列或計入統計。
   */
  marker?: "server-start";
  /**
   * 只在 marker 事件上有：上一輪 server 最後存活的時間（讀自 .data/heartbeat.json，每分鐘更新）。
   * 強制結束（Windows 上 kill／關主控台不會觸發 signal handler）沒有離場事件時，
   * 消費端把開著的段落結束在 lastAliveAt（不得超過標記 ts），而不是前一筆事件。沒有心跳檔就不帶。
   */
  lastAliveAt?: number;
};

/** 今日摘要（GET /api/summary/today） */
export type TodaySummary = {
  /** 統計起點：本地今天 00:00（epoch ms） */
  since: number;
  /** 常駐 agent 各自今天的工作／等待累積時間（進行中的段落算到現在） */
  agents: {
    id: string;
    name: string;
    kind: AgentKind;
    cwd?: string;
    workingMs: number;
    waitingMs: number;
    firstSeen: number;
    lastSeen: number;
  }[];
  /** 臨時人力（kind === "transient"）的進出場統計；byType 以 agent 的 name 分組 */
  subagents: {
    count: number;
    totalMs: number;
    byType: Record<string, { count: number; totalMs: number }>;
  };
  /** 目前 store 內各 agent usage 的加總。近似值：今天以前就啟動的 session 累計量也算進來 */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
  };
};

/** 首屏快照：GET /api/state */
export type StateSnapshot = {
  agents: AgentState[];
  /** 超出畫面容量、被收進角落的人數 */
  overflow: number;
  serverTime: number;
};

/** SSE 推播事件：GET /events */
export type StreamEvent =
  | { type: "snapshot"; agents: AgentState[]; overflow: number }
  | { type: "upsert"; agent: AgentState }
  | { type: "remove"; id: string };

/**
 * collector 契約。加新資料源 = 實作這個介面 + 在 collectors/index.ts 註冊一行。
 * server 與前端完全不需要改動。
 */
export type Collector = {
  /** 識別名，同時當作 AgentState.id 的前綴 */
  name: string;
  /** 啟動監看；有變動時呼叫 emit 交出該來源目前的完整 agent 清單 */
  start(emit: (agents: AgentState[]) => void): Promise<void> | void;
  stop(): Promise<void> | void;
};
