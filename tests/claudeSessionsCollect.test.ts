import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSessions } from "@server/collectors/claudeSessions.js";
import {
  applySessionEvent,
  createSessionEventsState,
  waitingFor,
  type SessionEvent,
} from "@server/collectors/sessionEvents.js";
import { Store, STALL_MS } from "@server/store.js";

const MIN = 60_000;
const S1 = "11111111-aaaa-bbbb-cccc-000000000001";
const S2 = "22222222-aaaa-bbbb-cccc-000000000002";
const DEAD_PID = 2_000_000_000;

describe("collectSessions（暫存 sessions 目錄）", () => {
  let dir: string;
  let now: number;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-sess-"));
    now = Date.now();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeSession = (file: string, over: Record<string, unknown>) =>
    writeFile(join(dir, file), JSON.stringify({ pid: process.pid, sessionId: S1, cwd: "/p", status: "idle", updatedAt: now, ...over }));
  const fakeUsage = (mtimeMs?: number) => ({
    read: vi.fn(async () => ({ mtimeMs })),
    release: vi.fn(),
    retainOnly: vi.fn(),
  });
  const run = (usage: ReturnType<typeof fakeUsage>, events = createSessionEventsState(), known = new Map<string, string>()) =>
    collectSessions(events, usage as never, known, dir);
  const ev = (e: SessionEvent["ev"], ts: number, nt?: string, sid = S1): SessionEvent => ({ ts, ev: e, session_id: sid, notification_type: nt });

  it("bug3：waiting 超過 10 分鐘（pid 活著）仍是 waiting，預設 permission", async () => {
    await writeSession("1.json", { status: "waiting", updatedAt: now - 31 * MIN });
    const [a] = await run(fakeUsage());
    expect(a).toMatchObject({ state: "waiting", waitingReason: "permission" });
  });

  it("bug3：idle 很久（pid 活著）是 idle 而不是 offline", async () => {
    await writeSession("1.json", { status: "idle", updatedAt: now - 3 * 3_600_000 });
    const [a] = await run(fakeUsage());
    expect(a?.state).toBe("idle");
  });

  it("bug3：status waiting + hook 事件 → 用 hook 的原因", async () => {
    await writeSession("1.json", { status: "waiting", updatedAt: now - 5 * MIN });
    const events = createSessionEventsState();
    applySessionEvent(events, ev("notification", now - 5 * MIN, "idle_prompt"));
    const [a] = await run(fakeUsage(), events);
    expect(a).toMatchObject({ state: "waiting", waitingReason: "input" });
  });

  it("bug3：status busy 但 transcript 20 分鐘沒寫 → working，且 store 判 stalled", async () => {
    await writeSession("1.json", { status: "busy", updatedAt: now - 20 * MIN });
    const [a] = await run(fakeUsage(now - 20 * MIN));
    expect(a?.state).toBe("working");
    const store = new Store({ historyFile: null });
    store.replaceSource("claude", [a!]);
    expect(store.visible().agents[0]?.stalled).toBe(true);
    expect(20 * MIN).toBeGreaterThan(STALL_MS);
  });

  it("bug3：status busy 且 transcript 剛寫過 → working、沒 stalled", async () => {
    await writeSession("1.json", { status: "busy", updatedAt: now - 20 * MIN });
    const [a] = await run(fakeUsage(now - MIN));
    const store = new Store({ historyFile: null });
    store.replaceSource("claude", [a!]);
    expect(store.visible().agents[0]).toMatchObject({ state: "working" });
    expect(store.visible().agents[0]?.stalled).toBeUndefined();
  });

  it("bug4：核准後 status 變回 busy（updatedAt 晚於 notification）→ 清除 waiting", async () => {
    const events = createSessionEventsState();
    applySessionEvent(events, ev("notification", now - 60_000, "permission_prompt"));
    await writeSession("1.json", { status: "busy", updatedAt: now - 30_000 });
    const [a] = await run(fakeUsage(now - 1000), events);
    expect(a?.state).toBe("working");
    expect(a?.waitingReason).toBeUndefined();
  });

  it("bug4：busy 但 updatedAt 早於 notification（還沒核准）→ 仍是 waiting", async () => {
    const events = createSessionEventsState();
    applySessionEvent(events, ev("notification", now - 30_000, "permission_prompt"));
    await writeSession("1.json", { status: "busy", updatedAt: now - 60_000 });
    const [a] = await run(fakeUsage(), events);
    expect(a).toMatchObject({ state: "waiting", waitingReason: "permission" });
  });

  it("bug10：session JSON 讀到半截 → 不釋放 transcript 讀取狀態；檔案消失／pid 死掉才釋放", async () => {
    const usage = fakeUsage();
    const known = new Map<string, string>();
    await writeSession("1.json", { sessionId: S1 });
    await writeSession("2.json", { sessionId: S2 });
    await run(usage, createSessionEventsState(), known);
    expect(known.get("1.json")).toBe(S1);

    // 1.json 變半截（寫入中）：不能釋放 S1
    await writeFile(join(dir, "1.json"), '{"pid": 12');
    await run(usage, createSessionEventsState(), known);
    const released = (): string[] => usage.release.mock.calls.flatMap((c) => [...(c[0] as Iterable<string>)]);
    expect(released()).not.toContain(S1);
    expect(usage.retainOnly).not.toHaveBeenCalled();

    // 2.json 檔案消失 → 釋放 S2
    await unlink(join(dir, "2.json"));
    await run(usage, createSessionEventsState(), known);
    expect(released()).toContain(S2);

    // 1.json 恢復正常但 pid 已死 → 釋放 S1
    await writeSession("1.json", { sessionId: S1, pid: DEAD_PID });
    await run(usage, createSessionEventsState(), known);
    expect(released()).toContain(S1);
  });
});

describe("waitingFor 疊加規則（item 4）", () => {
  const events = (e: SessionEvent) => {
    const s = createSessionEventsState();
    applySessionEvent(s, e);
    return s;
  };
  const notif: SessionEvent = { ts: 100, ev: "notification", session_id: S1, notification_type: "permission_prompt" };

  it("session 檔 busy 且 updatedAt > notification.ts → 清除", () => {
    expect(waitingFor(events(notif), S1, { status: "busy", updatedAt: 200 })).toBeUndefined();
  });
  it("busy 但 updatedAt <= ts → 保留；非 busy → 保留；沒給 session → 保留（舊行為）", () => {
    expect(waitingFor(events(notif), S1, { status: "busy", updatedAt: 50 })).toBe("permission");
    expect(waitingFor(events(notif), S1, { status: "waiting", updatedAt: 200 })).toBe("permission");
    expect(waitingFor(events(notif), S1)).toBe("permission");
  });
});
