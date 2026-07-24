/**
 * 前後端唯一真相。collector 之後的每一層都只認識這裡的型別。
 * 任何 agent 的原始格式差異，都必須在 collector 內被吃掉。
 */

/** 常駐＝有固定工位的長命 agent；臨時＝被派出後很快結束的 subagent */
export type AgentKind = "resident" | "transient";

export type AgentRunState = "working" | "idle" | "offline";

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
