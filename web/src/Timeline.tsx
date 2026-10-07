import { useMemo } from "react";
import type { HistoryEvent, TodaySummary } from "@shared/types";
import { startOfToday, usePolled, type Polled } from "./usePolled";
import { axisTicks, buildTimelines, type Seg } from "./logic/timeline";
import { fmtDuration, projectName } from "./logic/format";

type Props = {
  summary: Polled<TodaySummary>;
  onClose: () => void;
};

const POLL_MS = 30_000;

const STATE_COLOR: Record<Seg["state"], string> = {
  working: "#4bb8a9",
  waiting: "#ffb020",
  idle: "#d8ccc2",
  error: "#e0564b",
};
const STATE_LABEL: Record<Seg["state"], string> = {
  working: "工作",
  waiting: "等回覆",
  idle: "閒置",
  error: "錯誤",
};

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 今日時間軸抽屜。只在開啟時掛載，所以 history 只有開著的時候才會每 30 秒輪詢；
 * summary 由 App 持續輪詢（白板也要用），這裡直接吃。
 */
export default function Timeline({ summary, onClose }: Props) {
  const history = usePolled<HistoryEvent[]>(
    () => `/api/history?since=${startOfToday()}`,
    POLL_MS,
  );

  const since = summary.data?.since ?? startOfToday();
  // data 每次輪詢都是新物件，now 也跟著那次更新走，不要在 render 時亂跳
  const now = useMemo(() => Date.now(), [history.data, summary.data]);
  const rows = useMemo(
    () => (history.data ? buildTimelines(history.data, since, now) : []),
    [history.data, since, now],
  );
  const ticks = useMemo(() => axisTicks(since, now), [since, now]);
  const span = Math.max(1, now - since);
  const pct = (ts: number): number => ((ts - since) / span) * 100;

  const agents = (summary.data?.agents ?? []).filter((a) => a.kind === "resident");
  const ranked = [...agents].sort((a, b) => b.workingMs - a.workingMs);
  const maxWork = Math.max(1, ...ranked.map((a) => a.workingMs));
  const sub = summary.data?.subagents;
  const types = sub ? Object.entries(sub.byType ?? {}).sort((a, b) => b[1].count - a[1].count) : [];

  return (
    <section className="drawer" aria-label="今日時間軸">
      <div className="drawer-head">
        <h2>今日時間軸</h2>
        <div className="legend">
          {(Object.keys(STATE_COLOR) as Seg["state"][]).map((k) => (
            <span key={k}>
              <i style={{ background: STATE_COLOR[k] }} />
              {STATE_LABEL[k]}
            </span>
          ))}
        </div>
        <button className="drawer-close" onClick={onClose} aria-label="關閉時間軸">
          ✕
        </button>
      </div>

      {history.failed && !history.data && <p className="drawer-msg">讀不到時間軸（後端沒有回應 /api/history）</p>}
      {history.loading && <p className="drawer-msg">讀取中…</p>}
      {history.failed && history.data && <p className="drawer-msg warn">更新失敗，顯示的是上一次的資料</p>}
      {history.data && rows.length === 0 && <p className="drawer-msg">今天還沒有常駐 agent 的紀錄</p>}

      {rows.length > 0 && (
        <div className="tl">
          <div className="tl-axis">
            {ticks.map((t) => (
              <span key={t} style={{ left: `${pct(t)}%` }}>
                {hhmm(t)}
              </span>
            ))}
          </div>
          {rows.map((r) => (
            <div className="tl-row" key={r.id}>
              <div className="tl-label" title={r.cwd ?? r.name}>
                <b>{projectName(r.cwd) || r.name}</b>
                <small>{r.name}</small>
              </div>
              <div className="tl-track">
                {ticks.map((t) => (
                  <i className="tl-grid" key={t} style={{ left: `${pct(t)}%` }} />
                ))}
                {r.segs.map((s) => (
                  <span
                    key={`${s.start}-${s.state}`}
                    className="tl-seg"
                    style={{
                      left: `${pct(s.start)}%`,
                      width: `${Math.max(0.2, pct(s.end) - pct(s.start))}%`,
                      background: STATE_COLOR[s.state],
                    }}
                    title={`${STATE_LABEL[s.state]} ${hhmm(s.start)}–${hhmm(s.end)}（${fmtDuration(s.end - s.start)}）`}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="drawer-cols">
        <div>
          <h3>今日工作時間排行</h3>
          {summary.failed && !summary.data && <p className="drawer-msg">讀不到今日統計</p>}
          {summary.data && ranked.length === 0 && <p className="drawer-msg">還沒有資料</p>}
          {ranked.map((a) => (
            <div className="rank" key={a.id}>
              <span className="rank-name" title={a.cwd ?? a.name}>
                {projectName(a.cwd) || a.name}
              </span>
              <span className="rank-bar">
                <span style={{ width: `${(a.workingMs / maxWork) * 100}%` }} />
              </span>
              <span className="rank-val">
                {fmtDuration(a.workingMs)}
                {a.waitingMs > 60_000 && <small> · 等 {fmtDuration(a.waitingMs)}</small>}
              </span>
            </div>
          ))}
        </div>
        <div>
          <h3>臨時同事（subagent）</h3>
          {summary.data && sub ? (
            <>
              <p className="sub-total">
                今天派出 <b>{sub.count}</b> 位，累計 {fmtDuration(sub.totalMs)}
              </p>
              <div className="chips">
                {types.length === 0 && <span className="drawer-msg">沒有</span>}
                {types.map(([name, v]) => (
                  <span className="chip" key={name} title={`累計 ${fmtDuration(v.totalMs)}`}>
                    {name} ×{v.count}
                  </span>
                ))}
              </div>
            </>
          ) : (
            summary.failed && <p className="drawer-msg">讀不到今日統計</p>
          )}
        </div>
      </div>
    </section>
  );
}
