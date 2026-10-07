import { create } from "zustand";
import type { AgentState, StreamEvent } from "@shared/types";

type ConnectionState = "connecting" | "live" | "lost";

type AgentStore = {
  agents: Record<string, AgentState>;
  overflow: number;
  connection: ConnectionState;
  /** 收過第一份 snapshot 了。通知用它區分「剛開頁面載入的既有狀態」與「真的發生的轉換」 */
  hydrated: boolean;
  /**
   * 尚未收到「這次連線」的第一份 snapshot（初始、或連線斷掉之後）。
   * 這份 snapshot 只用來同步狀態：server 重啟期間的狀態變化不是「剛發生的轉換」，不該重發通知與提示音。
   */
  fresh: boolean;
  /** 「只同步、不通知」的 snapshot 套用次數；alerts 看到它變動就整批略過（見 logic/notify.ts alertsForChange） */
  silentSync: number;
  apply: (ev: StreamEvent) => void;
  setConnection: (c: ConnectionState) => void;
};

export const useAgentStore = create<AgentStore>((set) => ({
  agents: {},
  overflow: 0,
  connection: "connecting",
  hydrated: false,
  fresh: true,
  silentSync: 0,

  apply: (ev) =>
    set((s) => {
      switch (ev.type) {
        case "snapshot":
          return {
            agents: Object.fromEntries(ev.agents.map((a) => [a.id, a])),
            overflow: ev.overflow,
            hydrated: true,
            fresh: false,
            silentSync: s.fresh ? s.silentSync + 1 : s.silentSync,
          };
        case "upsert":
          return { agents: { ...s.agents, [ev.agent.id]: ev.agent } };
        case "remove": {
          const { [ev.id]: _removed, ...rest } = s.agents;
          return { agents: rest };
        }
      }
    }),

  // 斷線＝下一份 snapshot 是重新同步，不是轉換
  setConnection: (connection) => set((s) => (connection === "lost" ? { connection, fresh: true } : s.connection === connection ? s : { connection })),
}));

/** 掛一次就好，放在 App 最外層。EventSource 斷線會自動重連 */
export function connectAgentStream(): () => void {
  const { apply, setConnection } = useAgentStore.getState();
  const es = new EventSource("/events");

  es.onopen = () => setConnection("live");
  es.onerror = () => setConnection("lost");
  es.onmessage = (e) => {
    try {
      apply(JSON.parse(e.data) as StreamEvent);
      setConnection("live");
    } catch {
      // 壞掉的一筆不該斷掉整條連線
    }
  };

  return () => es.close();
}

/** resident 在前、transient 在後，順序穩定避免角色亂跳 */
export function useAgentList(): AgentState[] {
  const agents = useAgentStore((s) => s.agents);
  return Object.values(agents).sort((a, b) =>
    a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "resident" ? -1 : 1,
  );
}
