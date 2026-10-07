import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AgentState, Collector, WaitingReason } from "@shared/types.js";
import { activeDetail, readTasks, TASKS_ROOT } from "./claudeTasks.js";
import { isAlive } from "./isAlive.js";
import { defaultProcStartChecker, type ProcStartChecker } from "./procStart.js";
import { watchDataDir } from "./incrementalRead.js";
import {
  createSessionEventsReader,
  lastEventTs,
  SESSION_EVENTS_DIR,
  waitingFor,
  type SessionEventsState,
} from "./sessionEvents.js";
import { createTranscriptUsageReader } from "./claudeUsage.js";

const SESSIONS_DIR = join(homedir(), ".claude", "sessions");

/**
 * busy 狀態的保鮮期（看 max(updatedAt, lastActivityAt)）。超過就不再相信那個 busy ——
 * 久未有任何活動，代表它很可能已經死了，只是 PID 剛好被別人回收用掉，讓存活檢查誤判。
 *
 * 注意：session 檔的 updatedAt 只在 status 改變時更新，不是心跳（長工具執行中整段都不動），
 * 所以信任期要看 lastActivityAt（transcript / hook 事件），而且必須比 store 的 STALL_MS（10 分鐘）長，
 * 否則「busy 但很久沒動」永遠只會變 idle，stalled 永遠不會成立。
 */
export const BUSY_TRUST_MS = 60 * 60_000;

/** 檔案事件常常連續來好幾個，收斂成一次掃描 */
const DEBOUNCE_MS = 150;

/**
 * 原始檔的欄位（~/.claude/sessions/<pid>.json）。
 * 只宣告我們真的會用到的部分 —— 其餘欄位一律不讀、不外流。
 */
type SessionFile = {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  name?: string;
  kind?: string;
  /** Claude Code 自己寫的：busy / waiting / idle */
  status?: string;
  /** process 啟動時間（Windows FILETIME 字串），用來偵測 PID 回收。只拿來比對，不外流 */
  procStart?: string;
  /** Claude Code 自己寫的等待原因文字。只拿來判斷 waitingReason，不放進 AgentState、不外流 */
  waitingFor?: string;
  updatedAt?: number;
};

/**
 * 資料源 1：每個執行中的 Claude Code session 一個 JSON 檔。
 * 這是常駐工位的心跳來源。
 */
export function claudeSessionsCollector(): Collector {
  let watcher: FSWatcher | undefined;
  let dataWatcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  /** session 檔名 → sessionId。用來判斷 transcript 讀取狀態何時可以釋放（見 collectSessions） */
  const known = new Map<string, string>();
  // 增量讀取狀態屬於 collector 實例，不是模組層級（測試／重啟時不會互相污染）
  const eventsReader = createSessionEventsReader();
  // transcript 首次讀取（可能數十 MB）在背景進行；讀完 onPrimed 觸發一次重新掃描，把 usage 補進狀態。
  // schedule 在 start() 裡才有定義，所以這裡走間接參考。
  let rescan: () => void = () => {};
  const usageReader = createTranscriptUsageReader(undefined, { background: true, onPrimed: () => rescan() });

  return {
    name: "claude",

    async start(emit) {
      const scan = async (): Promise<void> => {
        try {
          await eventsReader.refresh();
          emit(await collectSessions(eventsReader.state, usageReader, known));
        } catch (err) {
          // 掃描失敗不該讓整個服務倒掉，下一次檔案事件會再試
          console.error("[claude] 掃描失敗:", err);
        }
      };

      const schedule = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => void scan(), DEBOUNCE_MS);
      };

      // tasks/ 也要監看，否則任務有進展時畫面不會更新（depth 1＝含 <sessionId>/ 底下那層）
      rescan = schedule;

      watcher = chokidar.watch([SESSIONS_DIR, TASKS_ROOT], {
        ignoreInitial: true,
        depth: 1,
        // 檔案寫到一半就讀會拿到半截 JSON
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
      });
      watcher.on("add", schedule).on("change", schedule).on("unlink", schedule);
      watcher.on("error", (err) => console.error("[claude] watcher:", err));

      // hook 事件檔（waiting 狀態來源）變動時也要重新 emit；.data 裡其他檔案的事件不理
      dataWatcher = await watchDataDir(SESSION_EVENTS_DIR, (p) => {
        if (p.endsWith("session-events.jsonl")) schedule();
      });

      await scan();
    },

    async stop() {
      rescan = () => {};
      clearTimeout(timer);
      await watcher?.close();
      await dataWatcher?.close();
    },
  };
}

type UsageReader = Pick<ReturnType<typeof createTranscriptUsageReader>, "read" | "release">;

/**
 * 掃描 sessions 目錄，回傳所有存活 session 的 AgentState。
 *
 * known（檔名 → sessionId）由呼叫端持有，用來決定何時釋放 transcript 增量讀取狀態：
 * 只在「確定 pid 死了」或「session 檔消失」時才釋放。session JSON 讀到寫入中的半截檔
 * 時看不出是誰，絕不能因此就把它的讀取狀態丟掉（會造成整份 transcript 被重讀）。
 */
export async function collectSessions(
  events: SessionEventsState,
  usageReader: UsageReader,
  known: Map<string, string>,
  dir: string = SESSIONS_DIR,
  procStarts: ProcStartChecker = defaultProcStartChecker,
): Promise<AgentState[]> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    // 目錄不存在＝沒裝 Claude Code 或還沒跑過，視為沒有 agent
  }

  const results = await Promise.all(
    files.map(async (f): Promise<{ f: string; r: SessionResult }> => {
      try {
        return { f, r: await toAgent(join(dir, f), events, usageReader, procStarts) };
      } catch (err) {
        // 單一壞檔不得拖垮整個來源
        console.warn(`[claude] 略過壞掉的 session 檔 ${f}:`, err);
        return { f, r: { agent: null } };
      }
    }),
  );

  const agents: AgentState[] = [];
  const alive = new Set<string>();
  const toRelease = new Set<string>();
  for (const { f, r } of results) {
    if (r.agent && r.sessionId) {
      agents.push(r.agent);
      alive.add(r.sessionId);
      known.set(f, r.sessionId);
    } else if (r.dead && r.sessionId) {
      toRelease.add(r.sessionId);
      known.delete(f);
    }
    // 其餘（讀到半截檔、欄位不對）：什麼都不動，保留既有的讀取狀態
  }
  const present = new Set(files);
  for (const [f, sid] of known) {
    if (!present.has(f)) {
      toRelease.add(sid);
      known.delete(f);
    }
  }
  for (const sid of alive) toRelease.delete(sid);
  if (toRelease.size > 0) usageReader.release(toRelease);
  return agents;
}

type SessionResult = {
  agent: AgentState | null;
  sessionId?: string;
  /** pid 確定已死 */
  dead?: boolean;
};

async function toAgent(
  path: string,
  events: SessionEventsState,
  usageReader: UsageReader,
  procStarts: ProcStartChecker,
): Promise<SessionResult> {
  let raw: SessionFile;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as SessionFile;
  } catch {
    // 讀到寫入中的半截檔或已被刪除，跳過這一輪
    return { agent: null };
  }

  if (raw === null || typeof raw !== "object") return { agent: null };
  const { pid, sessionId } = raw;
  if (typeof pid !== "number" || typeof sessionId !== "string") return { agent: null };

  // session 檔不會在 process 被強制中止時清掉，殘留檔會變成畫面上的幽靈同事。
  // 存活判定只看 pid；pid 活著就不因 updatedAt 舊而判 offline（updatedAt 不是心跳）。
  if (!isAlive(pid)) {
    procStarts.forget(pid);
    return { agent: null, sessionId, dead: true };
  }
  // PID 被別的 process 回收：isAlive 會說謊，procStart 對不上就是死了
  if (!(await procStarts.matches(pid, raw.procStart))) {
    procStarts.forget(pid);
    return { agent: null, sessionId, dead: true };
  }

  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : 0;
  const tasks = await readTasks(sessionId);
  const transcript = await usageReader.read(sessionId, typeof raw.cwd === "string" ? raw.cwd : undefined);
  // 真實活動 = 狀態檔更新、transcript 寫入、hook 事件中最新的一個
  const lastActivityAt = latestOf(updatedAt, transcript.mtimeMs, lastEventTs(events, sessionId));
  const state = deriveState(raw.status, updatedAt, lastActivityAt);

  const agent: AgentState = {
    id: `claude:${sessionId.slice(0, 8)}`,
    kind: "resident",
    name: typeof raw.name === "string" ? raw.name : "Claude Code",
    state,
    // 沒有 hook 事件可判斷原因時，看 session 檔的 waitingFor（含 input → input），其餘當 permission（停下來通常是等核准）
    ...(state === "waiting" ? { waitingReason: reasonFromWaitingFor(raw.waitingFor) } : {}),
    // 真的在做的事優先；沒有進行中的任務就留空，讓前端墊 phrase bank
    detail: activeDetail(tasks),
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    tasks,
    updatedAt,
    lastActivityAt,
    usage: transcript.usage,
  };
  // hook 事件（有原因）疊上去；核准後 status 變回 busy 時 waitingFor 會回 undefined（見 sessionEvents）
  return { agent: applyWaiting(agent, waitingFor(events, sessionId, { status: raw.status, updatedAt })), sessionId };
}

function reasonFromWaitingFor(text: unknown): WaitingReason {
  return typeof text === "string" && /input/i.test(text) ? "input" : "permission";
}

function latestOf(...ts: (number | undefined)[]): number | undefined {
  const m = Math.max(0, ...ts.filter((t): t is number => typeof t === "number"));
  return m > 0 ? m : undefined;
}

/**
 * 把 hook 得知的「等你回覆」疊到 collector 原本判斷的狀態上。
 * 已經 offline 的不標 waiting —— 死掉的 session 不會再回覆任何人。
 * 沒有 waiting 時原樣回傳（回到 collector 原本的狀態）。
 */
export function applyWaiting(agent: AgentState, reason: WaitingReason | undefined): AgentState {
  if (!reason || agent.state === "offline") return agent;
  return { ...agent, state: "waiting", waitingReason: reason };
}

/**
 * 有效 session 的完整 sessionId 集合（存活判定：session 檔存在 + pid 還活著）。
 *
 * 給 claudeSubagents 用來判斷「派出這個 subagent 的 session 是否還在」——
 * subagent 沒有自己的存活訊號，SubagentStop 沒送到時全靠這個戳破幽靈。
 * 刻意跟 toAgent() 分開寫：這裡只要 sessionId 這個布林問題，不用組整份 AgentState。
 */
export async function readAliveSessionIds(): Promise<Set<string>> {
  let files: string[];
  try {
    files = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return new Set();
  }

  const ids = await Promise.all(
    files.map(async (f): Promise<string | null> => {
      try {
        const raw = JSON.parse(await readFile(join(SESSIONS_DIR, f), "utf8")) as SessionFile;
        if (typeof raw.pid !== "number" || typeof raw.sessionId !== "string") return null;
        if (!isAlive(raw.pid)) return null;
        return (await defaultProcStartChecker.matches(raw.pid, raw.procStart)) ? raw.sessionId : null;
      } catch {
        return null;
      }
    }),
  );

  return new Set(ids.filter((id): id is string => id !== null));
}

/**
 * pid 已確認存活之後，直接採用 Claude Code 自己寫的 status：
 * busy → working、waiting → waiting、其餘（idle／未知）→ idle。
 * 這裡不會回 offline —— 存活與否由 pid 判斷（toAgent 在呼叫前已擋掉死掉的），
 * 不能用 updatedAt 的新舊猜（它只在 status 改變時更新，長時間 waiting／idle 都不會動）。
 *
 * 唯一的例外是 busy：Windows 會回收 PID，原本的 session 崩潰後同一個 PID 可能被別的程式佔用，
 * isAlive 就會對殘留檔說謊。所以 busy 要求 max(updatedAt, lastActivityAt) 在 BUSY_TRUST_MS 內，
 * 超過就不採信，當 idle。
 */
export function deriveState(
  status: string | undefined,
  updatedAt: number,
  lastActivityAt?: number,
  now: number = Date.now(),
): "working" | "waiting" | "idle" {
  if (status === "waiting") return "waiting";
  if (status === "busy") {
    const last = Math.max(updatedAt, lastActivityAt ?? 0);
    return now - last < BUSY_TRUST_MS ? "working" : "idle";
  }
  return "idle";
}

