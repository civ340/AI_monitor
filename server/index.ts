import Fastify from "fastify";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { HistoryEvent, StateSnapshot, TodaySummary } from "@shared/types.js";
import { store } from "./store.js";
import { computeTodaySummary, HISTORY_FILE, HISTORY_LIMIT, readHistory, readTodayEvents, startOfToday } from "./history.js";
import { startCollectors, stopCollectors } from "./collectors/index.js";
import { registerOpenRoute } from "./openCwd.js";
import { createReadyGate } from "./ready.js";
import { registerEventsRoute } from "./eventsRoute.js";
import { HEARTBEAT_FILE, readHeartbeat, startHeartbeat } from "./heartbeat.js";
import { createShutdownHandler, shutdownSignals } from "./shutdown.js";

const PORT = 4321;
/** 這頁會顯示跨專案的工作內容，只綁 loopback，絕不對外 */
const HOST = "127.0.0.1";
/** vite dev server 的 port，須與 vite.config.ts 的 server.port（5173）一致 */
const VITE_DEV_PORT = 5173;

/**
 * collector 首輪 emit 沒完成前，/events 與 /api/state 先不送 snapshot：
 * 否則前端會看到一份不完整的名單（角色整批離場再進場、狀態跳動而重發通知）。
 * 上限 5 秒，避免某個 collector 卡住就整個服務不出資料。
 */
const READY_MAX_WAIT_MS = 5_000;
const ready = createReadyGate(READY_MAX_WAIT_MS);

const app = Fastify({ logger: { transport: undefined, level: "warn" } });

app.get("/api/state", async (): Promise<StateSnapshot> => {
  await ready.wait();
  const { agents, overflow } = store.visible();
  return { agents, overflow, serverTime: Date.now() };
});

/** since 必須是非負整數（epoch ms）；沒給就用本地今天 00:00。不合法回 null */
function parseSince(q: unknown): number | null {
  if (q === undefined) return startOfToday();
  if (typeof q !== "string" || !/^\d{1,16}$/.test(q)) return null;
  return Number(q);
}

app.get("/api/history", async (req, reply): Promise<HistoryEvent[] | { error: string }> => {
  const since = parseSince((req.query as { since?: unknown }).since);
  if (since === null) {
    reply.code(400);
    return { error: "since must be a number (epoch ms)" };
  }
  // 今天的走記憶體快取；更早的才讀檔（非同步，不擋 event loop）。回應仍有筆數上限
  if (since >= startOfToday()) {
    return (await readTodayEvents(HISTORY_FILE)).filter((e) => e.ts >= since).slice(-HISTORY_LIMIT);
  }
  return readHistory(HISTORY_FILE, since);
});

app.get("/api/summary/today", async (): Promise<TodaySummary> => {
  const now = Date.now();
  const since = startOfToday(now);
  // 摘要吃完整的今日事件（不套 /api/history 的筆數上限）
  return computeTodaySummary(await readTodayEvents(HISTORY_FILE, now), store.all(), since, now);
});

// 點角色 → 本機開啟該 agent 的工作目錄。安全設計見 server/openCwd.ts 檔頭。
// Host 白名單只放 collector 自己的 port：vite dev proxy 會把 Host 改寫成 127.0.0.1:4321。
registerOpenRoute(app, {
  lookup: (id) => store.all().find((a) => a.id === id),
  fs: { realpath, stat },
  spawn,
  platform: process.platform,
  env: process.env,
  allowedPorts: [PORT],
  // Origin：production 由本服務直接 serve 前端（PORT），dev 由 vite 頁面發出（VITE_DEV_PORT）
  allowedOriginPorts: [PORT, VITE_DEV_PORT],
});

registerEventsRoute(app, { ready, store });

// build 之後才有靜態檔；dev 時走 vite dev server
const publicDir = fileURLToPath(new URL("./public", import.meta.url));
if (existsSync(publicDir)) {
  const { default: fastifyStatic } = await import("@fastify/static");
  await app.register(fastifyStatic, { root: publicDir });
} else {
  console.warn("[static] 尚未 build，本服務只提供 API；前端請跑 npm run dev:web");
}

let heartbeat: { stop(): void } | undefined;
const shutdown = createShutdownHandler(async (): Promise<void> => {
  heartbeat?.stop();
  // 先同步把「所有 agent 離場」寫進歷史，確保在 exit 前落地；之後 store 不再寫歷史
  store.recordShutdown();
  store.stopStallTimer();
  store.stopMidnightTimer();
  await stopCollectors();
  await app.close();
  process.exit(0);
});
// Windows 上直接 kill／關主控台不一定觸發這些（SIGHUP、SIGBREAK 是少數能攔到的）；攔不到的靠心跳檔補
for (const sig of shutdownSignals()) process.on(sig, () => void shutdown());

// 先寫 server-start 標記：消費端用它處理「上次被強制結束、沒來得及寫離場」的情況
// 上一輪最後存活的時間（心跳檔）要在開始新的心跳之前讀
store.recordServerStart(Date.now(), readHeartbeat(HEARTBEAT_FILE));
heartbeat = startHeartbeat(HEARTBEAT_FILE);
store.startStallTimer();
store.startMidnightTimer();
// 先 listen 再起 collector：collector 的首次掃描（含 transcript 初讀）不該擋住服務上線，
// 資料到了會經 store 推播給已連上的前端（/events 與 /api/state 會等 ready 才送 snapshot）。
await app.listen({ port: PORT, host: HOST });
console.log(`[ai-monitor] collector service → http://${HOST}:${PORT}`);
await startCollectors();
ready.markReady();
