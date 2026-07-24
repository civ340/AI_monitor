import { describe, it, expect } from "vitest";
import { deriveState, toAgent, type CodexJob } from "@server/collectors/codexJobs.js";

describe("codexJobs deriveState", () => {
  it("宣稱 running 且 pid 存活 → working", () => {
    expect(deriveState({ status: "running", pid: process.pid })).toBe("working");
  });

  it("宣稱 running 但 pid 已死 → offline（殭屍過濾）", () => {
    // Codex 對抗性審查 [medium] 的根因：job 被強制中止時 state.json 停在 running，
    // pid 早就不存在。不向 OS 確認就會讓殭屍永遠占著工位
    expect(deriveState({ status: "running", pid: 2_000_000_000 })).toBe("offline");
  });

  it("phase running 但沒有存活 pid → offline", () => {
    expect(deriveState({ phase: "running", pid: null })).toBe("offline");
  });

  it("failed → idle", () => {
    expect(deriveState({ status: "failed", pid: null })).toBe("idle");
  });

  it("completed → offline", () => {
    expect(deriveState({ status: "completed", pid: null })).toBe("offline");
  });
});

describe("toAgent 跨專案 id 唯一性", () => {
  // Codex 對抗性審查 [medium]：job.id 只在專案內唯一，攤平後同名 id 會互相覆蓋
  const job: CodexJob = {
    id: "review-abc123",
    status: "running",
    pid: process.pid,
    summary: "審查結論",
  };

  it("同一個 job.id 在不同專案產生不同的 AgentState.id", () => {
    const a = toAgent(job, "project-a");
    const b = toAgent(job, "project-b");
    expect(a?.id).toBe("codex:project-a/review-abc123");
    expect(b?.id).toBe("codex:project-b/review-abc123");
    expect(a?.id).not.toBe(b?.id);
  });

  it("沒有 id 的 job 回傳 null", () => {
    expect(toAgent({ status: "running" }, "project-a")).toBeNull();
  });

  it("transient 且 parent 指向合成的 Codex 常駐節點", () => {
    const a = toAgent(job, "project-a");
    expect(a?.kind).toBe("transient");
    expect(a?.parent).toBe("codex:main");
  });
});
