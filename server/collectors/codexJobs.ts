import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AgentState, Collector } from "@shared/types.js";
import { isAlive } from "./isAlive.js";
import { nextExpiryDelay } from "./retention.js";

const CODEX_ROOT = join(
  homedir(),
  ".claude",
  "plugins",
  "data",
  "codex-openai-codex",
  "state",
);

const RECENT_MS = 30 * 60_000;
const DEBOUNCE_MS = 200;

/** 失敗的 job 在畫面上多留這麼久，之後離場 */
export const ERROR_KEEP_MS = 60_000;
const MAX_ERROR_CHARS = 160;

/** 實測值域：status = running/completed/failed，phase = running/done/failed */
export type CodexJob = {
  id?: string;
  kind?: string;
  kindLabel?: string;
  title?: string;
  summary?: string;
  status?: string;
  phase?: string;
  pid?: number | null;
  workspaceRoot?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  /** 實測 failed 的 job 沒有專屬錯誤欄位；以下是防禦性讀取（有就用，沒有就用 summary/title） */
  errorMessage?: string;
  exitCode?: number | null;
};

type CodexState = { jobs?: CodexJob[] };

/**
 * 資料源 5、6：plugins/data/codex-openai-codex/state/<專案>-<hash>/state.json
 *
 * Codex 沒有常駐 process 檔可以讀，所以合成一個 resident 工位代表「Codex 這位同事」，
 * 個別 job 則是它派出去的臨時人力。沒有這個合成節點的話，Codex 在場景裡不會有固定座位。
 */
export function codexJobsCollector(root: string = CODEX_ROOT): Collector {
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  /** 保留期到期重掃：這個 collector 只靠檔案事件觸發，過期不會有新事件 */
  let expiryTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  return {
    name: "codex",

    async start(emit) {
      const scan = async (): Promise<void> => {
        clearTimeout(expiryTimer);
        try {
          const agents = await collect(root);
          if (stopped) return;
          emit(agents);
          const delay = nextExpiryDelay(agents, (a) =>
            a.kind !== "transient" || a.state === "working" ? undefined : a.state === "error" ? ERROR_KEEP_MS : RECENT_MS,
          );
          if (delay !== undefined) {
            expiryTimer = setTimeout(() => void scan(), delay);
            expiryTimer.unref?.();
          }
        } catch (err) {
          console.error("[codex] 掃描失敗:", err);
        }
      };

      const schedule = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => void scan(), DEBOUNCE_MS);
      };

      watcher = chokidar.watch(root, {
        ignoreInitial: true,
        depth: 1,
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
      });
      watcher.on("add", schedule).on("change", schedule).on("unlink", schedule);
      watcher.on("error", (err) => console.error("[codex] watcher:", err));

      await scan();
    },

    async stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(expiryTimer);
      await watcher?.close();
    },
  };
}

const CODEX_ID = "codex:main";

async function collect(root: string): Promise<AgentState[]> {
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    // 沒裝 codex plugin
    return [];
  }

  const perProject = await Promise.all(
    projects.map((p) => readProject(join(root, p, "state.json"), p)),
  );
  const jobs = perProject.flat();

  const running = jobs.filter((j) => j.state === "working");

  const codex: AgentState = {
    id: CODEX_ID,
    kind: "resident",
    name: "Codex",
    state: running.length > 0 ? "working" : "idle",
    detail: running[0]?.detail,
    tasks: [],
    updatedAt: Math.max(0, ...jobs.map((j) => j.updatedAt)),
    lastActivityAt: Math.max(0, ...jobs.map((j) => j.lastActivityAt ?? 0)) || undefined,
  };

  return [codex, ...jobs];
}

async function readProject(path: string, project: string): Promise<AgentState[]> {
  let raw: CodexState;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as CodexState;
  } catch {
    return [];
  }

  const out: AgentState[] = [];
  const jobs = raw !== null && typeof raw === "object" && Array.isArray(raw.jobs) ? raw.jobs : [];
  for (const job of jobs) {
    // 單一壞 job 不得拖垮整個來源
    try {
      const agent = toAgent(job, project);
      if (agent) out.push(agent);
    } catch (err) {
      console.warn("[codex] 略過壞掉的 job:", err);
    }
  }
  return out;
}

/**
 * job.id 只在自己的專案內唯一 —— 攤平多個專案後，同名 id 會在 store 的 Map 裡
 * 互相覆蓋，其中一個專案的狀態就此消失。所以 id 必須帶上專案目錄。
 */
export function toAgent(job: CodexJob, project: string): AgentState | null {
  if (job === null || typeof job !== "object" || typeof job.id !== "string" || !job.id) return null;

  const state = deriveState(job);
  const updatedAt =
    Date.parse(job.completedAt ?? job.updatedAt ?? job.startedAt ?? "") || 0;

  // 失敗的只留 60 秒（其他終態維持原本的 30 分鐘）
  const keep = state === "error" ? ERROR_KEEP_MS : RECENT_MS;
  if (state !== "working" && Date.now() - updatedAt > keep) return null;

  return {
    id: `codex:${project}/${job.id}`,
    kind: "transient",
    parent: CODEX_ID,
    name: strOr(job.kindLabel) ?? strOr(job.kind) ?? "codex job",
    state,
    // summary 是 Codex 自己寫的一句話結論，正好當狀態列
    detail: strOr(job.summary) ?? strOr(job.title),
    cwd: strOr(job.workspaceRoot),
    tasks: [],
    updatedAt,
    lastActivityAt: updatedAt || undefined,
    ...(state === "error" ? { error: errorSummary(job) } : {}),
  };
}

const strOr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function errorSummary(job: CodexJob): string {
  const text = strOr(job.errorMessage) ?? strOr(job.summary) ?? strOr(job.title) ?? (typeof job.exitCode === "number" ? `exit code ${job.exitCode}` : "failed");
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CHARS) || "failed";
}

/**
 * 關鍵：pid 是數字不代表它還活著。
 *
 * job 被強制中止時 state.json 沒機會寫回終態，會永遠停在 running
 * （實測有一筆 2026-07-10 的 job 至今仍宣稱 running、pid 23168）。
 * 所以宣稱在跑的，一律要向作業系統確認過才算數 —— 否則殭屍會卡住工位，
 * 而且因為 state 是 working 還會跳過時效過濾，永遠清不掉。
 */
export function deriveState(job: CodexJob): AgentState["state"] {
  const claimsRunning = job.status === "running" || job.phase === "running";
  if (claimsRunning) return isAlive(job.pid) ? "working" : "offline";
  if (job.status === "failed" || job.phase === "failed" || (typeof job.exitCode === "number" && job.exitCode !== 0)) {
    return "error";
  }
  return "offline";
}
