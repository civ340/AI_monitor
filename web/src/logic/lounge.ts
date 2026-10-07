import type { AgentRunState } from "@shared/types";

/** idle 超過這麼久，resident 就走去茶水間 */
export const LOUNGE_AFTER_MS = 5 * 60_000;

/**
 * 更新「從什麼時候開始閒置」。不是 idle → 清掉；本來就在 idle 沿用舊值（心跳不重算）；
 * 剛變 idle → 以 baseTs（agent 自己回報的最後活動時間，沒有就是現在）起算。
 */
export function nextIdleSince(
  prev: number | undefined,
  state: AgentRunState,
  baseTs: number | undefined,
  now: number,
): number | undefined {
  if (state !== "idle") return undefined;
  if (prev !== undefined) return prev;
  return typeof baseTs === "number" && baseTs > 0 && baseTs <= now ? baseTs : now;
}

export function shouldLounge(
  idleSince: number | undefined,
  now: number,
  after = LOUNGE_AFTER_MS,
): boolean {
  return idleSince !== undefined && now - idleSince >= after;
}
