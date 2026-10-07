import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState, HistoryEvent } from "@shared/types.js";
import {
  appendHistory,
  computeTodaySummary,
  diffHistory,
  HISTORY_ROTATE_BYTES,
  readHistory,
  startOfToday,
} from "@server/history.js";

const SINCE = new Date("2026-10-06T00:00:00").getTime();
const H = 3_600_000;
const NOW = SINCE + 10 * H;

const ev = (over: Partial<HistoryEvent> & Pick<HistoryEvent, "ts" | "from" | "to">): HistoryEvent => ({
  id: "claude:a",
  name: "Claude Code",
  kind: "resident",
  ...over,
});

describe("startOfToday", () => {
  it("回本地當天 00:00", () => {
    const t = startOfToday(new Date("2026-10-06T15:42:10").getTime());
    expect(t).toBe(SINCE);
  });
});

describe("diffHistory", () => {
  const a = (over: Partial<AgentState> = {}): AgentState => ({
    id: "x",
    kind: "transient",
    parent: "p",
    name: "scout",
    state: "working",
    tasks: [],
    updatedAt: 1,
    cwd: "C:\\proj",
    ...over,
  });

  it("進場 / 變化 / 離場；不寫 detail（內容文字），只有 to=error 時寫 error 摘要", () => {
    const empty = new Map<string, AgentState>();
    const w = new Map([["x", a({ detail: "z".repeat(500) })]]);
    const e1 = diffHistory(empty, w, 10); // detail 是使用者內容，絕不落地
    expect(e1).toEqual([
      { ts: 10, id: "x", name: "scout", kind: "transient", parent: "p", cwd: "C:\\proj", from: null, to: "working" },
    ]);
    const err = new Map([["x", a({ state: "error", error: "boom", detail: "d" })]]);
    expect(diffHistory(w, err, 11)[0]).toMatchObject({ from: "working", to: "error", error: "boom" });
    expect(diffHistory(w, err, 11)[0]).not.toHaveProperty("detail");
    expect(diffHistory(err, empty, 12)[0]).toMatchObject({ from: "error", to: null });
    expect(diffHistory(w, new Map([["x", a({ detail: "other", updatedAt: 99 })]]), 13)).toEqual([]);
  });
});

describe("appendHistory / readHistory / rotate", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-hist-"));
    file = join(dir, "sub", "history.jsonl");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("append 會建目錄並寫 jsonl；readHistory 依 since 過濾並排序", async () => {
    appendHistory(file, [ev({ ts: 30, from: null, to: "idle" }), ev({ ts: 10, from: null, to: "working", id: "b" })]);
    appendHistory(file, [ev({ ts: 20, from: "idle", to: null })]);
    expect((await readHistory(file, 0)).map((e) => e.ts)).toEqual([10, 20, 30]);
    expect((await readHistory(file, 20)).map((e) => e.ts)).toEqual([20, 30]);
  });

  it("limit 取最新的；壞行略過；檔案不存在回空", async () => {
    expect(await readHistory(file, 0)).toEqual([]);
    appendHistory(file, [1, 2, 3, 4].map((ts) => ev({ ts, from: null, to: "idle" })));
    await writeFile(file, (await readFile(file, "utf8")) + "{壞掉\n");
    expect((await readHistory(file, 0, 2)).map((e) => e.ts)).toEqual([3, 4]);
  });

  it("超過 5MB 就 rotate 成 .1，且 readHistory 仍讀得到舊檔內容", async () => {
    appendHistory(file, [ev({ ts: 1, from: null, to: "idle" })]);
    await writeFile(file, (await readFile(file, "utf8")) + " ".repeat(HISTORY_ROTATE_BYTES) + "\n");
    appendHistory(file, [ev({ ts: 2, from: "idle", to: null })]);
    await expect(stat(file + ".1")).resolves.toBeTruthy();
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await readHistory(file, 0)).map((e) => e.ts)).toEqual([1, 2]);
  });

  it("寫入失敗只 warn 不丟例外", async () => {
    await writeFile(join(dir, "blocker"), "x");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => appendHistory(join(dir, "blocker", "h.jsonl"), [ev({ ts: 1, from: null, to: "idle" })])).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("computeTodaySummary", () => {
  it("working / waiting 累積時間，進行中的段落算到 now", () => {
    const s = computeTodaySummary(
      [
        ev({ ts: SINCE + 1 * H, from: null, to: "working" }),
        ev({ ts: SINCE + 3 * H, from: "working", to: "waiting" }),
        ev({ ts: SINCE + 4 * H, from: "waiting", to: "working" }),
        ev({ ts: SINCE + 5 * H, from: "working", to: "idle" }),
        ev({ ts: SINCE + 8 * H, from: "idle", to: "working" }),
      ],
      [],
      SINCE,
      NOW,
    );
    const a = s.agents[0]!;
    expect(a.workingMs).toBe(2 * H + 1 * H + 2 * H);
    expect(a.waitingMs).toBe(1 * H);
    expect(a.firstSeen).toBe(SINCE + 1 * H);
    expect(a.lastSeen).toBe(NOW);
    expect(s.since).toBe(SINCE);
  });

  it("今天以前就在場（第一筆 from 非 null）→ 該狀態從 since 起算", () => {
    const s = computeTodaySummary([ev({ ts: SINCE + 2 * H, from: "working", to: "idle" })], [], SINCE, NOW);
    expect(s.agents[0]?.workingMs).toBe(2 * H);
    expect(s.agents[0]?.firstSeen).toBe(SINCE);
  });

  it("離場後 lastSeen 停在離場時間，不再累積", () => {
    const s = computeTodaySummary(
      [ev({ ts: SINCE + H, from: null, to: "working" }), ev({ ts: SINCE + 2 * H, from: "working", to: null })],
      [],
      SINCE,
      NOW,
    );
    expect(s.agents[0]).toMatchObject({ workingMs: H, lastSeen: SINCE + 2 * H });
  });

  it("since 之前的事件不計", () => {
    const s = computeTodaySummary([ev({ ts: SINCE - 1, from: null, to: "working" })], [], SINCE, NOW);
    expect(s.agents).toEqual([]);
  });

  it("transient 用進出場配對統計次數、總時間與 byType；不進 agents", () => {
    const t = (over: Partial<HistoryEvent>): HistoryEvent => ev({ kind: "transient", name: "scout", ...over } as HistoryEvent);
    const s = computeTodaySummary(
      [
        t({ id: "s1", ts: SINCE + H, from: null, to: "working" }),
        t({ id: "s1", ts: SINCE + 2 * H, from: "working", to: null }),
        t({ id: "s2", name: "verifier", ts: SINCE + 3 * H, from: null, to: "working" }),
        t({ id: "s2", name: "verifier", ts: SINCE + 3 * H + 30 * 60_000, from: "working", to: null }),
        t({ id: "s3", ts: SINCE + 9 * H, from: null, to: "working" }), // 還在場，算到 now
      ],
      [],
      SINCE,
      NOW,
    );
    expect(s.agents).toEqual([]);
    expect(s.subagents.count).toBe(3);
    expect(s.subagents.totalMs).toBe(H + 30 * 60_000 + H);
    expect(s.subagents.byType).toEqual({
      scout: { count: 2, totalMs: 2 * H },
      verifier: { count: 1, totalMs: 30 * 60_000 },
    });
  });

  it("server 重啟造成的重複進場不重複計數", () => {
    const t = (over: Partial<HistoryEvent>): HistoryEvent => ev({ kind: "transient", name: "scout", id: "s1", ...over } as HistoryEvent);
    const s = computeTodaySummary(
      [t({ ts: SINCE + H, from: null, to: "working" }), t({ ts: SINCE + 2 * H, from: null, to: "working" }), t({ ts: SINCE + 3 * H, from: "working", to: null })],
      [],
      SINCE,
      NOW,
    );
    expect(s.subagents.count).toBe(1);
    expect(s.subagents.totalMs).toBe(2 * H);
  });

  it("usage 加總目前各 agent 的 usage（沒有 usage 的略過、costUsd 缺值當 0）", () => {
    const mk = (id: string, usage?: AgentState["usage"]): AgentState => ({ id, kind: "resident", name: id, state: "idle", tasks: [], updatedAt: 1, usage });
    const s = computeTodaySummary(
      [],
      [
        mk("a", { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, costUsd: 0.5 }),
        mk("b", { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 }),
        mk("c"),
      ],
      SINCE,
      NOW,
    );
    expect(s.usage).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44, costUsd: 0.5 });
  });
});
