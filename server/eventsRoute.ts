import type { FastifyInstance } from "fastify";
import type { AgentState, StreamEvent } from "@shared/types.js";
import type { ReadyGate } from "./ready.js";

/** /events 需要的 store 子集（測試可以塞假的） */
export type EventsStore = {
  visible(): { agents: AgentState[]; overflow: number };
  subscribe(fn: (ev: StreamEvent) => void): () => void;
};

/** SSE：先送 header 讓前端 EventSource 立刻 open，snapshot 等 collector 首輪完成（ready gate） */
export function registerEventsRoute(app: FastifyInstance, deps: { ready: ReadyGate; store: EventsStore }): void {
  const { ready, store } = deps;
  app.get("/events", (req, reply) => {
    // 自己管 raw stream
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    // writeHead 只是排隊；沒有 body 時 Node 不會真的送出。flush 之後 EventSource 才會在 ready 前就 open
    reply.raw.flushHeaders();

    const send = (ev: StreamEvent): void => {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };

    let unsubscribe: (() => void) | undefined;
    let closed = false;
    // 過代理時保活，避免閒置連線被切
    const keepAlive = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);

    req.raw.on("close", () => {
      closed = true;
      clearInterval(keepAlive);
      unsubscribe?.();
    });

    void ready.wait().then(() => {
      if (closed) return;
      // 取 snapshot 與 subscribe 之間不能有 await，才不會漏掉中間的事件
      const { agents, overflow } = store.visible();
      send({ type: "snapshot", agents, overflow });
      unsubscribe = store.subscribe(send);
    });
  });
}
