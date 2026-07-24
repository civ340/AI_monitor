import type { AgentState, StreamEvent } from "@shared/types.js";

/** 畫面容量：超過的 transient 不上場，只計入 overflow */
const MAX_TRANSIENT = 4;

type Listener = (ev: StreamEvent) => void;

/**
 * 記憶體狀態。不落地 —— 監控看的是當下，重啟從各 agent 的狀態檔重建即可。
 * 每個 collector 交出的是「該來源目前的完整清單」，store 負責跟上一輪 diff。
 */
class Store {
  private bySource = new Map<string, Map<string, AgentState>>();
  private listeners = new Set<Listener>();
  /** 上一次實際推給前端的上場名單，publish() 的 diff 基準 */
  private lastSent = new Map<string, AgentState>();
  private lastOverflow = 0;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(ev: StreamEvent): void {
    for (const fn of this.listeners) fn(ev);
  }

  /**
   * collector 回報該來源的完整清單。
   *
   * diff 一律以 visible() 的結果為基準，不是原始清單 —— 否則超出上限的 transient
   * 會經由 upsert 溜到前端，而 overflow 因為只在 snapshot 帶，會停在舊值。
   */
  replaceSource(source: string, agents: AgentState[]): void {
    this.bySource.set(source, new Map(agents.map((a) => [a.id, a])));
    this.publish();
  }

  /** 把「目前該上場的人」與上一次推播的狀態比對，只推真正變動的部分 */
  private publish(): void {
    const { agents, overflow } = this.visible();
    const next = new Map(agents.map((a) => [a.id, a]));

    for (const [id, agent] of next) {
      const before = this.lastSent.get(id);
      if (!before || !sameAgent(before, agent)) this.emit({ type: "upsert", agent });
    }
    for (const id of this.lastSent.keys()) {
      if (!next.has(id)) this.emit({ type: "remove", id });
    }

    // overflow 沒有自己的事件型別，變動時補一份 snapshot 讓「還有 N 位在加班」跟上
    if (overflow !== this.lastOverflow) {
      this.emit({ type: "snapshot", agents, overflow });
      this.lastOverflow = overflow;
    }

    this.lastSent = next;
  }

  /** 全部 agent，resident 優先排前面 */
  all(): AgentState[] {
    const out: AgentState[] = [];
    for (const m of this.bySource.values()) out.push(...m.values());
    return out.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "resident" ? -1 : 1,
    );
  }

  /** 上場名單 + 溢出人數，避免房間被 subagent 塞爆 */
  visible(): { agents: AgentState[]; overflow: number } {
    const all = this.all();
    const residents = all.filter((a) => a.kind === "resident");
    const transients = all.filter((a) => a.kind === "transient");
    return {
      agents: [...residents, ...transients.slice(0, MAX_TRANSIENT)],
      overflow: Math.max(0, transients.length - MAX_TRANSIENT),
    };
  }
}

/** updatedAt 之外的欄位有沒有實質變動 —— 只是心跳就不用推播 */
function sameAgent(a: AgentState, b: AgentState): boolean {
  return (
    a.state === b.state &&
    a.detail === b.detail &&
    a.name === b.name &&
    a.tasks.length === b.tasks.length &&
    a.tasks.every((t, i) => {
      const o = b.tasks[i];
      return o !== undefined && t.id === o.id && t.status === o.status && t.progress === o.progress;
    })
  );
}

export const store = new Store();
