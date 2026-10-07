import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEvent } from "@shared/types.js";
import { computeTodaySummary, serverStartEvent } from "@server/history.js";
import { Store } from "@server/store.js";
import { buildTimelines } from "../web/src/logic/timeline";
import { readHeartbeat, startHeartbeat, writeHeartbeat } from "@server/heartbeat.js";
import { createShutdownHandler, shutdownSignals } from "@server/shutdown.js";

const SINCE = new Date("2026-10-06T00:00:00").getTime();
const H = 3_600_000;
const M = 60_000;
const at = (h: number): number => SINCE + h * H;

const ev = (over: Partial<HistoryEvent> & Pick<HistoryEvent, "ts" | "from" | "to">): HistoryEvent => ({
  id: "claude:a",
  name: "Claude Code",
  kind: "resident",
  ...over,
});
const sub = (over: Partial<HistoryEvent> & Pick<HistoryEvent, "ts" | "from" | "to">): HistoryEvent =>
  ev({ id: "sub:x", name: "Explore", kind: "transient", ...over });

describe("item 1：臨時人力跨重啟只算一次", () => {
  it("9:00 進場、10:00 shutdown 離場、10:30 marker、10:30 同 id 再進場、11:00 離場 → count 1、總時間 1.5h", () => {
    const s = computeTodaySummary(
      [
        sub({ ts: at(9), from: null, to: "working" }),
        sub({ ts: at(10), from: "working", to: null }),
        serverStartEvent(at(10.5)),
        sub({ ts: at(10.5), from: null, to: "working" }),
        sub({ ts: at(11), from: "working", to: null }),
      ],
      [],
      SINCE,
      at(12),
    );
    expect(s.subagents.count).toBe(1);
    expect(s.subagents.byType["Explore"]).toEqual({ count: 1, totalMs: 1.5 * H });
    expect(s.subagents.totalMs).toBe(1.5 * H);
  });

  it("強制結束（沒有離場事件）：marker 後同 id 再進場、離場 → 仍只算一位", () => {
    const s = computeTodaySummary(
      [
        sub({ ts: at(9), from: null, to: "working" }),
        serverStartEvent(at(10.5)),
        sub({ ts: at(10.5), from: null, to: "working" }),
        sub({ ts: at(11), from: "working", to: null }),
      ],
      [],
      SINCE,
      at(12),
    );
    expect(s.subagents.count).toBe(1);
    expect(s.subagents.byType["Explore"]?.count).toBe(1);
  });
});

describe("item 2：心跳 lastAliveAt 讓強制結束不抹掉真實工作時間", () => {
  const events = (lastAliveAt?: number): HistoryEvent[] => [
    ev({ ts: at(9), from: null, to: "working" }),
    serverStartEvent(at(15), lastAliveAt),
    ev({ ts: at(15), from: null, to: "idle" }),
  ];

  it("summary：9:00 working、心跳到 14:59、15:00 marker → workingMs ≈ 5h59m", () => {
    const s = computeTodaySummary(events(at(15) - M), [], SINCE, at(16));
    expect(s.agents[0]?.workingMs).toBe(6 * H - M);
  });

  it("summary：沒有心跳 → 退回舊行為（結在前一筆事件 → 0）", () => {
    const s = computeTodaySummary(events(undefined), [], SINCE, at(16));
    expect(s.agents[0]?.workingMs).toBe(0);
  });

  it("summary：lastAliveAt 不得超過 marker.ts", () => {
    const s = computeTodaySummary(events(at(20)), [], SINCE, at(16));
    expect(s.agents[0]?.workingMs).toBe(6 * H);
  });

  it("summary：午夜快照後心跳正常（快照 00:00 working、心跳到 23:59 隔天 marker 之前）", () => {
    const s = computeTodaySummary(
      [ev({ ts: at(0), from: "working", to: "working" }), serverStartEvent(at(5), at(4.5))],
      [],
      SINCE,
      at(6),
    );
    expect(s.agents[0]?.workingMs).toBe(4.5 * H);
  });

  it("timeline：同樣結在 lastAliveAt；沒有心跳退回舊行為", () => {
    const rows = buildTimelines(events(at(15) - M), SINCE, at(16));
    const working = rows[0]!.segs.find((x) => x.state === "working")!;
    expect(working.end - working.start).toBe(6 * H - M);
    const old = buildTimelines(events(undefined), SINCE, at(16));
    expect(old[0]!.segs.find((x) => x.state === "working")).toBeUndefined();
  });
});

describe("heartbeat 檔", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-hb-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it("寫入後讀得回來；不留暫存檔；缺檔／壞檔 → undefined", async () => {
    const f = join(dir, "heartbeat.json");
    expect(readHeartbeat(f)).toBeUndefined();
    writeHeartbeat(f, 12345);
    expect(readHeartbeat(f)).toBe(12345);
    expect(await readdir(dir)).toEqual(["heartbeat.json"]);
    await writeFile(f, "{oops");
    expect(readHeartbeat(f)).toBeUndefined();
  });

  it("寫入失敗只 warn、不丟例外", async () => {
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => writeHeartbeat(join(blocker, "sub", "heartbeat.json"), 1)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("startHeartbeat：立刻寫一次、之後每個間隔寫一次；stop 後不再寫", async () => {
    vi.useFakeTimers();
    const f = join(dir, "heartbeat.json");
    let t = 1000;
    const hb = startHeartbeat(f, 60_000, () => t);
    expect(readHeartbeat(f)).toBe(1000);
    t = 61_000;
    vi.advanceTimersByTime(60_000);
    expect(readHeartbeat(f)).toBe(61_000);
    hb.stop();
    t = 999_999;
    vi.advanceTimersByTime(120_000);
    expect(readHeartbeat(f)).toBe(61_000);
  });

  it("Store.recordServerStart 把 lastAliveAt 帶進 marker 事件", async () => {
    const file = join(dir, "history.jsonl");
    const s = new Store({ historyFile: file });
    s.recordServerStart(5000, 4000);
    const line = JSON.parse((await readFile(file, "utf8")).trim()) as HistoryEvent;
    expect(line).toMatchObject({ marker: "server-start", ts: 5000, lastAliveAt: 4000 });
  });
});

describe("shutdown 訊號與防重入", () => {
  it("訊號清單含 SIGINT/SIGTERM/SIGHUP；win32 另有 SIGBREAK", () => {
    expect(shutdownSignals("linux")).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    expect(shutdownSignals("win32")).toEqual(["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]);
  });

  it("多個訊號同時來只執行一次", async () => {
    const run = vi.fn(async () => {});
    const h = createShutdownHandler(run);
    await Promise.all([h(), h(), h()]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
