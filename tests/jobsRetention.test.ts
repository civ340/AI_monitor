import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "@shared/types.js";
import { claudeJobsCollector, ERROR_KEEP_MS } from "@server/collectors/claudeJobs.js";
import { codexJobsCollector, ERROR_KEEP_MS as CODEX_ERROR_KEEP_MS } from "@server/collectors/codexJobs.js";

const NOW = new Date("2026-10-06T12:00:00Z").getTime();

/** setTimeout 被 fake 了，真實的檔案 IO 要靠 setImmediate 輪詢等它完成 */
async function waitForEmits(emits: unknown[], count: number): Promise<void> {
  for (let i = 0; i < 5000 && emits.length < count; i++) await new Promise((r) => setImmediate(r));
}

describe("error job 保留期過後會自己離場（不需要任何檔案事件）", () => {
  let root: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    root = await mkdtemp(join(tmpdir(), "aimon-retain-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it("claude-jobs：failed job 在 ERROR_KEEP_MS 後被重掃移除", async () => {
    const dir = join(root, "abc123");
    await mkdir(dir);
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({ state: "failed", detail: "壞了", updatedAt: new Date(NOW - 10_000).toISOString() }),
    );
    const emits: AgentState[][] = [];
    const c = claudeJobsCollector(root);
    await c.start((a) => emits.push(a));
    expect(emits.at(-1)?.map((a) => a.state)).toEqual(["error"]);

    const before = emits.length;
    vi.advanceTimersByTime(ERROR_KEEP_MS + 5_000);
    await waitForEmits(emits, before + 1);
    expect(emits.at(-1)).toEqual([]);
    await c.stop();
  });

  it("codex plugin：failed job 在 ERROR_KEEP_MS 後被重掃移除；stop() 清掉計時器", async () => {
    const dir = join(root, "proj-1");
    await mkdir(dir);
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({ jobs: [{ id: "j1", status: "failed", summary: "掛了", updatedAt: new Date(NOW - 10_000).toISOString() }] }),
    );
    const emits: AgentState[][] = [];
    const c = codexJobsCollector(root);
    await c.start((a) => emits.push(a));
    expect(emits.at(-1)?.some((a) => a.state === "error")).toBe(true);

    const before = emits.length;
    vi.advanceTimersByTime(CODEX_ERROR_KEEP_MS + 5_000);
    await waitForEmits(emits, before + 1);
    expect(emits.at(-1)?.some((a) => a.state === "error")).toBe(false);

    // stop() 之後不再有任何重掃
    await c.stop();
    const after = emits.length;
    vi.advanceTimersByTime(24 * 3_600_000);
    for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
    expect(emits.length).toBe(after);
  });
});

/** 追蹤「保留期到期」那種長計時器（> 10 秒）是否被 clearTimeout 清掉；避開 chokidar 內部的短計時器 */
function trackLongTimers() {
  const handles: unknown[] = [];
  const clearedSet = new Set<unknown>();
  const st = globalThis.setTimeout;
  const ct = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    const h = (st as (...a: unknown[]) => unknown)(fn, ms, ...rest);
    if ((ms ?? 0) > 10_000) handles.push(h);
    return h;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((h: unknown) => {
    clearedSet.add(h);
    return (ct as (h: unknown) => void)(h);
  }) as typeof clearTimeout;
  return {
    handles,
    cleared: (h: unknown) => clearedSet.has(h),
    restore: () => {
      globalThis.setTimeout = st;
      globalThis.clearTimeout = ct;
    },
  };
}

describe("stop() 會清掉已排程的 expiryTimer", () => {
  let root: string;
  let long: ReturnType<typeof trackLongTimers>;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    root = await mkdtemp(join(tmpdir(), "aimon-stop-"));
    long = trackLongTimers();
  });
  afterEach(async () => {
    long.restore();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it("claude-jobs：start 後有計時器排程；stop 後計時器數量歸零", async () => {
    const dir = join(root, "abc123");
    await mkdir(dir);
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({ state: "failed", detail: "x", updatedAt: new Date(NOW - 10_000).toISOString() }),
    );
    const c = claudeJobsCollector(root);
    await c.start(() => {});
    expect(long.handles).toHaveLength(1);
    await c.stop();
    expect(long.cleared(long.handles[0])).toBe(true);
  });

  it("codex-jobs：同上", async () => {
    const dir = join(root, "proj-1");
    await mkdir(dir);
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({ jobs: [{ id: "j1", status: "failed", summary: "x", updatedAt: new Date(NOW - 10_000).toISOString() }] }),
    );
    const c = codexJobsCollector(root);
    await c.start(() => {});
    expect(long.handles).toHaveLength(1);
    await c.stop();
    expect(long.cleared(long.handles[0])).toBe(true);
  });
});
