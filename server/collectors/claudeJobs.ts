import { open, readdir, readFile, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AgentState, Collector } from "@shared/types.js";

const JOBS_ROOT = join(homedir(), ".claude", "jobs");

/** 完成的 job 檔會永久留著，只顯示這段時間內有動靜的，否則畫面會塞滿幾週前的殭屍 */
const RECENT_MS = 30 * 60_000;

const DEBOUNCE_MS = 200;

/** 只讀 timeline 檔尾這麼多位元組。一筆 entry 遠小於此，夠撈到最後一行 */
const TAIL_BYTES = 16 * 1024;
/** 單行超過這個長度視為異常（正常 entry 的 text 再長也有限），直接放棄 */
const MAX_LINE_BYTES = 256 * 1024;
/** detail 是給狀態列看的一句話，截斷避免超長字串灌進前端 */
const MAX_DETAIL_CHARS = 200;

/** 實測值域：working / done / blocked */
export type JobState = {
  state?: string;
  detail?: string;
  name?: string;
  intent?: string;
  cwd?: string;
  sessionId?: string;
  inFlight?: { tasks?: number; queued?: number };
  updatedAt?: string;
};

/**
 * 資料源 3、4：~/.claude/jobs/<short>/{state.json, timeline.jsonl}
 * 背景 job 是被派出去的臨時同事 —— 一律 transient。
 */
export function claudeJobsCollector(): Collector {
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;

  return {
    name: "claude-jobs",

    async start(emit) {
      const scan = async (): Promise<void> => {
        try {
          emit(await collect());
        } catch (err) {
          console.error("[claude-jobs] 掃描失敗:", err);
        }
      };

      const schedule = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => void scan(), DEBOUNCE_MS);
      };

      watcher = chokidar.watch(JOBS_ROOT, {
        ignoreInitial: true,
        depth: 1,
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
      });
      watcher.on("add", schedule).on("change", schedule).on("unlink", schedule);
      watcher.on("error", (err) => console.error("[claude-jobs] watcher:", err));

      await scan();
    },

    async stop() {
      clearTimeout(timer);
      await watcher?.close();
    },
  };
}

async function collect(): Promise<AgentState[]> {
  let dirs: string[];
  try {
    dirs = await readdir(JOBS_ROOT);
  } catch {
    return [];
  }

  const agents = await Promise.all(dirs.map((d) => toAgent(join(JOBS_ROOT, d), d)));
  return agents.filter((a): a is AgentState => a !== null);
}

async function toAgent(dir: string, short: string): Promise<AgentState | null> {
  let raw: JobState;
  let updatedAt: number;
  try {
    const path = join(dir, "state.json");
    raw = JSON.parse(await readFile(path, "utf8")) as JobState;
    // state.json 的 updatedAt 是 ISO 字串，壞掉時退回檔案 mtime
    updatedAt = Date.parse(raw.updatedAt ?? "") || (await stat(path)).mtimeMs;
  } catch {
    return null;
  }

  const state = deriveState(raw.state);
  // 跑完很久的 job 不該還占著位子；還在跑的一律留著
  if (state !== "working" && Date.now() - updatedAt > RECENT_MS) return null;

  return {
    id: `job:${short}`,
    kind: "transient",
    name: raw.name ?? raw.intent?.slice(0, 24) ?? `job ${short}`,
    state,
    detail: await latestDetail(dir, raw.detail),
    cwd: raw.cwd,
    tasks: inFlightAsTasks(raw),
    updatedAt,
  };
}

export function deriveState(state: string | undefined): AgentState["state"] {
  switch (state) {
    case "working":
      return "working";
    case "blocked":
      // 卡住不是下班 —— 要看得見它還在等人
      return "idle";
    default:
      return "offline";
  }
}

/**
 * timeline.jsonl 最後一行的 detail 比 state.json 更即時。
 *
 * 安全關鍵：這個檔的 `text` 欄位是完整對話全文（實測有數千字），
 * 只取 detail，text 絕不能離開這個函式。
 *
 * 效能關鍵：這是 append-only 的檔，長時間的 job 會長到很大，
 * 而每個檔案事件都會呼叫一次。整包讀進來的話，光是配置記憶體就能拖垮服務，
 * 所以只讀檔尾固定長度 —— 我們要的永遠只有最後一筆。
 */
export async function latestDetail(dir: string, fallback: string | undefined): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(join(dir, "timeline.jsonl"), "r");
    const { size } = await handle.stat();
    if (size === 0) return fallback;

    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(Math.min(TAIL_BYTES, size));
    await handle.read(buf, 0, buf.length, start);

    // 從中間切進去時，第一行通常是半截的，直接丟掉
    const chunk = buf.toString("utf8");
    const lines = chunk.split("\n").filter((l) => l.trim() !== "");
    if (start > 0) lines.shift();

    const last = lines.at(-1);
    if (!last || last.length > MAX_LINE_BYTES) return fallback;

    const entry = JSON.parse(last) as { detail?: string };
    const detail = entry.detail;
    return typeof detail === "string" && detail ? detail.slice(0, MAX_DETAIL_CHARS) : fallback;
  } catch {
    return fallback;
  } finally {
    await handle?.close();
  }
}

/** inFlight 已經算好在飛/排隊的數量，直接用，不要自己重算 */
export function inFlightAsTasks(raw: JobState): AgentState["tasks"] {
  const running = raw.inFlight?.tasks ?? 0;
  const queued = raw.inFlight?.queued ?? 0;
  const out: AgentState["tasks"] = [];
  if (running > 0) out.push({ id: "inflight", subject: `${running} 項進行中`, status: "in_progress", progress: 0.5 });
  if (queued > 0) out.push({ id: "queued", subject: `${queued} 項排隊中`, status: "pending", progress: 0 });
  return out;
}
