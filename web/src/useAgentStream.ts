import { create } from "zustand";
import type { AgentState, StreamEvent } from "@shared/types";

type ConnectionState = "connecting" | "live" | "lost";

type AgentStore = {
  agents: Record<string, AgentState>;
  overflow: number;
  connection: ConnectionState;
  apply: (ev: StreamEvent) => void;
  setConnection: (c: ConnectionState) => void;
};

export const useAgentStore = create<AgentStore>((set) => ({
  agents: {},
  overflow: 0,
  connection: "connecting",

  apply: (ev) =>
    set((s) => {
      switch (ev.type) {
        case "snapshot":
          return {
            agents: Object.fromEntries(ev.agents.map((a) => [a.id, a])),
            overflow: ev.overflow,
          };
        case "upsert":
          return { agents: { ...s.agents, [ev.agent.id]: ev.agent } };
        case "remove": {
          const { [ev.id]: _removed, ...rest } = s.agents;
          return { agents: rest };
        }
      }
    }),

  setConnection: (connection) => set({ connection }),
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
