import type { AgentState } from "@shared/types";
import { bubbleText, cssVars, displayName, subtitleOf } from "./agentStyle";

type Props = {
  agent: AgentState;
  onClick: () => void;
};

const STATE_LABEL: Record<AgentState["state"], string> = {
  working: "工作中",
  idle: "發呆中",
  offline: "下班了",
};

/**
 * 常駐 agent 的固定工位。狀態列顯示與泡泡相同的內容 ——
 * 泡泡會淡出，資訊不能跟著消失。
 */
export default function Station({ agent, onClick }: Props) {
  return (
    <div className="station" style={cssVars(agent)} onClick={onClick} data-state={agent.state}>
      <span className="badge">{displayName(agent)}</span>
      <div className="desk" />
      <p className="status">
        <span className="dot" />
        {STATE_LABEL[agent.state]}
        {agent.tasks.length > 0 && ` · ${agent.tasks.length} 項任務`}
      </p>
      {subtitleOf(agent) && <p className="session-id">{subtitleOf(agent)}</p>}
      <p className="detail">{agent.detail ? bubbleText(agent, 0) : "—"}</p>
    </div>
  );
}
