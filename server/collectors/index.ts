import type { Collector } from "@shared/types.js";
import { store } from "../store.js";
import { claudeSessionsCollector } from "./claudeSessions.js";
import { claudeJobsCollector } from "./claudeJobs.js";
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
];

export async function startCollectors(): Promise<void> {
  for (const c of collectors) {
    await c.start((agents) => store.replaceSource(c.name, agents));
  }
  if (collectors.length === 0) {
    console.warn("[collectors] 尚未註冊任何資料源 —— 畫面會是空的辦公室");
  }
}

export async function stopCollectors(): Promise<void> {
  for (const c of collectors) await c.stop();
}
