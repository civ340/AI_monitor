import { useEffect } from "react";
import { motion } from "motion/react";
import type { AgentState } from "@shared/types";
import { cssVars, displayName, subtitleOf } from "./agentStyle";

type Props = {
  agent: AgentState;
  /** 掛在這個 agent 底下的 transient，例如 Codex 派出去的 job */
  subAgents: AgentState[];
  onClose: () => void;
};

/**
 * 場景是鉤子，這裡才是監控的實質內容。
 * 可愛的那層永遠不能是唯一的資訊來源。
 */
export default function TaskPanel({ agent, subAgents, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      className="overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className="modal"
        style={cssVars(agent)}
        initial={{ y: 24, scale: 0.96 }}
        animate={{ y: 0, scale: 1 }}
        exit={{ y: 16, scale: 0.97 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}
      >
        <h2>{displayName(agent)}</h2>
        <p className="modal-sub">
          {agent.kind === "resident" ? "常駐" : "臨時"} · {agent.state}
          {subtitleOf(agent) && ` · ${subtitleOf(agent)}`}
          {agent.cwd && <span className="cwd">{agent.cwd}</span>}
        </p>

        {agent.detail && <p className="modal-detail">{agent.detail}</p>}

        {agent.tasks.length === 0 && subAgents.length === 0 && (
          <p className="modal-empty">目前沒有進行中的任務</p>
        )}

        {agent.tasks.map((t) => (
          <div className="task" key={t.id}>
            <div className="task-top">
              <span className="task-name">{t.subject}</span>
              <span className={`pill ${t.progress === 0 ? "idle" : ""}`}>{t.status}</span>
            </div>
            <div className="bar">
              <motion.span
                initial={{ width: 0 }}
                animate={{ width: `${t.progress * 100}%` }}
                transition={{ duration: 0.5 }}
              />
            </div>
          </div>
        ))}

        {subAgents.length > 0 && (
          <>
            <h3 className="sub-head">派出中的同事</h3>
            {subAgents.map((c) => (
              <div className="task" key={c.id}>
                <div className="task-top">
                  <span className="task-name">{c.name}</span>
                  <span className={`pill ${c.state === "working" ? "" : "idle"}`}>{c.state}</span>
                </div>
                {c.detail && <p className="owner">{c.detail}</p>}
              </div>
            ))}
          </>
        )}

        <button className="close" onClick={onClose}>
          關閉
        </button>
      </motion.div>
    </motion.div>
  );
}
