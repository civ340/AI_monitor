import { describe, it, expect, beforeEach } from "vitest";
import type { AgentState } from "@shared/types";
import { useAgentStore } from "../web/src/useAgentStream";
import { alertsForChange } from "../web/src/logic/notify";

const agent = (p: Partial<AgentState> = {}): AgentState => ({
  id: "claude:a",
  kind: "resident",
  name: "n",
  state: "idle",
  tasks: [],
  updatedAt: 0,
  ...p,
});

/** 套一個事件，回傳 [prev, next] 兩份 store 狀態（對應 alerts.ts 的 subscribe 回呼） */
function applyAndDiff(ev: Parameters<ReturnType<typeof useAgentStore.getState>["apply"]>[0]) {
  const prev = useAgentStore.getState();
  prev.apply(ev);
  return { prev, next: useAgentStore.getState() };
}

describe("重連後第一份 snapshot 只同步、不觸發通知（item 5b）", () => {
  beforeEach(() => {
    useAgentStore.setState({ agents: {}, overflow: 0, connection: "connecting", hydrated: false, fresh: true, silentSync: 0 });
  });

  it("第一次連線的 snapshot：不通知", () => {
    const { prev, next } = applyAndDiff({
      type: "snapshot",
      agents: [agent({ state: "waiting", waitingReason: "permission" })],
      overflow: 0,
    });
    expect(alertsForChange(prev, next)).toEqual([]);
  });

  it("連線中途 working → upsert waiting：照常通知", () => {
    applyAndDiff({ type: "snapshot", agents: [agent({ state: "working" })], overflow: 0 });
    const { prev, next } = applyAndDiff({ type: "upsert", agent: agent({ state: "waiting", waitingReason: "permission" }) });
    expect(alertsForChange(prev, next)).toEqual([{ agent: expect.objectContaining({ id: "claude:a" }), kind: "permission" }]);
  });

  it("斷線重連後的第一份 snapshot（working 變 waiting permission）：不通知；之後的轉換照常", () => {
    applyAndDiff({ type: "snapshot", agents: [agent({ state: "working" })], overflow: 0 });
    useAgentStore.getState().setConnection("lost"); // server 重啟：連線斷掉
    const resync = applyAndDiff({
      type: "snapshot",
      agents: [agent({ state: "waiting", waitingReason: "permission" })],
      overflow: 0,
    });
    expect(alertsForChange(resync.prev, resync.next)).toEqual([]);
    expect(useAgentStore.getState().agents["claude:a"]?.state).toBe("waiting"); // 狀態有同步到

    // 之後 waiting → working → waiting 的真轉換要通知
    applyAndDiff({ type: "upsert", agent: agent({ state: "working" }) });
    const later = applyAndDiff({ type: "upsert", agent: agent({ state: "waiting", waitingReason: "permission" }) });
    expect(alertsForChange(later.prev, later.next)).toHaveLength(1);
  });

  it("連線中途因 overflow 變動而推的 snapshot 不是重連同步：差異照常通知", () => {
    applyAndDiff({ type: "snapshot", agents: [agent({ state: "working" })], overflow: 0 });
    const { prev, next } = applyAndDiff({
      type: "snapshot",
      agents: [agent({ state: "waiting", waitingReason: "permission" })],
      overflow: 2,
    });
    expect(alertsForChange(prev, next)).toHaveLength(1);
  });

  it("重連後的第一份 snapshot 之外的 snapshot 不再靜音（只靜音一次）", () => {
    applyAndDiff({ type: "snapshot", agents: [], overflow: 0 });
    useAgentStore.getState().setConnection("lost");
    applyAndDiff({ type: "snapshot", agents: [agent({ state: "working" })], overflow: 0 });
    const { prev, next } = applyAndDiff({
      type: "snapshot",
      agents: [agent({ state: "waiting", waitingReason: "permission" })],
      overflow: 1,
    });
    expect(alertsForChange(prev, next)).toHaveLength(1);
  });
});
