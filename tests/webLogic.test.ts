import { describe, it, expect } from "vitest";
import type { AgentState, HistoryEvent } from "@shared/types";
import { contextRatio, fmtDuration, fmtTokens, fmtUsd, projectName } from "../web/src/logic/format";
import { axisTicks, buildTimelines } from "../web/src/logic/timeline";
import { alertFor, titleWithCount, waitingCount } from "../web/src/logic/notify";
import { cwdKey, layoutDesks } from "../web/src/logic/deskLayout";
import { daylightAt, lerpColor, phaseOf } from "../web/src/logic/daylight";
import { nextIdleSince, shouldLounge } from "../web/src/logic/lounge";

function agent(p: Partial<AgentState>): AgentState {
  return { id: "claude:a", kind: "resident", name: "n", state: "idle", tasks: [], updatedAt: 0, ...p };
}

describe("數字格式化", () => {
  it("token 縮寫", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1234)).toBe("1.2K");
    expect(fmtTokens(1_234_567)).toBe("1.2M");
    expect(fmtTokens(99_990)).toBe("100K");
    expect(fmtTokens(undefined)).toBe("0");
    expect(fmtTokens(NaN)).toBe("0");
  });
  it("美元", () => {
    expect(fmtUsd(12.3456)).toBe("$12.35");
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(0.004)).toBe("<$0.01");
    expect(fmtUsd(undefined)).toBe("—");
  });
  it("時長", () => {
    expect(fmtDuration(0)).toBe("0 分");
    expect(fmtDuration(30_000)).toBe("<1 分");
    expect(fmtDuration(7 * 60_000)).toBe("7 分");
    expect(fmtDuration(125 * 60_000)).toBe("2 小時 5 分");
  });
  it("專案資料夾名只取最後一段", () => {
    expect(projectName("C:\\lab\\AI_monitor")).toBe("AI_monitor");
    expect(projectName("/home/me/proj/")).toBe("proj");
    expect(projectName("C:\\")).toBe("");
    expect(projectName(undefined)).toBe("");
  });
  it("context 使用率", () => {
    expect(contextRatio({ contextTokens: 50, contextLimit: 200 })).toBe(0.25);
    expect(contextRatio({ contextTokens: 500, contextLimit: 200 })).toBe(1);
    expect(contextRatio({ contextTokens: 50 })).toBeUndefined();
    expect(contextRatio(undefined)).toBeUndefined();
  });
});

describe("時間軸色段", () => {
  const ev = (ts: number, from: HistoryEvent["from"], to: HistoryEvent["to"], id = "claude:a"): HistoryEvent => ({
    ts,
    id,
    name: "n",
    kind: "resident",
    from,
    to,
  });

  it("依轉換切段，最後一段算到 now，相鄰同狀態合併", () => {
    const rows = buildTimelines(
      [ev(100, null, "working"), ev(200, "working", "waiting"), ev(250, "waiting", "working"), ev(300, "working", "idle")],
      0,
      400,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.segs).toEqual([
      { state: "working", start: 100, end: 200 },
      { state: "waiting", start: 200, end: 250 },
      { state: "working", start: 250, end: 300 },
      { state: "idle", start: 300, end: 400 },
    ]);
  });

  it("離場（to=null）結束段落；offline 不畫", () => {
    const rows = buildTimelines([ev(100, null, "working"), ev(200, "working", null)], 0, 500);
    expect(rows[0]!.segs).toEqual([{ state: "working", start: 100, end: 200 }]);
    const off = buildTimelines([ev(100, "working", "offline")], 0, 500);
    expect(off[0]!.segs).toEqual([{ state: "working", start: 0, end: 100 }]);
  });

  it("第一個事件 from 非 null：補 since 起的前段", () => {
    const rows = buildTimelines([ev(300, "error", "idle")], 100, 400);
    expect(rows[0]!.segs).toEqual([
      { state: "error", start: 100, end: 300 },
      { state: "idle", start: 300, end: 400 },
    ]);
  });

  it("空／壞資料、transient 都略過，不崩潰", () => {
    expect(buildTimelines([], 0, 10)).toEqual([]);
    expect(buildTimelines(null as unknown as HistoryEvent[], 0, 10)).toEqual([]);
    const t = { ...ev(1, null, "working"), kind: "transient" as const };
    expect(buildTimelines([t, { bad: 1 } as unknown as HistoryEvent], 0, 10)).toEqual([]);
  });

  it("刻度：短範圍每小時、長範圍每 3 小時", () => {
    const base = new Date(2026, 9, 6, 0, 0, 0).getTime();
    const h = 3_600_000;
    expect(axisTicks(base, base + 5 * h)).toHaveLength(6);
    expect(axisTicks(base, base + 20 * h)).toHaveLength(7);
    expect(axisTicks(base, base)).toEqual([]);
  });
});

describe("通知觸發", () => {
  it("permission 一律通知（含新出現、input 升級）", () => {
    const next = agent({ state: "waiting", waitingReason: "permission" });
    expect(alertFor(agent({ state: "working" }), next)).toBe("permission");
    expect(alertFor(undefined, next)).toBe("permission");
    expect(alertFor(agent({ state: "waiting", waitingReason: "input" }), next)).toBe("permission");
  });
  it("input 只在之前是 working 時通知", () => {
    const next = agent({ state: "waiting", waitingReason: "input" });
    expect(alertFor(agent({ state: "working" }), next)).toBe("input");
    expect(alertFor(agent({ state: "idle" }), next)).toBeNull();
    expect(alertFor(undefined, next)).toBeNull();
  });
  it("已經在 waiting 不重複通知；非 waiting 不通知", () => {
    const w = agent({ state: "waiting", waitingReason: "permission" });
    expect(alertFor(w, { ...w, detail: "x" })).toBeNull();
    expect(alertFor(agent({ state: "working" }), agent({ state: "idle" }))).toBeNull();
  });
  it("等待數與標題", () => {
    expect(waitingCount([agent({ state: "waiting" }), agent({ state: "idle" }), agent({ state: "waiting" })])).toBe(2);
    expect(titleWithCount("AI", 2, true)).toBe("(2) AI");
    expect(titleWithCount("AI", 2, false)).toBe("AI");
    expect(titleWithCount("AI", 0, true)).toBe("AI");
  });
});

describe("cwd 分組配置", () => {
  it("同 cwd 相鄰、順序確定、整排置中", () => {
    const L = layoutDesks([
      { id: "c", cwd: "C:\\b" },
      { id: "a", cwd: "C:\\a" },
      { id: "b", cwd: "c:/A/" },
    ]);
    expect(L.slots.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(L.groups).toHaveLength(2);
    expect(L.groups[0]!.count).toBe(2);
    const xs = L.slots.map((s) => s.x);
    expect(xs[0]! + xs[2]!).toBeCloseTo(0);
    // 組與組之間比組內多一段空隙
    expect(xs[2]! - xs[1]!).toBeGreaterThan(xs[1]! - xs[0]!);
  });
  it("沒有 cwd 的排最後；單人在中央；空清單", () => {
    const L = layoutDesks([{ id: "x" }, { id: "y", cwd: "/p" }]);
    expect(L.slots.map((s) => s.id)).toEqual(["y", "x"]);
    expect(layoutDesks([{ id: "solo" }]).slots[0]!.x).toBe(0);
    expect(layoutDesks([])).toEqual({ slots: [], groups: [] });
  });
  it("太多人會收攏在 maxSpan 內；既有人的相對順序不因新增而變", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `id${String(i).padStart(2, "0")}`, cwd: `/p${i % 3}` }));
    const L = layoutDesks(many);
    const xs = L.slots.map((s) => s.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(10.4 + 1e-9);
    const before = layoutDesks(many.slice(0, 6)).slots.map((s) => s.id);
    const after = layoutDesks(many).slots.map((s) => s.id).filter((id) => before.includes(id));
    expect(after).toEqual(before);
  });
  it("cwdKey 正規化", () => {
    expect(cwdKey("C:\\Lab\\X\\")).toBe("c:/lab/x");
    expect(cwdKey(undefined)).toBe("");
  });
});

describe("日夜階段", () => {
  it("階段判定", () => {
    expect(phaseOf(12)).toBe("day");
    expect(phaseOf(18)).toBe("dusk");
    expect(phaseOf(23)).toBe("night");
    expect(phaseOf(3)).toBe("night");
    expect(phaseOf(6)).toBe("dawn");
    expect(phaseOf(-1)).toBe("night");
  });
  it("白天最亮、夜晚最暗、黃昏偏暖，且連續", () => {
    const day = daylightAt(12);
    const night = daylightAt(23);
    expect(day.sun).toBe(1);
    expect(night.sun).toBeLessThan(day.sun);
    expect(daylightAt(18).warm).toBeGreaterThan(day.warm);
    // 午夜首尾相接
    expect(daylightAt(0).sky).toBe(daylightAt(24).sky);
    // 平滑：相鄰 6 分鐘差距很小
    expect(Math.abs(daylightAt(17.1).sun - daylightAt(17.0).sun)).toBeLessThan(0.02);
  });
  it("壞值不崩潰；顏色內插", () => {
    expect(daylightAt(NaN).phase).toBe("day");
    expect(lerpColor(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(lerpColor(0xff0000, 0x0000ff, 0)).toBe(0xff0000);
  });
});

describe("茶水間判斷", () => {
  const now = 10_000_000;
  it("剛變 idle 以最後活動時間起算，心跳不重算，離開 idle 清掉", () => {
    expect(nextIdleSince(undefined, "idle", now - 6 * 60_000, now)).toBe(now - 6 * 60_000);
    expect(nextIdleSince(123, "idle", now, now)).toBe(123);
    expect(nextIdleSince(123, "working", undefined, now)).toBeUndefined();
    expect(nextIdleSince(undefined, "idle", undefined, now)).toBe(now);
    expect(nextIdleSince(undefined, "idle", now + 1000, now)).toBe(now);
  });
  it("超過 5 分鐘才去", () => {
    expect(shouldLounge(now - 4 * 60_000, now)).toBe(false);
    expect(shouldLounge(now - 5 * 60_000, now)).toBe(true);
    expect(shouldLounge(undefined, now)).toBe(false);
  });
});

import { layoutLabels, overlapRatio, overlaps, rectOf, type LabelBox } from "../web/src/logic/labelLayout";

describe("名牌排開", () => {
  const box = (id: string, x: number, y: number, p = 1, full = false): LabelBox => ({ id, x, y, w: 80, h: 20, priority: p, full });
  const rects = (ps: ReturnType<typeof layoutLabels>) => ps.filter((p) => !p.hidden).map((p) => rectOf(p.x, p.y, 80, 20));

  it("不重疊的維持原位", () => {
    const out = layoutLabels([box("a", 100, 100), box("b", 300, 100)], 600, 400);
    expect(out.map((p) => [p.x, p.y])).toEqual([[100, 100], [300, 100]]);
  });
  it("重疊的往上疊，結果互不相交", () => {
    const out = layoutLabels([box("a", 100, 200), box("b", 110, 200), box("c", 105, 205), box("d", 95, 198)], 600, 400);
    const r = rects(out);
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) expect(overlaps(r[i]!, r[j]!)).toBe(false);
  });
  it("高優先級的不被擠開", () => {
    const out = layoutLabels([box("lo", 100, 200, 1), box("hi", 100, 200, 4, true)], 600, 400);
    expect(out.find((p) => p.id === "hi")!.y).toBe(200);
    expect(out.find((p) => p.id === "lo")!.y).toBeLessThan(200);
  });
  it("擠出畫面上緣：精簡的藏起來，完整的留下", () => {
    const items = [box("a", 100, 30, 1), box("b", 100, 30, 1), box("c", 100, 30, 1, true)];
    const out = layoutLabels(items, 600, 400);
    expect(out.find((p) => p.id === "c")!.hidden).toBe(false);
    expect(out.some((p) => p.hidden)).toBe(true);
  });
  it("x 夾在畫面內", () => {
    const out = layoutLabels([box("a", -50, 100), box("b", 999, 100)], 600, 400);
    expect(out[0]!.x).toBe(44);
    expect(out[1]!.x).toBe(556);
  });
  it("白板重疊比例", () => {
    const area = { left: 0, top: 0, right: 100, bottom: 100 };
    expect(overlapRatio({ left: 200, top: 0, right: 300, bottom: 50 }, area)).toBe(0);
    expect(overlapRatio({ left: 50, top: 0, right: 150, bottom: 100 }, area)).toBeCloseTo(0.5);
  });
});

describe("名牌避開白板", () => {
  it("avoid 的名牌被推到障礙物上方，不 avoid 的不動", () => {
    const wall = { left: 0, top: 100, right: 300, bottom: 200 };
    const it = (id: string, avoid: boolean): LabelBox => ({ id, x: 100, y: 180, w: 80, h: 20, priority: 1, full: false, avoid });
    const out = layoutLabels([it("a", true)], 600, 400, [wall]);
    expect(out[0]!.y).toBeLessThanOrEqual(100 - 3);
    const out2 = layoutLabels([it("b", false)], 600, 400, [wall]);
    expect(out2[0]!.y).toBe(180);
  });
});
