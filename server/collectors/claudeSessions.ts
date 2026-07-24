import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AgentState, Collector } from "@shared/types.js";
import { activeDetail, readTasks, TASKS_ROOT } from "./claudeTasks.js";
import { isAlive } from "./isAlive.js";

const SESSIONS_DIR = join(homedir(), ".claude", "sessions");

/** pid 還活著但這麼久沒更新，就當它下班了 */
const OFFLINE_AFTER_MS = 10 * 60_000;

/**
 * busy 狀態的保鮮期。超過就不再相信那個 busy ——
 * 忙碌中的 session 心跳遠比這頻繁，久未更新代表它其實已經死了，
 * 只是 PID 剛好被別人回收用掉，讓存活檢查誤判。
 */
const BUSY_TRUST_MS = 5 * 60_000;

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
  status?: string;
  updatedAt?: number;
};

/**
 * 資料源 1：每個執行中的 Claude Code session 一個 JSON 檔。
 * 這是常駐工位的心跳來源。
 */
export function claudeSessionsCollector(): Collector {
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;

  return {
    name: "claude",

    async start(emit) {
      const scan = async (): Promise<void> => {
        try {
          emit(await collect());
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
      watcher = chokidar.watch([SESSIONS_DIR, TASKS_ROOT], {
        ignoreInitial: true,
        depth: 1,
        // 檔案寫到一半就讀會拿到半截 JSON
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
      });
      watcher.on("add", schedule).on("change", schedule).on("unlink", schedule);
      watcher.on("error", (err) => console.error("[claude] watcher:", err));

      await scan();
    },

    async stop() {
      clearTimeout(timer);
      await watcher?.close();
    },
  };
}

async function collect(): Promise<AgentState[]> {
  let files: string[];
  try {
    files = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    // 目錄不存在＝沒裝 Claude Code 或還沒跑過，視為沒有 agent
    return [];
  }

  const agents = await Promise.all(files.map((f) => toAgent(join(SESSIONS_DIR, f))));
  return agents.filter((a): a is AgentState => a !== null);
}

async function toAgent(path: string): Promise<AgentState | null> {
  let raw: SessionFile;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as SessionFile;
  } catch {
    // 讀到寫入中的半截檔或已被刪除，跳過這一輪
    return null;
  }

  const { pid, sessionId } = raw;
  if (typeof pid !== "number" || typeof sessionId !== "string") return null;

  // session 檔不會在 process 被強制中止時清掉，殘留檔會變成畫面上的幽靈同事
  if (!isAlive(pid)) return null;

  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : 0;
  const tasks = await readTasks(sessionId);

  return {
    id: `claude:${sessionId.slice(0, 8)}`,
    kind: "resident",
    name: raw.name ?? "Claude Code",
    state: deriveState(raw.status, updatedAt),
    // 真的在做的事優先；沒有進行中的任務就留空，讓前端墊 phrase bank
    detail: activeDetail(tasks),
    cwd: raw.cwd,
    tasks,
    updatedAt,
  };
}

/**
 * 顯式的 status 優先，撐不住才退回時間推導 ——
 * 反過來用 mtime 猜會把正在長考的 agent 誤判成下班。
 *
 * 但 busy 不能無條件相信：Windows 會回收 PID，原本的 session 崩潰後
 * 同一個 PID 可能被別的程式佔用，isAlive 就會對殘留檔說謊。
 * 真正在忙的 session 會持續更新 updatedAt，所以久未更新的 busy 一律不採信。
 */
export function deriveState(status: string | undefined, updatedAt: number): AgentState["state"] {
  const age = Date.now() - updatedAt;
  if (status === "busy" && age < BUSY_TRUST_MS) return "working";
  return age > OFFLINE_AFTER_MS ? "offline" : "idle";
}

