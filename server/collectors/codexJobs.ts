import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AgentState, Collector } from "@shared/types.js";
import { isAlive } from "./isAlive.js";

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

/** 實測值域：status = running/completed/failed，phase = running/done/failed */
type CodexJob = {
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
};

type CodexState = { jobs?: CodexJob[] };

/**
 * 資料源 5、6：plugins/data/codex-openai-codex/state/<專案>-<hash>/state.json
 *
 * Codex 沒有常駐 process 檔可以讀，所以合成一個 resident 工位代表「Codex 這位同事」，
 * 個別 job 則是它派出去的臨時人力。沒有這個合成節點的話，Codex 在場景裡不會有固定座位。
 */
export function codexJobsCollector(): Collector {
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;

  return {
    name: "codex",

    async start(emit) {
      const scan = async (): Promise<void> => {
        try {
          emit(await collect());
        } catch (err) {
          console.error("[codex] 掃描失敗:", err);
        }
      };

      const schedule = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => void scan(), DEBOUNCE_MS);
      };

      watcher = chokidar.watch(CODEX_ROOT, {
        ignoreInitial: true,
        depth: 1,
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
      });
      watcher.on("add", schedule).on("change", schedule).on("unlink", schedule);
      watcher.on("error", (err) => console.error("[codex] watcher:", err));

      await scan();
    },

    async stop() {
      clearTimeout(timer);
      await watcher?.close();
    },
  };
}

const CODEX_ID = "codex:main";

async function collect(): Promise<AgentState[]> {
  let projects: string[];
  try {
    projects = await readdir(CODEX_ROOT);
  } catch {
    // 沒裝 codex plugin
    return [];
  }

  const perProject = await Promise.all(
    projects.map((p) => readProject(join(CODEX_ROOT, p, "state.json"), p)),
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
  for (const job of raw.jobs ?? []) {
    const agent = toAgent(job, project);
    if (agent) out.push(agent);
  }
  return out;
}

/**
 * job.id 只在自己的專案內唯一 —— 攤平多個專案後，同名 id 會在 store 的 Map 裡
 * 互相覆蓋，其中一個專案的狀態就此消失。所以 id 必須帶上專案目錄。
 */
function toAgent(job: CodexJob, project: string): AgentState | null {
  if (!job.id) return null;

  const state = deriveState(job);
  const updatedAt =
    Date.parse(job.completedAt ?? job.updatedAt ?? job.startedAt ?? "") || 0;

  if (state !== "working" && Date.now() - updatedAt > RECENT_MS) return null;

  return {
    id: `codex:${project}/${job.id}`,
    kind: "transient",
    parent: CODEX_ID,
    name: job.kindLabel ?? job.kind ?? "codex job",
    state,
    // summary 是 Codex 自己寫的一句話結論，正好當狀態列
    detail: job.summary ?? job.title,
    cwd: job.workspaceRoot,
    tasks: [],
    updatedAt,
  };
}

/**
 * 關鍵：pid 是數字不代表它還活著。
 *
 * job 被強制中止時 state.json 沒機會寫回終態，會永遠停在 running
 * （實測有一筆 2026-07-10 的 job 至今仍宣稱 running、pid 23168）。
 * 所以宣稱在跑的，一律要向作業系統確認過才算數 —— 否則殭屍會卡住工位，
 * 而且因為 state 是 working 還會跳過時效過濾，永遠清不掉。
 */
function deriveState(job: CodexJob): AgentState["state"] {
  const claimsRunning = job.status === "running" || job.phase === "running";
  if (claimsRunning) return isAlive(job.pid) ? "working" : "offline";
  if (job.status === "failed" || job.phase === "failed") return "idle";
  return "offline";
}
