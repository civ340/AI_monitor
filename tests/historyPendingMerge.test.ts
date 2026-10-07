import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEvent } from "@shared/types.js";

/** 讓測試能卡在「readFile 已讀完、.then 合併之前」這個縫隙 */
const gate: { release?: () => void; reached?: () => void; hold: boolean } = { hold: false };
vi.mock("node:fs/promises", async (orig) => {
  const actual = await orig<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      const data = await actual.readFile(...args);
      if (gate.hold) {
        gate.reached?.();
        await new Promise<void>((r) => (gate.release = r));
      }
      return data;
    }) as typeof actual.readFile,
  };
});

const { appendHistory, readTodayEvents, resetHistoryCache } = await import("@server/history.js");

const NOW = Date.now();
const ev = (ts: number, id: string): HistoryEvent => ({ ts, id, name: id, kind: "resident", from: null, to: "idle" });

describe("readTodayEvents：載入期間的 append 併入快取", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-pend-"));
    file = join(dir, "history.jsonl");
    resetHistoryCache();
  });
  afterEach(async () => {
    gate.hold = false;
    await rm(dir, { recursive: true, force: true });
  });

  it("append 發生在 readFile 完成與 .then 之間：事件不丟，也不重複", async () => {
    await writeFile(file, JSON.stringify(ev(NOW - 2000, "old")) + "\n");
    gate.hold = true;
    const reached = new Promise<void>((r) => (gate.reached = r));
    const p = readTodayEvents(file, NOW);
    await reached; // 檔案內容已讀走（只含 old），載入尚未合併
    appendHistory(file, [ev(NOW - 1000, "late")]); // 寫入檔案，但不在已讀走的內容裡 → 只存在於 pending
    gate.hold = false;
    gate.release?.();
    const events = await p;
    expect(events.map((e) => e.id)).toEqual(["old", "late"]);
  });

  it("append 同時存在於已讀內容與 pending：用內容去重，只留一份", async () => {
    const dup = ev(NOW - 1000, "dup");
    await writeFile(file, JSON.stringify(dup) + "\n");
    gate.hold = true;
    const reached = new Promise<void>((r) => (gate.reached = r));
    const p = readTodayEvents(file, NOW);
    await reached;
    // 模擬「讀到了、pending 也有」：把同一筆事件直接放進 pending（appendHistory 會再寫一次檔案，但那份沒被已讀內容包含）
    appendHistory(file, [dup]);
    gate.hold = false;
    gate.release?.();
    const events = await p;
    expect(events.filter((e) => e.id === "dup")).toHaveLength(1);
  });
});
