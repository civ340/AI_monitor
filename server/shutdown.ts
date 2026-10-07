/**
 * 要攔的結束訊號。Windows 上 SIGHUP（關主控台視窗）與 SIGBREAK（Ctrl+Break、部分關閉流程）
 * 都可能是唯一能攔到的機會；直接 kill /F 則完全攔不到（靠心跳檔補，見 heartbeat.ts）。
 */
export function shutdownSignals(platform: string = process.platform): NodeJS.Signals[] {
  const sigs: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  if (platform === "win32") sigs.push("SIGBREAK");
  return sigs;
}

/** 多個訊號同時來（或同一個訊號連按）只執行一次 shutdown */
export function createShutdownHandler(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () => (running ??= run());
}
