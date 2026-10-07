import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState, StreamEvent } from "@shared/types.js";
import { sameAgent, Store, STALL_CHECK_MS, STALL_MS } from "@server/store.js";

const NOW = new Date("2026-10-06T12:00:00").getTime();

function agent(over: Partial<AgentState> = {}): AgentState {
  return { id: "claude:a", kind: "resident", name: "Claude Code", state: "idle", tasks: [], updatedAt: NOW, ...over };
}

describe("sameAgent 新欄位", () => {
  const a = agent();
  it("state / waitingReason / error / stalled 變了都算不同", () => {
    expect(sameAgent(a, agent({ state: "waiting" }))).toBe(false);
    expect(sameAgent(agent({ state: "waiting", waitingReason: "input" }), agent({ state: "waiting", waitingReason: "permission" }))).toBe(false);
    expect(sameAgent(a, agent({ error: "boom" }))).toBe(false);
    expect(sameAgent(a, agent({ stalled: true }))).toBe(false);
  });
  it("usage 的 token 數變了算不同；沒變（含 costUsd/contextTokens）算相同", () => {
    const u = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1 };
    const base = agent({ usage: u });
    expect(sameAgent(base, agent({ usage: { ...u, outputTokens: 2 } }))).toBe(false);
    expect(sameAgent(base, agent({ usage: { ...u, cacheReadTokens: 9 } }))).toBe(false);
    expect(sameAgent(a, base)).toBe(false);
    expect(sameAgent(base, agent({ usage: { ...u, costUsd: 5 } }))).toBe(true);
  });
  it("只有 updatedAt / lastActivityAt 變（心跳）仍視為相同", () => {
    expect(sameAgent(a, agent({ updatedAt: NOW + 1, lastActivityAt: NOW + 1 }))).toBe(true);
  });
});

describe("store stalled 計時", () => {
  let store: Store;
  let events: StreamEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    store = new Store({ historyFile: null });
    events = [];
    store.subscribe((e) => events.push(e));
  });
  afterEach(() => {
    store.stopStallTimer();
    vi.useRealTimers();
  });

  const upserts = (): AgentState[] => events.filter((e) => e.type === "upsert").map((e) => (e as { agent: AgentState }).agent);

  it("working 且超過 STALL_MS 沒活動 → 計時器 tick 後推出 stalled: true", () => {
    store.startStallTimer();
    store.replaceSource("s", [agent({ state: "working", lastActivityAt: NOW })]);
    expect(upserts()).toHaveLength(1);
    expect(upserts()[0]?.stalled).toBeUndefined();

    vi.advanceTimersByTime(STALL_MS - STALL_CHECK_MS);
    expect(upserts()).toHaveLength(1);

    vi.advanceTimersByTime(STALL_CHECK_MS * 2);
    expect(upserts()).toHaveLength(2);
    expect(upserts()[1]?.stalled).toBe(true);

    // 之後沒有新變化就不重複推
    vi.advanceTimersByTime(STALL_CHECK_MS * 5);
    expect(upserts()).toHaveLength(2);
  });

  it("沒有 lastActivityAt 時用 updatedAt；idle 永遠不 stalled", () => {
    store.replaceSource("s", [agent({ id: "w", state: "working", updatedAt: NOW - STALL_MS - 1 }), agent({ id: "i", state: "idle", updatedAt: NOW - STALL_MS * 3 })]);
    const v = store.visible().agents;
    expect(v.find((a) => a.id === "w")?.stalled).toBe(true);
    expect(v.find((a) => a.id === "i")?.stalled).toBeUndefined();
  });

  it("有新活動後 stalled 解除（欄位消失，不是 false）", () => {
    store.startStallTimer();
    store.replaceSource("s", [agent({ state: "working", lastActivityAt: NOW - STALL_MS - 1 })]);
    expect(upserts().at(-1)?.stalled).toBe(true);
    store.replaceSource("s", [agent({ state: "working", lastActivityAt: Date.now() })]);
    const last = upserts().at(-1)!;
    expect(last.stalled).toBeUndefined();
    expect("stalled" in last).toBe(false);
  });

  it("臨時人力借 parent 的 lastActivityAt：parent 還在動就不算 stalled", () => {
    store.replaceSource("s", [
      agent({ id: "p", state: "working", lastActivityAt: NOW }),
      agent({ id: "c", kind: "transient", parent: "p", state: "working", updatedAt: NOW - STALL_MS * 2 }),
    ]);
    expect(store.visible().agents.find((a) => a.id === "c")?.stalled).toBeUndefined();
  });

  it("stopStallTimer 之後不再 tick", () => {
    store.startStallTimer();
    store.replaceSource("s", [agent({ state: "working", lastActivityAt: NOW })]);
    store.stopStallTimer();
    vi.advanceTimersByTime(STALL_MS * 2);
    expect(upserts()).toHaveLength(1);
  });
});

describe("store 寫歷史", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-store-"));
    file = join(dir, "history.jsonl");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const read = async (): Promise<Record<string, unknown>[]> =>
    (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it("進場、state 變化、離場各一筆；心跳與 detail 變動不記", async () => {
    const s = new Store({ historyFile: file });
    s.replaceSource("x", [agent({ state: "working", detail: "d1" })]);
    s.replaceSource("x", [agent({ state: "working", detail: "d2", updatedAt: NOW + 5 })]);
    s.replaceSource("x", [agent({ state: "waiting", waitingReason: "input" })]);
    s.replaceSource("x", []);
    const rows = await read();
    expect(rows.map((r) => [r.from, r.to])).toEqual([
      [null, "working"],
      ["working", "waiting"],
      ["waiting", null],
    ]);
    expect(rows[0]).not.toHaveProperty("detail"); // 歷史檔不存內容文字
  });

  it("寫檔失敗只 warn，不丟例外", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 路徑的父層是一個「檔案」→ mkdir/append 都會失敗
    const s = new Store({ historyFile: join(dir, "history.jsonl", "nope", "h.jsonl") });
    s.replaceSource("x", [agent()]);
    s.replaceSource("x", [agent()]);
    expect(() => s.replaceSource("x", [])).not.toThrow();
    warn.mockRestore();
  });
});

describe("stateSince", () => {
  let store: Store;
  let events: StreamEvent[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    store = new Store({ historyFile: null });
    events = [];
    store.subscribe((e) => events.push(e));
  });
  afterEach(() => vi.useRealTimers());
  const since = (): number | undefined => store.all()[0]?.stateSince;

  it("新進場設為進場時間；state 沒變就沿用，變了才重設", () => {
    store.replaceSource("s", [agent({ state: "working" })]);
    expect(since()).toBe(NOW);
    vi.setSystemTime(NOW + 5000);
    store.replaceSource("s", [agent({ state: "working", detail: "x", updatedAt: NOW + 5000 })]);
    expect(since()).toBe(NOW);
    vi.setSystemTime(NOW + 9000);
    store.replaceSource("s", [agent({ state: "waiting", waitingReason: "input" })]);
    expect(since()).toBe(NOW + 9000);
  });

  it("idle 新進場且有 lastActivityAt → 用 lastActivityAt；working 新進場不用", () => {
    store.replaceSource("s", [agent({ state: "idle", lastActivityAt: NOW - 60_000 })]);
    expect(since()).toBe(NOW - 60_000);
    store.replaceSource("s", []);
    store.replaceSource("s", [agent({ state: "working", lastActivityAt: NOW - 60_000 })]);
    expect(since()).toBe(NOW);
  });

  it("只有心跳（stateSince 沿用）不造成多餘推播", () => {
    store.replaceSource("s", [agent({ state: "working" })]);
    const n = events.length;
    vi.setSystemTime(NOW + 5000);
    store.replaceSource("s", [agent({ state: "working", updatedAt: NOW + 5000 })]);
    expect(events).toHaveLength(n);
  });
});

describe("跨日快照", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-mid-"));
    file = join(dir, "h.jsonl");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T23:59:00").getTime());
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });
  const rows = async (): Promise<Record<string, unknown>[]> =>
    (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

  it("午夜對當下所有 agent 各寫一筆 from===to 的事件，且之後每天重排；stop 後不再寫", async () => {
    const store = new Store({ historyFile: file });
    store.startMidnightTimer();
    store.replaceSource("s", [agent({ id: "claude:a", state: "working" }), agent({ id: "claude:b", state: "idle" })]);
    vi.advanceTimersByTime(61_000);
    const midnight = new Date("2026-10-07T00:00:00").getTime();
    let r = await rows();
    const snaps = r.filter((x) => x.from === x.to);
    expect(snaps.map((x) => `${String(x.id)}:${String(x.to)}`).sort()).toEqual(["claude:a:working", "claude:b:idle"]);
    expect(snaps).toHaveLength(2);
    for (const x of snaps) expect(x.ts as number).toBeGreaterThanOrEqual(midnight);

    vi.advanceTimersByTime(24 * 3_600_000);
    r = await rows();
    expect(r.filter((x) => x.from === x.to)).toHaveLength(4);

    store.stopMidnightTimer();
    vi.advanceTimersByTime(48 * 3_600_000);
    expect((await rows()).filter((x) => x.from === x.to)).toHaveLength(4);
  });

  it("起始：第一次回報的 agent 寫 from:null 進場事件", async () => {
    const store = new Store({ historyFile: file });
    store.replaceSource("s", [agent({ state: "working" })]);
    expect((await rows())[0]).toMatchObject({ from: null, to: "working" });
  });
});
