import { describe, it, expect, vi, afterEach } from "vitest";
import { createReadyGate } from "@server/ready.js";

describe("createReadyGate：collector 首輪完成前先不送 snapshot", () => {
  afterEach(() => vi.useRealTimers());

  it("markReady 前 wait() 不 resolve；markReady 後 resolve；之後立即 resolve", async () => {
    const g = createReadyGate(5_000);
    let done = false;
    void g.wait().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    g.markReady();
    await g.wait();
    await new Promise((r) => setImmediate(r));
    expect(done).toBe(true);
    expect(g.isReady()).toBe(true);
  });

  it("沒 ready 也不會卡死：超過上限就放行", async () => {
    vi.useFakeTimers();
    const g = createReadyGate(5_000);
    let done = false;
    void g.wait().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });
});
