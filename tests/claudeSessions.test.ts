import { describe, it, expect } from "vitest";
import { BUSY_TRUST_MS, deriveState } from "@server/collectors/claudeSessions.js";

const now = Date.now();
const MIN = 60_000;

describe("claudeSessions deriveState（pid 已確認存活後，Claude Code 自己寫的 status 直接採用）", () => {
  it("busy 且活動新鮮 → working", () => {
    expect(deriveState("busy", now)).toBe("working");
  });

  it("busy 但 updatedAt 很舊、lastActivityAt 新鮮（transcript 還在寫）→ working", () => {
    expect(deriveState("busy", now - 2 * 3_600_000, now - MIN)).toBe("working");
  });

  it("busy 且 updatedAt 與 lastActivityAt 都超過信任期 → idle（PID 被回收的殘留檔），不是 offline", () => {
    expect(deriveState("busy", now - BUSY_TRUST_MS - MIN, now - BUSY_TRUST_MS - MIN)).toBe("idle");
  });

  it("busy 信任期必須比 stalled 門檻（10 分鐘）長，stalled 才有機會成立", () => {
    expect(BUSY_TRUST_MS).toBeGreaterThan(10 * MIN);
    // 20 分鐘沒活動的 busy：仍是 working（交給 store 判 stalled）
    expect(deriveState("busy", now - 20 * MIN, now - 20 * MIN)).toBe("working");
  });

  it("waiting 無論多久都是 waiting（pid 活著就不因 updatedAt 舊而消失）", () => {
    expect(deriveState("waiting", now - 5 * 3_600_000)).toBe("waiting");
  });

  it("idle 多久都是 idle，不會變 offline", () => {
    expect(deriveState("idle", now)).toBe("idle");
    expect(deriveState("idle", now - 11 * MIN)).toBe("idle");
    expect(deriveState("idle", now - 24 * 3_600_000)).toBe("idle");
  });

  it("沒有 status／未知 status → idle", () => {
    expect(deriveState(undefined, now)).toBe("idle");
    expect(deriveState("???", now)).toBe("idle");
  });
});
