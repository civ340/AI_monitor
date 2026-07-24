import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { AgentState } from "@shared/types";
import { bubbleText, cssVars } from "./agentStyle";

type Props = {
  agent: AgentState;
  /** 0–1，工位在地板上的水平位置；transient 沒有工位就自由遊走 */
  home: number;
  onClick: () => void;
};

const WANDER_MS = 3500;
const BUBBLE_SHOW_MS = 3400;
const BUBBLE_GAP_MS = 5200;

/**
 * 一個 agent 一隻角色。純 CSS 畫（天線＋頭＋身體），不需要圖片資產。
 * 這是整頁的 signature element，所以動畫預算全花在這裡。
 */
export default function Walker({ agent, home, onClick }: Props) {
  const [pos, setPos] = useState(home);
  const [tick, setTick] = useState(0);
  const [bubble, setBubble] = useState(false);

  const working = agent.state === "working";

  /**
   * 只有在工作的人才走來走去，而且只在自己工位附近晃 ——
   * 讓角色跨過整個房間的話，顏色跟工位就對不起來了，
   * 「這個顏色＝這個 agent」的線索會斷掉。
   */
  useEffect(() => {
    if (!working) {
      setPos(home);
      return;
    }
    const id = setInterval(
      () => {
        const drift = (Math.random() - 0.5) * 0.24;
        setPos(Math.min(0.94, Math.max(0.06, home + drift)));
      },
      WANDER_MS + Math.random() * 2500,
    );
    return () => clearInterval(id);
  }, [working, home]);

  // 泡泡輪流出現，錯開時間避免全部角色同時講話
  useEffect(() => {
    if (agent.state === "offline") return;
    let hide: ReturnType<typeof setTimeout>;
    const show = setInterval(
      () => {
        setTick((t) => t + 1);
        setBubble(true);
        hide = setTimeout(() => setBubble(false), BUBBLE_SHOW_MS);
      },
      BUBBLE_GAP_MS + Math.random() * 3000,
    );
    return () => {
      clearInterval(show);
      clearTimeout(hide);
    };
  }, [agent.state]);

  return (
    <motion.div
      className="walker"
      style={{ ...cssVars(agent), left: `${pos * 100}%` }}
      data-state={agent.state}
      data-kind={agent.kind}
      onClick={onClick}
      // 進場淡入、退場淡出 —— transient 來去頻繁，沒有這個會憑空閃現
      initial={{ opacity: 0, y: 16, scale: 0.8 }}
      animate={{ opacity: agent.state === "offline" ? 0.45 : 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.8 }}
      transition={{ left: { duration: 2.6, ease: "easeInOut" }, default: { duration: 0.45 } }}
    >
      <AnimatePresence>
        {bubble && (
          <motion.div
            className="bubble"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
          >
            {bubbleText(agent, tick)}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        className="body"
        animate={working ? { y: [0, -5, 0], rotate: [-3, 3, -3] } : { y: [0, -3, 0] }}
        transition={{ duration: working ? 0.5 : 2, repeat: Infinity, ease: "easeInOut" }}
      >
        <div className="antenna" />
        <div className="head">
          <i className="eye l" />
          <i className="eye r" />
          <i className="cheek l" />
          <i className="cheek r" />
        </div>
        <div className="torso" />
      </motion.div>
      <div className="drop-shadow" />
    </motion.div>
  );
}
