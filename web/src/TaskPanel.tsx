import { useEffect, useState } from "react";
import { motion } from "motion/react";
import type { AgentState } from "@shared/types";
import { cssVars, displayName, subtitleOf } from "./agentStyle";
import { openTarget, type OpenTarget } from "./api";
import { contextRatio, fmtTokens, fmtUsd, projectName } from "./logic/format";

type Props = {
  agent: AgentState;
  /** 掛在這個 agent 底下的 transient，例如 Codex 派出去的 job */
  subAgents: AgentState[];
  onClose: () => void;
};

const STATE_LABEL: Record<AgentState["state"], string> = {
  working: "工作中",
  idle: "閒置",
  waiting: "等你回覆",
  error: "出錯了",
  offline: "已下班",
};

/**
 * 場景是鉤子，這裡才是監控的實質內容。
 * 可愛的那層永遠不能是唯一的資訊來源。
 */
export default function TaskPanel({ agent, subAgents, onClose }: Props) {
  // 開資料夾／VS Code 的結果訊息，顯示在面板內
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState<OpenTarget | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 換看另一個 agent 時，上一個的訊息不該留著
  useEffect(() => setNotice(null), [agent.id]);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const open = async (target: OpenTarget): Promise<void> => {
    setBusy(target);
    try {
      await openTarget(agent.id, target);
      setNotice({ ok: true, text: target === "folder" ? "已開啟資料夾" : "已用 VS Code 開啟" });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "開啟失敗" });
    } finally {
      setBusy(null);
    }
  };

  const u = agent.usage;
  const ratio = contextRatio(u);

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
          {agent.kind === "resident" ? "常駐" : "臨時"} · {STATE_LABEL[agent.state] ?? agent.state}
          {agent.stalled && " · 疑似卡住"}
          {subtitleOf(agent) && ` · ${subtitleOf(agent)}`}
          {agent.cwd && (
            <span className="cwd">
              {projectName(agent.cwd) && <b>{projectName(agent.cwd)}</b>} {agent.cwd}
            </span>
          )}
        </p>

        {agent.state === "waiting" && (
          <p className={`modal-flag flag-${agent.waitingReason === "permission" ? "perm" : "input"}`}>
            {agent.waitingReason === "permission"
              ? "需要你核准權限，才能繼續往下做"
              : "回完話了，在等你下一步"}
          </p>
        )}
        {agent.state === "error" && <p className="modal-flag flag-error">{agent.error || "發生錯誤"}</p>}
        {agent.stalled && agent.state !== "error" && (
          <p className="modal-flag flag-stalled">
            好像卡住了…
            {agent.lastActivityAt && `（最後動靜 ${new Date(agent.lastActivityAt).toLocaleTimeString()}）`}
          </p>
        )}

        {agent.detail && <p className="modal-detail">{agent.detail}</p>}

        {agent.cwd && (
          <div className="open-row">
            <button disabled={busy !== null} onClick={() => void open("folder")}>
              開資料夾
            </button>
            <button disabled={busy !== null} onClick={() => void open("editor")}>
              用 VS Code 開
            </button>
          </div>
        )}
        {notice && (
          <p className={`toast ${notice.ok ? "ok" : "bad"}`} role="status">
            {notice.text}
          </p>
        )}

        {u && (
          <div className="usage">
            <h3 className="sub-head">Token 用量</h3>
            {ratio !== undefined && (
              <div className="ctx">
                <div className="ctx-top">
                  <span>Context</span>
                  <span className={ratio > 0.8 ? "hot" : ""}>
                    {fmtTokens(u.contextTokens)} / {fmtTokens(u.contextLimit)} ({Math.round(ratio * 100)}%)
                  </span>
                </div>
                <div className="bar">
                  <span style={{ width: `${ratio * 100}%`, background: ratio > 0.8 ? "#e0564b" : undefined }} />
                </div>
              </div>
            )}
            <dl className="usage-grid">
              <dt>輸入</dt>
              <dd>{fmtTokens(u.inputTokens)}</dd>
              <dt>輸出</dt>
              <dd>{fmtTokens(u.outputTokens)}</dd>
              <dt>快取讀取</dt>
              <dd>{fmtTokens(u.cacheReadTokens)}</dd>
              <dt>快取寫入</dt>
              <dd>{fmtTokens(u.cacheCreationTokens)}</dd>
              <dt>估算成本</dt>
              <dd>
                {fmtUsd(u.costUsd)}
                {u.costUsd === undefined && <small>（Codex 不估價）</small>}
              </dd>
              {u.model && (
                <>
                  <dt>模型</dt>
                  <dd className="model">{u.model}</dd>
                </>
              )}
            </dl>
          </div>
        )}

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
