import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AgentState } from "@shared/types";
import { bubbleText, cssVars, displayName, subtitleOf, styleFor } from "./agentStyle";
import { useOfficeScene, type TagAnchor } from "./office3d/useOfficeScene";
import type { Occupant } from "./scene3d/office";

type Props = {
  agents: AgentState[];
  theme: string;
  onSelect: (id: string) => void;
};

const STATE_LABEL: Record<AgentState["state"], string> = {
  working: "工作中",
  idle: "發呆中",
  offline: "下班了",
};

/** "#ff8a6b" → 0xff8a6b；three 要數字，config 存的是 CSS 色碼 */
function hexToInt(css: string): number {
  return parseInt(css.replace("#", ""), 16);
}

/**
 * 3D 辦公室。房間與角色都在 three.js 裡，名牌是疊在 canvas 上的 HTML ——
 * 文字用 3D 畫會糊掉，而且 displayName / bubbleText 那些規則已經寫好了，
 * 沒必要為了塞進材質再實作一次。
 */
export default function Office3D({ agents, theme, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tagRefs = useRef(new Map<string, HTMLDivElement>());

  const onPick = useCallback(
    (id: string | null) => {
      if (id) onSelect(id);
    },
    [onSelect],
  );

  // 每幀直接改 DOM 的 transform；走 React state 的話一秒會觸發 60 次 re-render
  const onAnchors = useCallback((anchors: TagAnchor[], w: number, h: number) => {
    for (const a of anchors) {
      const el = tagRefs.current.get(a.id);
      if (!el) continue;
      el.style.opacity = a.visible ? "1" : "0";
      // 邊緣的人名牌會被畫布切掉，夾回範圍內；上緣同理
      const half = el.offsetWidth / 2;
      const x = Math.min(Math.max(a.x, half + 4), w - half - 4);
      const y = Math.min(Math.max(a.y, el.offsetHeight + 4), h - 4);
      el.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
    }
  }, []);

  const scene = useOfficeScene(canvasRef, { onPick, onAnchors });

  /**
   * 只在「誰在場、誰什麼狀態、什麼顏色」真的變了的時候才通知場景。
   * agents 陣列每次推播都是新物件，直接當相依會讓角色不停重建。
   */
  const occupants = useMemo<Occupant[]>(
    () =>
      agents.map((a) => ({
        id: a.id,
        accent: hexToInt(styleFor(a).accent),
        resident: a.kind === "resident",
        activity: a.state,
      })),
    [agents],
  );
  const signature = occupants.map((o) => `${o.id}:${o.activity}:${o.accent}`).join("|");

  useEffect(() => {
    scene.current?.setOccupants(occupants);
    // signature 才是真正的相依：內容一樣就不該重排場上的人
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    scene.current?.setTheme(theme);
  }, [theme, scene]);

  return (
    <div className="office3d">
      <canvas ref={canvasRef} />
      <div className="tags">
        {agents.map((a) => (
          <div
            key={a.id}
            className="tag"
            data-state={a.state}
            data-kind={a.kind}
            style={cssVars(a)}
            ref={(el) => {
              if (el) tagRefs.current.set(a.id, el);
              else tagRefs.current.delete(a.id);
            }}
            onClick={() => onSelect(a.id)}
          >
            <span className="tag-name">{displayName(a)}</span>
            <span className="tag-state">
              <i className="dot" />
              {STATE_LABEL[a.state]}
              {a.tasks.length > 0 && ` · ${a.tasks.length} 項`}
            </span>
            {subtitleOf(a) && <span className="tag-sub">{subtitleOf(a)}</span>}
            {a.state !== "offline" && <span className="tag-detail">{bubbleText(a, 0)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
