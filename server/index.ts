import Fastify from "fastify";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { StateSnapshot, StreamEvent } from "@shared/types.js";
import { store } from "./store.js";
import { startCollectors, stopCollectors } from "./collectors/index.js";

const PORT = 4321;
/** 這頁會顯示跨專案的工作內容，只綁 loopback，絕不對外 */
const HOST = "127.0.0.1";

const app = Fastify({ logger: { transport: undefined, level: "warn" } });

app.get("/api/state", async (): Promise<StateSnapshot> => {
  const { agents, overflow } = store.visible();
  return { agents, overflow, serverTime: Date.now() };
});

app.get("/events", (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const send = (ev: StreamEvent): void => {
    reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  const { agents, overflow } = store.visible();
  send({ type: "snapshot", agents, overflow });

  const unsubscribe = store.subscribe(send);
  // 過代理時保活，避免閒置連線被切
  const keepAlive = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);

  req.raw.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

// build 之後才有靜態檔；dev 時走 vite dev server
const publicDir = fileURLToPath(new URL("./public", import.meta.url));
if (existsSync(publicDir)) {
  const { default: fastifyStatic } = await import("@fastify/static");
  await app.register(fastifyStatic, { root: publicDir });
} else {
  console.warn("[static] 尚未 build，本服務只提供 API；前端請跑 npm run dev:web");
}

const shutdown = async (): Promise<void> => {
  await stopCollectors();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await startCollectors();
await app.listen({ port: PORT, host: HOST });
console.log(`[ai-monitor] collector service → http://${HOST}:${PORT}`);
