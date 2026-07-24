import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AgentTask } from "@shared/types.js";

export const TASKS_ROOT = join(homedir(), ".claude", "tasks");

/**
 * 資料源 2：~/.claude/tasks/<sessionId>/<n>.json
 *
 * 這不是獨立的 Collector —— 任務是 session 的屬性，不是自己會走路的 agent。
 * 由 claudeSessions 在組 AgentState 時呼叫。
 */
type TaskFile = {
  id?: string;
  subject?: string;
  status?: string;
  activeForm?: string;
};

/** 實測到的值域：completed / pending，另補 in_progress（TaskUpdate 會寫） */
const PROGRESS_BY_STATUS: Record<string, number> = {
  completed: 1,
  in_progress: 0.5,
  pending: 0,
};

/**
 * sessionId 會被當成路徑用，所以必須先確認它真的只是一個 UUID。
 *
 * 這個值來自 Claude Code 自己寫的檔案，不是使用者輸入 —— 但檔案可能損毀，
 * 而一旦它長得像 `../../something`，collector 就會跑出 ~/.claude/tasks
 * 去讀別人的檔案，再把內容經由 SSE 送進瀏覽器。白名單約束不能只靠來源可信。
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readTasks(sessionId: string): Promise<AgentTask[]> {
  if (!SESSION_ID_RE.test(sessionId)) return [];

  const dir = join(TASKS_ROOT, sessionId);
  // 格式檢查之外再驗一次解析後的實際路徑，避免哪天正則放寬時漏掉邊界
  if (!resolve(dir).startsWith(resolve(TASKS_ROOT) + sep)) return [];

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    // 這個 session 還沒建過任務
    return [];
  }

  const tasks = await Promise.all(
    files.map(async (f): Promise<AgentTask | null> => {
      try {
        const raw = JSON.parse(await readFile(join(dir, f), "utf8")) as TaskFile;
        if (!raw.id || !raw.subject) return null;
        return {
          id: raw.id,
          subject: raw.subject,
          status: raw.status ?? "unknown",
          // 未知狀態一律當 0 —— 進度條寧可保守，不要編造
          progress: PROGRESS_BY_STATUS[raw.status ?? ""] ?? 0,
          activeForm: raw.activeForm,
        };
      } catch {
        return null;
      }
    }),
  );

  return tasks
    .filter((t): t is AgentTask => t !== null)
    .sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
}

/**
 * 目前正在做的事，用來當 agent 的 detail（狀態列與泡泡台詞）。
 *
 * activeForm 是 agent 自己寫的現在進行式（「跑測試中」），語氣正好；
 * 沒有的話退回 subject。完全沒有進行中的任務就回 undefined ——
 * 由前端決定要不要墊 phrase bank，collector 不該編造狀態。
 */
export function activeDetail(tasks: AgentTask[]): string | undefined {
  const active = tasks.find((t) => t.status === "in_progress");
  return active ? active.activeForm ?? active.subject : undefined;
}
