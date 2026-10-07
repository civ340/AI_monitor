import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import type { AgentState, TodaySummary } from "@shared/types";
import { connectAgentStream, useAgentList, useAgentStore } from "./useAgentStream";
import Office3D from "./Office3D";
import TaskPanel from "./TaskPanel";
import Timeline from "./Timeline";
import { useAlerts } from "./alerts";
import { usePolled } from "./usePolled";

const THEMES = [
  { id: "day", label: "☀️ 白天" },
  { id: "night", label: "🌙 夜班" },
  { id: "mint", label: "🌿 薄荷" },
] as const;

export default function App() {
  const agents = useAgentList();
  const connection = useAgentStore((s) => s.connection);
  const overflow = useAgentStore((s) => s.overflow);
  const [theme, setTheme] = useState<string>("day");
  const [openId, setOpenId] = useState<string | null>(null);
  const [showTimeline, setShowTimeline] = useState(false);
  const alerts = useAlerts(agents);
  // 今日摘要常駐輪詢：白板每天都要看，時間軸抽屜也吃同一份
  const summary = usePolled<TodaySummary>(() => "/api/summary/today", 30_000);

  useEffect(() => connectAgentStream(), []);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const open = agents.find((a) => a.id === openId) ?? null;
  const childrenOf = (id: string): AgentState[] => agents.filter((a) => a.parent === id);

  return (
    <main className="shell">
      <header>
        <div>
          <h1>AI Agent 辦公室</h1>
          <p className="sub">
            {agents.length > 0
              ? `${agents.length} 位同事在線上 · 點角色看細節 · 拖曳可以轉視角`
              : "目前沒有偵測到 agent"}
          </p>
        </div>
        <div className="head-right">
          <span className={`conn conn--${connection}`}>
            {connection === "live" ? "已連線" : connection === "connecting" ? "連線中…" : "連線中斷"}
          </span>
          <div className="themes tools">
            {alerts.supported && (
              <button
                onClick={alerts.toggleNotify}
                disabled={alerts.permission === "denied"}
                aria-pressed={alerts.permission === "granted" && alerts.notifyOn}
                title={
                  alerts.permission === "denied"
                    ? "瀏覽器已封鎖通知，請到網站設定開啟"
                    : "agent 等你回覆時跳出桌面通知"
                }
              >
                {alerts.permission === "denied"
                  ? "🔕 通知已封鎖"
                  : alerts.permission === "default"
                    ? "🔔 開啟通知"
                    : alerts.notifyOn
                      ? "🔔 通知開"
                      : "🔕 通知關"}
              </button>
            )}
            <button onClick={alerts.toggleSound} aria-pressed={alerts.soundOn} title="等你回覆時的提示音">
              {alerts.soundOn ? "🔊 提示音" : "🔇 靜音"}
            </button>
            <button onClick={() => setShowTimeline((v) => !v)} aria-pressed={showTimeline}>
              🕒 今日
            </button>
          </div>
          <div className="themes">
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                aria-pressed={theme === t.id}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="stage">
        <Office3D
          agents={agents}
          theme={theme}
          onSelect={setOpenId}
          selectedId={openId}
          summary={summary.data}
          summaryFailed={summary.failed}
        />

        {agents.length === 0 && (
          <p className="empty">
            {connection === "live"
              ? "辦公室空無一人 —— 開一個 Claude Code 或跑個 Codex 任務就會有人進來"
              : "等待連線…"}
          </p>
        )}

        {overflow > 0 && <p className="overflow">還有 {overflow} 位在加班</p>}
      </div>

      {showTimeline && <Timeline summary={summary} onClose={() => setShowTimeline(false)} />}

      <AnimatePresence>
        {open && (
          <TaskPanel
            agent={open}
            subAgents={childrenOf(open.id)}
            onClose={() => setOpenId(null)}
          />
        )}
      </AnimatePresence>
    </main>
  );
}
