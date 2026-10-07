import type { AgentState, Collector } from "@shared/types.js";
import { store } from "../store.js";
import { claudeSessionsCollector } from "./claudeSessions.js";
import { claudeJobsCollector } from "./claudeJobs.js";
import { claudeSubagentsCollector } from "./claudeSubagents.js";
import { codexJobsCollector } from "./codexJobs.js";
import { codexCliCollector } from "./codexCli.js";

/**
 * collector 註冊表 —— 加新的 agent 資料源時，唯一需要改的檔案。
 * server、store、前端都只認識 AgentState，不會受影響。
 *
 * 註：資料源 2（~/.claude/tasks/）不在這裡 —— 任務是 session 的屬性而非獨立 agent，
 * 由 claudeSessions 呼叫 claudeTasks.readTasks() 併入。
 */
const collectors: Collector[] = [
  claudeSessionsCollector(), // 資料源 1 + 2
  claudeJobsCollector(), // 資料源 3 + 4
  codexJobsCollector(), // 資料源 5 + 6（Claude Code 的 codex plugin）
  codexCliCollector(), // 資料源 7（原生 codex CLI，~/.codex/）
  claudeSubagentsCollector(), // 資料源 8（session 內 subagent，來自 Claude Code hooks）
];

/**
 * 並行啟動：單一 collector start 拋錯只 log、卡住也不影響其他 collector 啟動。
 * 注意：有 collector 卡住時，這個 promise 不會 resolve（由 ready gate 的逾時放行服務）。
 */
export async function startCollectorList(list: Collector[], onAgents: (name: string, agents: AgentState[]) => void): Promise<void> {
  await Promise.allSettled(
    list.map(async (c) => {
      try {
        await c.start((agents) => onAgents(c.name, agents));
      } catch (err) {
        console.error(`[collectors] ${c.name} 啟動失敗:`, err);
      }
    }),
  );
}

export async function startCollectors(): Promise<void> {
  await startCollectorList(collectors, (name, agents) => store.replaceSource(name, agents));
  if (collectors.length === 0) {
    console.warn("[collectors] 尚未註冊任何資料源 —— 畫面會是空的辦公室");
  }
}

export async function stopCollectors(): Promise<void> {
  for (const c of collectors) await c.stop();
}
