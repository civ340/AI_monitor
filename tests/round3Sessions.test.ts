import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSessions } from "@server/collectors/claudeSessions.js";
import { createProcStartChecker } from "@server/collectors/procStart.js";
import {
  applySessionEvent,
  createSessionEventsState,
  waitingFor,
  type SessionEvent,
} from "@server/collectors/sessionEvents.js";

const MIN = 60_000;
const S1 = "11111111-aaaa-bbbb-cccc-000000000001";
const S2 = "22222222-aaaa-bbbb-cccc-000000000002";

describe("item 5a：procStart 比對（PID 回收）", () => {
  it("checker：同一個 pid 只查一次；pid 變了才重查；forget 後重查", async () => {
    const query = vi.fn(async (pid: number) => `1343563748643824${pid}`);
    const c = createProcStartChecker(query, "win32");
    expect(await c.matches(10, "134356374864382410")).toBe(true);
    expect(await c.matches(10, "134356374864382410")).toBe(true);
    expect(await c.matches(10, "134356374864399999")).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    expect(await c.matches(11, "134356374864382411")).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    c.forget(10);
    await c.matches(10, "134356374864382410");
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("查不到（null／丟例外）＝無法判斷，當作符合；並且短時間內不重複起查詢", async () => {
    let t = 0;
    const query = vi.fn(async () => null);
    const c = createProcStartChecker(query, "win32", () => t);
    expect(await c.matches(10, "134356374864382410")).toBe(true);
    expect(await c.matches(10, "134356374864382410")).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    t += 120_000;
    await c.matches(10, "134356374864382410");
    expect(query).toHaveBeenCalledTimes(2);
    const boom = createProcStartChecker(async () => Promise.reject(new Error("ps")), "win32");
    expect(await boom.matches(10, "134356374864382410")).toBe(true);
  });

  it("非 win32、或 procStart 格式不是 FILETIME 數字：一律不查、當作符合", async () => {
    const query = vi.fn(async () => "X");
    expect(await createProcStartChecker(query, "linux").matches(1, "134356374864382469")).toBe(true);
    const w = createProcStartChecker(query, "win32");
    expect(await w.matches(1, "not-a-number")).toBe(true);
    expect(await w.matches(1, undefined)).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  describe("collectSessions 整合", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "aimon-r3-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const usage = () => ({ read: vi.fn(async () => ({})), release: vi.fn(), retainOnly: vi.fn() });

    it("procStart 與該 pid 實際啟動時間不符 → 視為死亡（PID 被回收），並釋放 usage 讀取狀態", async () => {
      await writeFile(
        join(dir, "1.json"),
        JSON.stringify({ pid: process.pid, sessionId: S1, status: "busy", updatedAt: Date.now(), procStart: "134356374864382469" }),
      );
      const u = usage();
      const checker = { matches: vi.fn(async () => false), forget: vi.fn() };
      const known = new Map<string, string>();
      const agents = await collectSessions(createSessionEventsState(), u as never, known, dir, checker);
      expect(agents).toEqual([]);
      expect(u.release).toHaveBeenCalledWith(new Set([S1]));
      expect(checker.forget).toHaveBeenCalledWith(process.pid);
    });

    it("procStart 相符 → 照常出現", async () => {
      await writeFile(
        join(dir, "1.json"),
        JSON.stringify({ pid: process.pid, sessionId: S1, status: "idle", updatedAt: Date.now(), procStart: "134356374864382469" }),
      );
      const checker = { matches: vi.fn(async () => true), forget: vi.fn() };
      const agents = await collectSessions(createSessionEventsState(), usage() as never, new Map(), dir, checker);
      expect(agents).toHaveLength(1);
    });
  });
});

describe("item 5b：session 檔 waitingFor 欄位推 waitingReason", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-r3w-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const usage = () => ({ read: vi.fn(async () => ({})), release: vi.fn(), retainOnly: vi.fn() });
  const write = (over: Record<string, unknown>) =>
    writeFile(join(dir, "1.json"), JSON.stringify({ pid: process.pid, sessionId: S1, status: "waiting", updatedAt: Date.now(), ...over }));
  const run = (events = createSessionEventsState()) => collectSessions(events, usage() as never, new Map(), dir);

  it("waitingFor 含 input → input", async () => {
    await write({ waitingFor: "waiting for input" });
    const [a] = await run();
    expect(a).toMatchObject({ state: "waiting", waitingReason: "input" });
  });
  it("waitingFor 是其他字串 → permission；沒有欄位 → permission（舊行為）", async () => {
    await write({ waitingFor: "approve Bash" });
    expect((await run())[0]).toMatchObject({ waitingReason: "permission" });
    await write({});
    expect((await run())[0]).toMatchObject({ waitingReason: "permission" });
  });
  it("hook 事件優先於 waitingFor；waitingFor 不外流進 AgentState", async () => {
    await write({ waitingFor: "waiting for input" });
    const events = createSessionEventsState();
    applySessionEvent(events, { ts: Date.now(), ev: "notification", session_id: S1, notification_type: "permission_prompt" });
    const [a] = await run(events);
    expect(a?.waitingReason).toBe("permission");
    expect(JSON.stringify(a)).not.toContain("waiting for input");
  });
  it("status 不是 waiting 時不看 waitingFor", async () => {
    await write({ status: "busy", waitingFor: "waiting for input" });
    const [a] = await run();
    expect(a?.state).toBe("working");
    expect(a?.waitingReason).toBeUndefined();
  });
});

describe("item 6：測試缺口", () => {
  it("單一 session 檔處理拋例外（usage.read throw）不影響其他 session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aimon-r3x-"));
    try {
      const now = Date.now();
      await writeFile(join(dir, "1.json"), JSON.stringify({ pid: process.pid, sessionId: S1, status: "idle", updatedAt: now }));
      await writeFile(join(dir, "2.json"), JSON.stringify({ pid: process.pid, sessionId: S2, status: "idle", updatedAt: now }));
      const u = {
        read: vi.fn(async (sid: string) => {
          if (sid === S1) throw new Error("boom");
          return {};
        }),
        release: vi.fn(),
        retainOnly: vi.fn(),
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const agents = await collectSessions(createSessionEventsState(), u as never, new Map(), dir);
      warn.mockRestore();
      expect(agents.map((a) => a.id)).toEqual(["claude:22222222"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("waitingFor 清除邏輯 `>` 的邊界：updatedAt 與事件 ts 相等（busy）時不清；晚 1ms 才清", () => {
    const st = createSessionEventsState();
    const ev: SessionEvent = { ts: 1000, ev: "notification", session_id: S1, notification_type: "permission_prompt" };
    applySessionEvent(st, ev);
    expect(waitingFor(st, S1, { status: "busy", updatedAt: 1000 })).toBe("permission");
    expect(waitingFor(st, S1, { status: "busy", updatedAt: 1001 })).toBeUndefined();
    expect(waitingFor(st, S1, { status: "busy", updatedAt: 999 })).toBe("permission");
    void MIN;
  });
});
