import { fileURLToPath } from "node:url";
import type { FSWatcher } from "chokidar";
import type { AgentState, Collector } from "@shared/types.js";
import { SESSION_ID_RE } from "./claudeTasks.js";
import { readAliveSessionIds } from "./claudeSessions.js";
import { createReadState, readAppendedLines, watchDataDir } from "./incrementalRead.js";

// 既有測試與外部引用走這裡；實作搬到 incrementalRead.ts
export { createReadState, readAppendedLines, watchDataDir, type ReadState } from "./incrementalRead.js";

const DATA_DIR = fileURLToPath(new URL("../../.data/", import.meta.url));
export const SUBAGENTS_FILE = DATA_DIR + "subagents.jsonl";

/** agent_id 實測長相如 "a59d06bce6659874f"，寬鬆但不放行路徑字元 */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_TYPE_CHARS = 64;
const MAX_DESC_CHARS = 80;
/** cwd / tool_use_id 等雜項字串欄位的保守上限 */
const MAX_STR_CHARS = 300;

/** spawn 之後這麼久還沒等到 start 就當它不會來了，丟掉避免記憶體無限長 */
const SPAWN_PAIR_WINDOW_MS = 10_000;
/** 候補清單的硬上限（正常情況下 10 秒窗 + 過濾就會清空，這只是防暴衝的保險） */
const MAX_PENDING = 200;
/** SubagentStop 沒送到（process 被強制中止）時的硬性下班線 */
const TTL_MS = 2 * 60 * 60_000;

const SWEEP_MS = 30_000;
/**
 * SubagentStop 不是「結束」，是「這一輪做完」：實測同一個背景 subagent 會連發十幾次 Stop，
 * 而被 SendMessage／背景任務重新喚醒時不會再發 SubagentStart。第一個 Stop 就讓它離場，
 * 還在做事的 agent 會從畫面上消失。所以 Stop 只把它轉成 idle，寬限期內沒有新的 Stop 才離場。
 */
export const STOP_GRACE_MS = 20_000;
const DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// 純邏輯：事件型別、reducer、輸出轉換。全部不碰 fs，方便單元測試直接餵事件。
// ---------------------------------------------------------------------------

type SpawnEvent = {
  ev: "spawn";
  ts: number;
  session_id: string;
  tool_use_id: string;
  subagent_type: string;
  description?: string;
};

type StartEvent = {
  ev: "start";
  ts: number;
  session_id: string;
  agent_id: string;
  agent_type: string;
  cwd?: string;
};

type StopEvent = {
  ev: "stop";
  ts: number;
  session_id: string;
  agent_id: string;
};

export type SubEvent = SpawnEvent | StartEvent | StopEvent;

type PendingSpawn = {
  ts: number;
  sessionId: string;
  subagentType: string;
  description?: string;
  /** 去重用：同一個 tool_use_id + ts 的 spawn 只收一次 */
  toolUseId: string;
  consumed: boolean;
};

type ActiveSubagent = {
  agentId: string;
  sessionId: string;
  agentType: string;
  cwd?: string;
  description?: string;
  startedAt: number;
  /** 最近一次 SubagentStop 的時間；有值＝idle，進入離場倒數 */
  stoppedAt?: number;
};

export type TrackerState = {
  pending: PendingSpawn[];
  active: Map<string, ActiveSubagent>;
};

export function createTrackerState(): TrackerState {
  return { pending: [], active: new Map() };
}

/**
 * 逐行解析原始 jsonl。壞掉的 JSON、不認得的欄位型別、長相不對的 id 一律回 null 跳過——
 * 這個檔案是我們自己的 hook 寫的，但仍要當成不可信輸入處理（防禦性解析，見專案慣例）。
 */
export function parseLine(line: string): SubEvent | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  // `null`、陣列、數字都是合法 JSON，但不是物件 —— 不擋下來，下一行讀 raw.ts 就會丟例外
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;

  if (typeof raw.ts !== "number" || !Number.isFinite(raw.ts)) return null;
  const sessionId = raw.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return null;

  switch (raw.ev) {
    case "spawn": {
      const toolUseId = raw.tool_use_id;
      const subagentType = raw.subagent_type;
      if (typeof toolUseId !== "string" || typeof subagentType !== "string") return null;
      const description = raw.description;
      return {
        ev: "spawn",
        ts: raw.ts,
        session_id: sessionId,
        tool_use_id: toolUseId.slice(0, MAX_STR_CHARS),
        subagent_type: subagentType.slice(0, MAX_TYPE_CHARS),
        description: typeof description === "string" ? description.slice(0, MAX_DESC_CHARS) : undefined,
      };
    }
    case "start": {
      const agentId = raw.agent_id;
      const agentType = raw.agent_type;
      if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) return null;
      if (typeof agentType !== "string") return null;
      const cwd = raw.cwd;
      return {
        ev: "start",
        ts: raw.ts,
        session_id: sessionId,
        agent_id: agentId,
        agent_type: agentType.slice(0, MAX_TYPE_CHARS),
        cwd: typeof cwd === "string" ? cwd.slice(0, MAX_STR_CHARS) : undefined,
      };
    }
    case "stop": {
      const agentId = raw.agent_id;
      if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) return null;
      return { ev: "stop", ts: raw.ts, session_id: sessionId, agent_id: agentId };
    }
    default:
      return null;
  }
}

/**
 * 把一筆事件套進 tracker 狀態。
 *
 * spawn 只是「等一下應該會有 start 跟上」的候補；start 到了才配對出 description——
 * PreToolUse 沒有 agent_id，SubagentStart 沒有 description，兩邊必須靠 session_id +
 * subagent_type/agent_type + 時間窗湊起來。
 */
export function applyEvent(state: TrackerState, ev: SubEvent): void {
  switch (ev.ev) {
    case "spawn":
      // 冪等：rotate／重讀造成的重放不能多出一筆候補（會把之後的 start 配到錯的描述）
      if (state.pending.some((p) => p.toolUseId === ev.tool_use_id && p.ts === ev.ts && p.sessionId === ev.session_id)) break;
      state.pending.push({
        toolUseId: ev.tool_use_id,
        ts: ev.ts,
        sessionId: ev.session_id,
        subagentType: ev.subagent_type,
        description: ev.description,
        consumed: false,
      });
      break;

    case "start": {
      // 冪等：同一個 agent_id 已經記過 ts 相同或更新的 start，這筆是 rotate／重讀的重放，不能重設（會讓已 stop 的復活）
      const existing = state.active.get(ev.agent_id);
      if (existing && existing.startedAt >= ev.ts) break;
      const match = findPendingMatch(state.pending, ev);
      if (match) match.consumed = true;

      state.active.set(ev.agent_id, {
        agentId: ev.agent_id,
        sessionId: ev.session_id,
        agentType: ev.agent_type,
        cwd: ev.cwd,
        description: match?.description,
        startedAt: ev.ts,
      });
      break;
    }

    case "stop": {
      // 沒 start 過的 id（Claude Code 內部的輔助 agent 會定期發）直接忽略，不憑空生出角色
      const a = state.active.get(ev.agent_id);
      // 每個 Stop 都重新起算倒數；事件可能亂序，只往後推不往前拉
      if (a) a.stoppedAt = Math.max(a.stoppedAt ?? 0, ev.ts);
      break;
    }
  }

  // 配對過或太舊的候補不用再留著；每種事件都清一次，不是只靠 start 觸發 ——
  // 一長串 spawn 從來沒等到 start（subagent 派送失敗之類）也不該無限長大。
  state.pending = prunePending(state.pending, ev.ts);
}

/** 同 session、同類型、10 秒窗內最近的未消耗候補 —— 找不到就回 undefined，不硬湊 */
function findPendingMatch(pending: PendingSpawn[], start: StartEvent): PendingSpawn | undefined {
  let best: PendingSpawn | undefined;
  for (const p of pending) {
    if (p.consumed) continue;
    if (p.sessionId !== start.session_id) continue;
    if (p.subagentType !== start.agent_type) continue;
    const age = start.ts - p.ts;
    if (age < 0 || age > SPAWN_PAIR_WINDOW_MS) continue;
    if (!best || p.ts > best.ts) best = p;
  }
  return best;
}

/** 丟掉已消耗、超過配對窗口的候補；剩下的再砍到硬上限，雙重保險避免記憶體無限長 */
function prunePending(pending: PendingSpawn[], now: number): PendingSpawn[] {
  const fresh = pending.filter((p) => !p.consumed && now - p.ts <= SPAWN_PAIR_WINDOW_MS);
  return fresh.length > MAX_PENDING ? fresh.slice(fresh.length - MAX_PENDING) : fresh;
}

/** 下一個寬限期到期的時間（epoch ms）；沒有人在倒數就回 undefined */
export function nextGraceExpiry(state: TrackerState): number | undefined {
  let next: number | undefined;
  for (const a of state.active.values()) {
    if (a.stoppedAt === undefined) continue;
    const at = a.stoppedAt + STOP_GRACE_MS;
    if (next === undefined || at < next) next = at;
  }
  return next;
}

/**
 * 幽靈同事清除：(a) 派出它的 session 已經死了（SubagentStop 沒送到就是常態——process
 * 被強制中止時來不及打）；(b) 硬性 TTL，防真的什麼都沒收到時永遠占位。
 * 回傳是否真的動到東西，讓呼叫端決定要不要因此多推一次。
 */
export function pruneDead(state: TrackerState, now: number, liveSessionIds: ReadonlySet<string>): boolean {
  let changed = false;
  for (const [id, a] of state.active) {
    const graceOver = a.stoppedAt !== undefined && now - a.stoppedAt > STOP_GRACE_MS;
    // TTL 看最後一次動靜而不是出生時間 —— 被反覆喚醒的長命背景 agent 不該因為活太久被踢掉
    const lastSeen = Math.max(a.startedAt, a.stoppedAt ?? 0);
    if (graceOver || !liveSessionIds.has(a.sessionId) || now - lastSeen > TTL_MS) {
      state.active.delete(id);
      changed = true;
    }
  }
  return changed;
}

export function toAgentStates(state: TrackerState): AgentState[] {
  return [...state.active.values()].map((a) => ({
    id: `claude-sub:${a.agentId}`,
    kind: "transient",
    parent: `claude:${a.sessionId.slice(0, 8)}`,
    name: a.agentType,
    state: a.stoppedAt === undefined ? "working" : "idle",
    detail: a.description,
    cwd: a.cwd,
    tasks: [],
    updatedAt: a.stoppedAt ?? a.startedAt,
  }));
}

// ---------------------------------------------------------------------------
// 薄的 fs 層：增量讀取 + watch + 定期 sweep。
// ---------------------------------------------------------------------------

/**
 * 資料源 8：Claude Code session 內的 subagent（Agent/Task tool 派出的），
 * 來自 .claude/settings.local.json 註冊的 SubagentStart/SubagentStop/PreToolUse hook。
 *
 * 這些 subagent 跑在 parent session 的 process 內、不會自己寫狀態檔，
 * 所以跟其他 collector 不同：資料來源是我們自己寫的 hooks/record.mjs 產出的事件流，
 * 不是各 agent 自己維護的狀態檔。
 */
export function claudeSubagentsCollector(): Collector {
  let watcher: FSWatcher | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let sweepTimer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  const rs = createReadState();
  const state = createTrackerState();

  let stopped = false;
  let reading = false;
  let rerunRequested = false;

  return {
    name: "claude-sub",

    async start(emit) {
      const doEmit = (): void => {
        // stop() 之後 fs 的 callback 仍可能觸發到這裡，不該再往外推狀態
        if (!stopped) emit(toAgentStates(state));
      };

      const readOnce = async (): Promise<void> => {
        try {
          const lines = await readAppendedLines(SUBAGENTS_FILE, rs);
          // 逐行隔離：offset 已經越過這批，一行出錯若中斷整批，後面的事件就永遠讀不回來
          for (const line of lines) {
            try {
              const ev = parseLine(line);
              if (ev) applyEvent(state, ev);
            } catch (err) {
              console.error("[claude-sub] 略過無法處理的事件行:", err);
            }
          }
        } catch (err) {
          console.error("[claude-sub] 讀取事件檔失敗:", err);
        }
        const live = await readAliveSessionIds();
        pruneDead(state, Date.now(), live);
      };

      /**
       * 讀取＋prune 一定循序執行，不能重疊。
       * chokidar 的 add/change 常常連續來好幾個，加上 sweep timer 也會呼叫同一支函式，
       * 同時併發讀同一份 rs（offset/carry）會互相踩到、讀出重複或錯位的內容。
       * 讀到一半又被叫起時不會插隊，而是記一筆「等這輪讀完再多讀一次」。
       */
      const onFileChange = async (): Promise<void> => {
        if (stopped) return;
        if (reading) {
          rerunRequested = true;
          return;
        }
        reading = true;
        try {
          do {
            rerunRequested = false;
            await readOnce();
          } while (rerunRequested && !stopped);
        } finally {
          reading = false;
        }
        doEmit();
        armGraceTimer();
      };

      /**
       * 寬限期到了要準時離場，不能等 30 秒的 sweep —— 否則 idle 會多掛最多半分鐘。
       * 只排最近的那一個；到期時跑一輪 onFileChange，prune 完會再排下一個。
       */
      const armGraceTimer = (): void => {
        clearTimeout(graceTimer);
        if (stopped) return;
        const at = nextGraceExpiry(state);
        if (at === undefined) return;
        // +50ms 讓 pruneDead 的「> STOP_GRACE_MS」一定成立
        graceTimer = setTimeout(() => void onFileChange(), Math.max(0, at - Date.now()) + 50);
      };

      const schedule = (): void => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => void onFileChange(), DEBOUNCE_MS);
      };

      watcher = await watchDataDir(DATA_DIR, schedule);

      // 啟動時把目前檔案內容整份讀一輪（對 readAppendedLines 來說就是從 offset 0 讀到底）
      await onFileChange();

      // 定期 sweep：除了清幽靈，也順便重跑一次讀取路徑 —— watcher 漏事件時還有這條保險線，
      // 不然目錄真的什麼都沒發生（例如 .data 是在 server 啟動前才被別的程式建立又清空）時
      // 就再也沒人去讀這個檔案了。
      sweepTimer = setInterval(() => void onFileChange(), SWEEP_MS);
    },

    async stop() {
      stopped = true;
      clearTimeout(debounceTimer);
      clearInterval(sweepTimer);
      clearTimeout(graceTimer);
      await watcher?.close();
    },
  };
}
