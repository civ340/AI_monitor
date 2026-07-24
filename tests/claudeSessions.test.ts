import { describe, it, expect } from "vitest";
import { deriveState } from "@server/collectors/claudeSessions.js";

const now = Date.now();

describe("claudeSessions deriveState", () => {
  it("busy 且心跳新鮮 → working", () => {
    expect(deriveState("busy", now)).toBe("working");
  });

  it("busy 但心跳超過 5 分鐘 → 不再採信 busy（落回時間判定，此處為 idle）", () => {
    // Codex 對抗性審查 [medium]：PID 重用會讓殘留 busy 檔永遠顯示在跑，
    // 靠心跳時效戳破它 —— 真正在忙的 session 心跳遠比 5 分鐘頻繁。
    // 過了 5min busy 保鮮但未過 10min offline 線，判為 idle。
    const stale = now - 6 * 60_000;
    expect(deriveState("busy", stale)).toBe("idle");
  });

  it("busy 但心跳超過 10 分鐘 → offline（殭屍最終會離場）", () => {
    const stale = now - 11 * 60_000;
    expect(deriveState("busy", stale)).toBe("offline");
  });

  it("非 busy 且心跳新鮮 → idle", () => {
    expect(deriveState("idle", now)).toBe("idle");
  });

  it("非 busy 且超過 10 分鐘 → offline", () => {
    expect(deriveState("idle", now - 11 * 60_000)).toBe("offline");
  });
});
