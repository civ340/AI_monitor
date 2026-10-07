import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 心跳檔：server 每分鐘把「我還活著」的時間寫進來。
 *
 * Windows 上直接 kill、關主控台視窗不會觸發任何 signal handler，所以常態是「沒有離場事件」。
 * 下次啟動讀這個檔，就知道上一輪最後存活到什麼時候（server-start 標記的 lastAliveAt），
 * 摘要與時間軸才能把開著的段落結在那裡，而不是結在「最後一筆事件」（會抹掉整段真實工作時間）。
 * 檔案只有一個時間戳，不含任何內容文字。
 */
export const HEARTBEAT_FILE = fileURLToPath(new URL("../.data/heartbeat.json", import.meta.url));
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** 讀不到、壞檔、欄位不對一律回 undefined（呼叫端退回舊行為） */
export function readHeartbeat(file: string): number | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { ts?: unknown } | null;
    const ts = raw?.ts;
    return typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? ts : undefined;
  } catch {
    return undefined;
  }
}

/** 覆寫小檔：先寫暫存檔再 rename，避免讀到半截；失敗只 warn */
export function writeHeartbeat(file: string, ts: number): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ts }));
    renameSync(tmp, file);
  } catch (err) {
    console.warn("[heartbeat] 寫入失敗:", err);
  }
}

/** 立刻寫一次，之後每個間隔寫一次。計時器 unref，不會擋住 process 結束 */
export function startHeartbeat(
  file: string,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
  now: () => number = Date.now,
): { stop(): void } {
  writeHeartbeat(file, now());
  const timer = setInterval(() => writeHeartbeat(file, now()), intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
