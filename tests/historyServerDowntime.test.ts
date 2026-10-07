import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState, HistoryEvent } from "@shared/types.js";
import {
  appendHistory,
  computeTodaySummary,
  diffHistory,
  readHistory,
  readTodayEvents,
  resetHistoryCache,
  serverStartEvent,
  startOfToday,
} from "@server/history.js";
import { Store } from "@server/store.js";
import { buildTimelines } from "../web/src/logic/timeline";

const SINCE = new Date("2026-10-06T00:00:00").getTime();
const H = 3_600_000;
const at = (h: number): number => SINCE + h * H;

const ev = (over: Partial<HistoryEvent> & Pick<HistoryEvent, "ts" | "from" | "to">): HistoryEvent => ({
  id: "claude:a",
  name: "Claude Code",
  kind: "resident",
  ...over,
});
const marker = (ts: number): HistoryEvent => serverStartEvent(ts);

describe("server 停機時間不算工作時間（computeTodaySummary）", () => {
  it("案例 1：9:00 進場 working、10:00 停機（寫了離場）、15:00 重啟 idle、16:00 查詢 → working ≈ 1h", () => {
    const s = computeTodaySummary(
      [
        ev({ ts: at(9), from: null, to: "working" }),
        ev({ ts: at(10), from: "working", to: null }),
        marker(at(15)),
        ev({ ts: at(15), from: null, to: "idle" }),
      ],
      [],
      SINCE,
      at(16),
    );
    expect(s.agents).toHaveLength(1);
    expect(s.agents[0]?.workingMs).toBe(H);
  });

  it("案例 1b：停機沒寫離場事件（被強制結束）→ 仍結束在標記前最後一筆事件", () => {
    const s = computeTodaySummary(
      [
        ev({ ts: at(9), from: null, to: "working" }),
        ev({ ts: at(10), from: null, to: "idle", id: "claude:b" }), // 10:00 是標記前最後一筆
        marker(at(15)),
        ev({ ts: at(15), from: null, to: "idle" }),
      ],
      [],
      SINCE,
      at(16),
    );
    expect(s.agents.find((a) => a.id === "claude:a")?.workingMs).toBe(H);
  });

  it("案例 2：9:00 working、重啟後 agent 不在、20:00 查詢 → working ≈ 1h", () => {
    const s = computeTodaySummary(
      [
        ev({ ts: at(9), from: null, to: "working" }),
        ev({ ts: at(10), from: null, to: "idle", id: "claude:b" }),
        marker(at(15)),
      ],
      [],
      SINCE,
      at(20),
    );
    const a = s.agents.find((x) => x.id === "claude:a");
    expect(a?.workingMs).toBe(H);
    expect(a?.lastSeen).toBe(at(10));
  });

  it("標記本身不產生 agent 列；臨時人力也在標記處結清", () => {
    const t = (over: Partial<HistoryEvent>): HistoryEvent => ev({ kind: "transient", name: "scout", id: "s1", ...over } as HistoryEvent);
    const s = computeTodaySummary(
      [t({ ts: at(9), from: null, to: "working" }), ev({ ts: at(10), from: null, to: "idle" }), marker(at(15))],
      [],
      SINCE,
      at(20),
    );
    expect(s.agents.map((a) => a.id)).toEqual(["claude:a"]);
    expect(s.subagents.totalMs).toBe(H);
  });
});

describe("前端時間軸忽略標記、並在標記處結束開著的段落", () => {
  it("段落結束在標記前最後一筆事件；不畫標記列；重啟後新段從重啟起", () => {
    const rows = buildTimelines(
      [
        ev({ ts: at(9), from: null, to: "working" }),
        ev({ ts: at(10), from: null, to: "idle", id: "claude:b" }),
        marker(at(15)),
        ev({ ts: at(15), from: null, to: "idle", id: "claude:b" }),
      ],
      SINCE,
      at(16),
    );
    expect(rows.map((r) => r.id).sort()).toEqual(["claude:a", "claude:b"]);
    const a = rows.find((r) => r.id === "claude:a")!;
    expect(a.segs).toEqual([{ state: "working", start: at(9), end: at(10) }]);
    const b = rows.find((r) => r.id === "claude:b")!;
    // 10:00 進場即遇到標記前的最後一筆 → 零長度段落略過；重啟後從 15:00 起
    expect(b.segs).toEqual([{ state: "idle", start: at(15), end: at(16) }]);
  });
});

describe("history 不存內容文字（只有 error 摘要）", () => {
  const a = (over: Partial<AgentState> = {}): AgentState => ({
    id: "x",
    kind: "resident",
    name: "n",
    state: "working",
    tasks: [],
    updatedAt: 1,
    detail: "SECRET prompt text",
    ...over,
  });
  it("進場事件沒有 detail；to=error 才有 error（截 120 字）", () => {
    const empty = new Map<string, AgentState>();
    const [e1] = diffHistory(empty, new Map([["x", a()]]), 1);
    expect(e1).not.toHaveProperty("detail");
    expect(e1).not.toHaveProperty("error");
    const [e2] = diffHistory(new Map([["x", a()]]), new Map([["x", a({ state: "error", error: "e".repeat(300) })]]), 2);
    expect(e2).toMatchObject({ to: "error" });
    expect(e2?.error?.length).toBe(120);
    expect(JSON.stringify(e2)).not.toContain("SECRET");
  });
});

describe("history 非同步讀取 + 今日快取", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-hcache-"));
    file = join(dir, "history.jsonl");
    resetHistoryCache();
  });
  afterEach(async () => {
    vi.useRealTimers();
    resetHistoryCache();
    await rm(dir, { recursive: true, force: true });
  });

  it("readHistory 回傳 Promise；舊檔的 detail 讀出時被剝掉（舊 error 轉成 error 欄位）", async () => {
    await writeFile(
      file,
      [
        JSON.stringify({ ts: 1, id: "a", name: "n", kind: "resident", from: null, to: "working", detail: "OLD PROMPT" }),
        JSON.stringify({ ts: 2, id: "a", name: "n", kind: "resident", from: "working", to: "error", detail: "boom" }),
      ].join("\n") + "\n",
    );
    const p = readHistory(file, 0);
    expect(typeof p.then).toBe("function");
    const out = await p;
    expect(JSON.stringify(out)).not.toContain("OLD PROMPT");
    expect(out[1]).toMatchObject({ to: "error", error: "boom" });
    expect(out[1]).not.toHaveProperty("detail");
  });

  it("readTodayEvents：載入後 append 同步更新快取，不必重讀檔案", async () => {
    const now = Date.now();
    appendHistory(file, [ev({ ts: now - 10, from: null, to: "idle" })]);
    expect((await readTodayEvents(file, now)).length).toBe(1);
    appendHistory(file, [ev({ ts: now - 5, from: "idle", to: "working" })]);
    await rm(file); // 刪掉檔案：結果只可能來自快取
    expect((await readTodayEvents(file, now)).map((e) => e.ts)).toEqual([now - 10, now - 5]);
  });

  it("載入進行中發生的 append 不會遺失", async () => {
    const now = Date.now();
    appendHistory(file, [ev({ ts: now - 10, from: null, to: "idle" })]);
    const loading = readTodayEvents(file, now);
    appendHistory(file, [ev({ ts: now - 5, from: "idle", to: "working" })]);
    expect((await loading).map((e) => e.ts)).toEqual([now - 10, now - 5]);
  });

  it("跨日重置：昨天的事件不在今天的快取裡", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T23:00:00"));
    appendHistory(file, [ev({ ts: Date.now(), from: null, to: "working" })]);
    expect(await readTodayEvents(file)).toHaveLength(1);
    vi.setSystemTime(new Date("2026-10-07T00:30:00"));
    appendHistory(file, [ev({ ts: Date.now(), from: "working", to: "idle" })]);
    const today = await readTodayEvents(file);
    expect(today).toHaveLength(1);
    expect(today[0]?.ts).toBeGreaterThanOrEqual(startOfToday());
  });

  it("今日快取不套 5000 筆上限（summary 用）", async () => {
    const now = Date.now();
    const events: HistoryEvent[] = [];
    for (let i = 0; i < 6000; i++) events.push(ev({ ts: now - 6000 + i, from: null, to: "idle", id: "a" + i }));
    appendHistory(file, events);
    expect((await readTodayEvents(file, now)).length).toBe(6000);
    expect((await readHistory(file, 0)).length).toBe(5000); // /api/history 仍有上限
  });
});

describe("Store：shutdown 離場事件 + server-start 標記", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-shut-"));
    await mkdir(dir, { recursive: true });
    file = join(dir, "history.jsonl");
    resetHistoryCache();
  });
  afterEach(async () => {
    resetHistoryCache();
    await rm(dir, { recursive: true, force: true });
  });
  const agent = (id: string, state: AgentState["state"] = "working"): AgentState => ({
    id,
    kind: "resident",
    name: id,
    state,
    tasks: [],
    updatedAt: Date.now(),
  });
  const lines = async (): Promise<HistoryEvent[]> =>
    (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as HistoryEvent);

  it("recordShutdown 同步替每個在場 agent 寫 to:null；之後不再寫", async () => {
    const store = new Store({ historyFile: file });
    store.replaceSource("s", [agent("a"), agent("b", "idle")]);
    store.recordShutdown();
    const out = await lines();
    const exits = out.filter((e) => e.to === null);
    expect(exits.map((e) => e.id).sort()).toEqual(["a", "b"]);
    expect(exits.find((e) => e.id === "b")?.from).toBe("idle");
    store.replaceSource("s", []); // shutdown 之後 collector 不該再寫歷史
    expect((await lines()).length).toBe(out.length);
  });

  it("recordServerStart 寫一筆 marker: server-start", async () => {
    const store = new Store({ historyFile: file });
    store.recordServerStart();
    const [m] = await lines();
    expect(m).toMatchObject({ marker: "server-start", id: "server", from: null, to: null });
  });
});
