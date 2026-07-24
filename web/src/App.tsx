import { useEffect, useMemo, useState } from "react";
import { AnimatePresence } from "motion/react";
import type { AgentState } from "@shared/types";
import { connectAgentStream, useAgentList, useAgentStore } from "./useAgentStream";
import Walker from "./Walker";
import Station from "./Station";
import TaskPanel from "./TaskPanel";

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

  useEffect(() => connectAgentStream(), []);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const residents = useMemo(() => agents.filter((a) => a.kind === "resident"), [agents]);
  const transients = useMemo(() => agents.filter((a) => a.kind === "transient"), [agents]);
  const open = agents.find((a) => a.id === openId) ?? null;
  const childrenOf = (id: string): AgentState[] => agents.filter((a) => a.parent === id);

  /**
   * 常駐站在自己的工位正上方；臨時的在各自群組裡均分，
   * 兩組分開算才不會擠成一團（用全體索引的話 Codex 母子會疊在一起）。
   */
  const homeOf = (agent: AgentState): number => {
    const group = agent.kind === "resident" ? residents : transients;
    const i = group.findIndex((g) => g.id === agent.id);
    if (group.length === 0) return 0.5;
    const slot = (i + 0.5) / group.length;
    // 臨時的往內縮一點，避免跟牆邊的裝飾打架
    return agent.kind === "resident" ? slot : 0.14 + slot * 0.72;
  };

  return (
    <main className="shell">
      <header>
        <div>
          <h1>AI Agent 辦公室</h1>
          <p className="sub">
            {agents.length > 0
              ? `${agents.length} 位同事在線上 · 點角色或桌子看細節`
              : "目前沒有偵測到 agent"}
          </p>
        </div>
        <div className="head-right">
          <span className={`conn conn--${connection}`}>
            {connection === "live" ? "已連線" : connection === "connecting" ? "連線中…" : "連線中斷"}
          </span>
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
        <div className="floor-grid" />
        <div className="window w1" />
        <div className="window w2" />
        <div className="plant">
          <span className="leaf l" />
          <span className="leaf c" />
          <span className="leaf r" />
          <span className="pot" />
        </div>

        <AnimatePresence>
          {agents.map((a) => (
            <Walker key={a.id} agent={a} home={homeOf(a)} onClick={() => setOpenId(a.id)} />
          ))}
        </AnimatePresence>

        <div className="stations">
          {residents.map((a) => (
            <Station key={a.id} agent={a} onClick={() => setOpenId(a.id)} />
          ))}
        </div>

        {agents.length === 0 && (
          <p className="empty">
            {connection === "live"
              ? "辦公室空無一人 —— 開一個 Claude Code 或跑個 Codex 任務就會有人進來"
              : "等待連線…"}
          </p>
        )}

        {overflow > 0 && <p className="overflow">還有 {overflow} 位在加班</p>}
      </div>

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
