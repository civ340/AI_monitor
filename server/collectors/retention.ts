import type { AgentState } from "@shared/types.js";

/** 到期時間之後多等一點再重掃，避免計時器早幾 ms 觸發時 job 還沒過期 */
export const RETENTION_BUFFER_MS = 1_000;
/** setTimeout 的上限（超過會被當成 1ms 立刻觸發） */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * 這批 agent 裡最早到期的保留期還有多久（含緩衝）；沒有任何會到期的回 undefined。
 * 只靠檔案事件觸發的 collector（claude-jobs、codex plugin）用它排一次「到期重掃」——
 * 不然過了保留期沒有新事件，已經過期的 error／終態 job 會一直賴在畫面上。
 *
 * keepMs 回傳該 agent 的保留時間；回 undefined 表示不會到期（例如還在跑的）。
 */
export function nextExpiryDelay(
  agents: readonly AgentState[],
  keepMs: (a: AgentState) => number | undefined,
  now: number = Date.now(),
): number | undefined {
  let best: number | undefined;
  for (const a of agents) {
    const keep = keepMs(a);
    if (keep === undefined) continue;
    const at = a.updatedAt + keep;
    // 已過期的不會出現在清單裡（collector 已濾掉），不排
    if (at <= now) continue;
    const delay = at - now + RETENTION_BUFFER_MS;
    if (best === undefined || delay < best) best = delay;
  }
  return best === undefined ? undefined : Math.min(best, MAX_TIMEOUT_MS);
}
