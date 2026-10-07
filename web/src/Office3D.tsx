import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentState, TodaySummary } from "@shared/types";
import { bubbleText, cssVars, displayName, subtitleOf, styleFor } from "./agentStyle";
import { useOfficeScene, type BoardRect, type TagAnchor } from "./office3d/useOfficeScene";
import type { BoardData, Mood, Occupant } from "./scene3d/office";
import { contextRatio } from "./logic/format";
import { daylightAt, hourOf } from "./logic/daylight";
import { layoutLabels, overlapRatio, rectOf, type LabelBox } from "./logic/labelLayout";
import { nextIdleSince, shouldLounge } from "./logic/lounge";

type Props = {
  agents: AgentState[];
  theme: string;
  onSelect: (id: string) => void;
  /** TaskPanel 開著的那個 agent，名牌會展開 */
  selectedId: string | null;
  /** 今日摘要，給白板用；null＝還沒讀到 */
  summary: TodaySummary | null;
  summaryFailed: boolean;
};

const STATE_LABEL: Record<AgentState["state"], string> = {
  working: "工作中",
  idle: "發呆中",
  waiting: "等你回覆",
  error: "出錯了",
  offline: "下班了",
};

/** 名牌上的狀態文字：waiting 要分是等核准還是等下一步，卡住也要講 */
function stateLabel(a: AgentState): string {
  if (a.state === "error") return "出錯了";
  if (a.state === "waiting") return a.waitingReason === "permission" ? "等你核准" : "等你回覆";
  if (a.stalled) return "好像卡住了";
  return STATE_LABEL[a.state];
}

function moodOf(a: AgentState): Mood {
  if (a.state === "error") return "error";
  if (a.state === "waiting") return a.waitingReason === "permission" ? "permission" : "input";
  if (a.stalled && a.state === "working") return "stalled";
  return "normal";
}

/** 只有 resident 會去茶水間；idle 滿 5 分鐘才算 */
function useLounging(agents: AgentState[]): Set<string> {
  const since = useRef(new Map<string, number>());
  // idle 的計時要隨時間前進，但沒有任何推播時 agents 不會變，所以自己敲一個 15 秒的鐘
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => window.clearInterval(t);
  }, []);
  return useMemo(() => {
    const now = Date.now();
    const out = new Set<string>();
    const seen = new Set<string>();
    for (const a of agents) {
      seen.add(a.id);
      const next = nextIdleSince(since.current.get(a.id), a.state, a.stateSince ?? a.lastActivityAt ?? a.updatedAt, now);
      if (next === undefined) since.current.delete(a.id);
      else since.current.set(a.id, next);
      if (a.kind === "resident" && shouldLounge(next, now)) out.add(a.id);
    }
    for (const id of since.current.keys()) if (!seen.has(id)) since.current.delete(id);
    return out;
    // tick 只是為了讓時間往前推
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, tick]);
}

/** 開發用：?hour=21 強制指定時間，方便看黃昏與夜晚的樣子 */
function hourOverride(): number | null {
  try {
    const v = new URLSearchParams(window.location.search).get("hour");
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** "#ff8a6b" → 0xff8a6b；three 要數字，config 存的是 CSS 色碼 */
function hexToInt(css: string): number {
  return parseInt(css.replace("#", ""), 16);
}

/**
 * 3D 辦公室。房間與角色都在 three.js 裡，名牌是疊在 canvas 上的 HTML ——
 * 文字用 3D 畫會糊掉，而且 displayName / bubbleText 那些規則已經寫好了，
 * 沒必要為了塞進材質再實作一次。
 */
export default function Office3D({ agents, theme, onSelect, selectedId, summary, summaryFailed }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tagRefs = useRef(new Map<string, HTMLDivElement>());

  const onPick = useCallback(
    (id: string | null) => {
      if (id) onSelect(id);
    },
    [onSelect],
  );

  /**
   * 量到的名牌尺寸。夾邊界要知道名牌多寬，但 offsetWidth 是強制同步 layout ——
   * 在寫過 transform 之後再讀，等於每個名牌每幀逼一次 reflow，
   * 而這頁是整天開著的（60fps × N 個名牌）。
   * 名牌尺寸只在文字變動時會變，但還有兩個不動文字的變因，所以一起算進 key：
   * 一是視窗窄到 640px 以下時 CSS 會收掉 .tag-detail / .tag-sub 兩行（斷點看的是
   * 視窗寬度不是畫布寬度，不過斷點兩邊畫布尺寸也一定不同，拿畫布尺寸當代理夠用）；
   * 二是網頁字體 display=swap 換上來會讓名牌尺寸變個幾 px。
   * 量過就快取，穩定狀態下一次都不用讀。
   */
  const tagSizes = useRef(new WeakMap<HTMLDivElement, { key: string; w: number; h: number }>());
  const fontsReady = useRef(false);

  useEffect(() => {
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) fontsReady.current = true;
    });
    return () => {
      alive = false;
    };
  }, []);

  // 哪個角色被滑鼠指著：角色本體（canvas 射線）或名牌本身。用 ref，不走 React state
  const canvasHover = useRef<string | null>(null);
  const tagHover = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;

  const onHover = useCallback((id: string | null) => {
    canvasHover.current = id;
  }, []);

  // 每幀直接改 DOM；走 React state 的話一秒會觸發 60 次 re-render
  const onAnchors = useCallback((anchors: TagAnchor[], w: number, h: number, board: BoardRect | null) => {
    const hovered = tagHover.current ?? canvasHover.current;
    const selected = selectedRef.current;

    // 1) 先決定每張名牌是精簡還是完整（只寫 attribute，不讀 layout）
    const modes: boolean[] = [];
    const prios: number[] = [];
    for (const a of anchors) {
      const el = tagRefs.current.get(a.id);
      if (!el) {
        modes.push(false);
        prios.push(0);
        continue;
      }
      const attention = el.dataset.mood !== "normal";
      const full = a.id === hovered || a.id === selected || attention;
      if ((el.dataset.full === "1") !== full) el.dataset.full = full ? "1" : "0";
      modes.push(full);
      prios.push(a.id === hovered ? 4 : a.id === selected ? 3 : attention ? 2 : 1);
    }

    // 2) 量尺寸（有快取；切換精簡/完整時才會重量），讀寫分開避免 layout thrash
    const boxes: LabelBox[] = [];
    const els: HTMLDivElement[] = [];
    anchors.forEach((a, i) => {
      const el = tagRefs.current.get(a.id);
      if (!el) return;
      const key = `${el.textContent ?? ""}|${w}x${h}|${fontsReady.current ? 1 : 0}|${modes[i] ? 1 : 0}`;
      let size = tagSizes.current.get(el);
      if (!size || size.key !== key) {
        size = { key, w: el.offsetWidth, h: el.offsetHeight };
        // 量到 0 表示這一幀還沒排版完，別把它記進快取（會一直沿用下去）
        if (size.w > 0) tagSizes.current.set(el, size);
      }
      els.push(el);
      boxes.push({ id: a.id, x: a.x, y: a.y, w: size.w, h: size.h, priority: prios[i]!, full: modes[i]!, avoid: prios[i]! < 3 });
    });

    // 3) 排開重疊後寫入
    const placed = layoutLabels(boxes, w, h, board ? [board] : []);
    placed.forEach((p, i) => {
      const el = els[i]!;
      const a = anchors.find((x) => x.id === p.id)!;
      const box = boxes[i]!;
      let opacity = a.visible && !p.hidden ? 1 : 0;
      // 排開之後還蓋在白板上的（例如上面已經沒空間）淡掉；被指著或選中的不淡
      if (opacity > 0 && board && box.priority < 3) {
        const r = overlapRatio(rectOf(p.x, p.y, box.w, box.h), board);
        if (r > 0) opacity = box.full ? 0.4 : 0.35;
      }
      el.style.opacity = String(opacity);
      el.style.zIndex = String(box.priority);
      el.style.transform = `translate(-50%, -100%) translate(${p.x}px, ${p.y}px)`;
    });
  }, []);

  const scene = useOfficeScene(canvasRef, { onPick, onAnchors, onHover });

  /**
   * 只在「誰在場、誰什麼狀態、什麼顏色」真的變了的時候才通知場景。
   * agents 陣列每次推播都是新物件，直接當相依會讓角色不停重建。
   */
  const lounging = useLounging(agents);
  const occupants = useMemo<Occupant[]>(
    () =>
      agents.map((a) => {
        const ratio = contextRatio(a.usage);
        return {
          id: a.id,
          accent: hexToInt(styleFor(a).accent),
          resident: a.kind === "resident",
          // waiting / error 沒有專屬的 activity，晃動交給 mood 決定
          activity: a.state === "waiting" || a.state === "error" ? "idle" : a.state,
          cwd: a.cwd,
          parent: a.parent,
          mood: moodOf(a),
          // 量化到 2%：usage 每則訊息都在變，不量化的話場景會一直被通知
          usage: ratio === undefined ? undefined : Math.round(ratio * 50) / 50,
          lounging: lounging.has(a.id),
        };
      }),
    [agents, lounging],
  );
  const signature = occupants
    .map(
      (o) =>
        `${o.id}:${o.activity}:${o.accent}:${o.cwd ?? ""}:${o.parent ?? ""}:${o.mood}:${o.usage ?? ""}:${o.lounging ? 1 : 0}`,
    )
    .join("|");

  useEffect(() => {
    scene.current?.setOccupants(occupants);
    // signature 才是真正的相依：內容一樣就不該重排場上的人
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    scene.current?.setTheme(theme);
  }, [theme, scene]);

  // 日夜循環：依真實本地時間，每分鐘重算一次；過渡是連續的所以不會突變
  useEffect(() => {
    const apply = (): void => {
      scene.current?.setDaylight(daylightAt(hourOverride() ?? hourOf(new Date())));
    };
    apply();
    const t = window.setInterval(apply, 60_000);
    return () => window.clearInterval(t);
  }, [scene]);

  // 白板：今日 token 與估算成本
  useEffect(() => {
    let data: BoardData;
    if (summary?.usage) {
      const u = summary.usage;
      data = {
        state: "ok",
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cacheRead: u.cacheReadTokens ?? 0,
        cacheCreation: u.cacheCreationTokens ?? 0,
        costUsd: u.costUsd ?? 0,
      };
    } else {
      data = { state: summaryFailed ? "error" : "loading" };
    }
    scene.current?.setBoard(data);
  }, [summary, summaryFailed, scene]);

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
            data-mood={moodOf(a)}
            style={cssVars(a)}
            ref={(el) => {
              if (el) tagRefs.current.set(a.id, el);
              else tagRefs.current.delete(a.id);
            }}
            data-full="0"
            onClick={() => onSelect(a.id)}
            onMouseEnter={() => {
              tagHover.current = a.id;
            }}
            onMouseLeave={() => {
              if (tagHover.current === a.id) tagHover.current = null;
            }}
          >
            <span className="tag-name">
              <i className="dot" />
              {displayName(a)}
            </span>
            <span className="tag-state">
              {stateLabel(a)}
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
