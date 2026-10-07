import type { AgentState } from "@shared/types";

export type AlertKind = "permission" | "input";

/**
 * 這次狀態變化要不要通知，要的話是哪一種。只在「轉換進入」waiting 時觸發一次：
 * - permission：一律通知（也包含 waiting(input) 升級成 waiting(permission)）
 * - input：只有之前是 working 才通知，避免閒置 session 一直吵；全新出現的 agent 也不吵
 * waitingReason 缺漏時當 input（較不吵的一邊）。
 */
export function alertFor(prev: AgentState | undefined, next: AgentState): AlertKind | null {
  if (next.state !== "waiting") return null;
  const reason: AlertKind = next.waitingReason === "permission" ? "permission" : "input";
  if (prev?.state === "waiting") {
    const prevReason: AlertKind = prev.waitingReason === "permission" ? "permission" : "input";
    return reason === "permission" && prevReason !== "permission" ? "permission" : null;
  }
  if (reason === "permission") return "permission";
  return prev?.state === "working" ? "input" : null;
}

/**
 * store 前後兩份狀態之間，該通知哪些 agent。
 * 沒 hydrated、或這次變動是「連線後第一份 snapshot」（silentSync 變了）時一律不通知：
 * 那是同步狀態，不是轉換 —— server 重啟時不能把 permission 通知再重發一遍。
 */
export function alertsForChange(
  prev: { hydrated: boolean; silentSync: number; agents: Record<string, AgentState> },
  next: { silentSync: number; agents: Record<string, AgentState> },
): { agent: AgentState; kind: AlertKind }[] {
  if (!prev.hydrated || next.agents === prev.agents || next.silentSync !== prev.silentSync) return [];
  const out: { agent: AgentState; kind: AlertKind }[] = [];
  for (const agent of Object.values(next.agents)) {
    const before = prev.agents[agent.id];
    if (before === agent) continue;
    const kind = alertFor(before, agent);
    if (kind) out.push({ agent, kind });
  }
  return out;
}

/** 等待中的人數（transient 也算，使用者要處理的是同一件事） */
export function waitingCount(agents: AgentState[]): number {
  let n = 0;
  for (const a of agents) if (a.state === "waiting") n++;
  return n;
}

/** 分頁不在前景且有人在等時，標題前面加「(N) 」 */
export function titleWithCount(base: string, count: number, hidden: boolean): string {
  return hidden && count > 0 ? `(${count}) ${base}` : base;
}
