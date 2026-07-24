import type { CSSProperties } from "react";
import config from "@config";
import type { AgentState } from "@shared/types";

type AgentStyle = {
  label: string;
  accent: string;
  tint: string;
  phrases: string[];
};

const AGENTS = config.agents as Record<string, AgentStyle>;

/**
 * id 前綴決定長相：claude:xxx → claude、codex:xxx → codex、job:xxx → default。
 * 同一個 agent 的徽章、角色輪廓、進度條共用同一組色，眼睛才能把顏色跟工具對起來。
 */
export function styleFor(agent: AgentState): AgentStyle {
  const prefix = agent.id.split(":")[0] ?? "";
  return AGENTS[prefix] ?? AGENTS.default!;
}

/**
 * 名牌顯示工具身分（Claude Code），不是 session 代號。
 *
 * agent.name 對 Claude Code 來說是它自己從專案目錄衍生的代號（如 ai-monitor-99），
 * 拿來當主標會讓人看不出這是哪個工具 —— 那個代號降級成副標，
 * 用途是區分你同時開的多個 session。
 */
export function displayName(agent: AgentState): string {
  if (agent.kind === "transient") return agent.name;
  return styleFor(agent).label;
}

/** 同一工具開多個 session 時，用來區分是哪一個；只有跟主標不同才值得顯示 */
export function subtitleOf(agent: AgentState): string | null {
  const label = styleFor(agent).label;
  return agent.name && agent.name !== label ? agent.name : null;
}

export function cssVars(agent: AgentState): CSSProperties {
  const s = styleFor(agent);
  return { "--ac": s.accent, "--tint": s.tint } as CSSProperties;
}

/**
 * 泡泡台詞：agent 自己回報的 detail 永遠優先，
 * phrase bank 只是沒有真實狀態時的墊檔 —— 別讓假台詞蓋掉真資訊。
 */
export function bubbleText(agent: AgentState, tick: number): string {
  if (agent.detail) return trim(agent.detail);
  const bank = styleFor(agent).phrases;
  return bank[tick % bank.length] ?? "…";
}

/** 狀態列塞不下長句，而且 detail 可能含大段工作內容 */
function trim(text: string, max = 42): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
