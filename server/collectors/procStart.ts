import { execFile } from "node:child_process";

/**
 * PID 回收偵測。Claude Code 的 session 檔有 procStart（Windows FILETIME，100ns 為單位的整數字串，
 * 實測與 Get-Process 的 StartTime.ToFileTimeUtc() 逐位相同）。session 崩潰後 Windows 可能把同一個 PID
 * 給別的程式，isAlive(pid) 就會對殘留檔說謊；procStart 與該 PID 現在實際的啟動時間不符＝不是同一個 process。
 *
 * 查實際啟動時間要起 PowerShell（貴），所以每個 pid 只查一次並快取；pid 死掉時呼叫 forget 清掉，
 * 之後同一個號碼被新 process 佔用才會重查。查不到（逾時、被擋）一律當作「符合」—— 無法判斷時
 * 寧可保留原本只看 isAlive 的行為，不能因為 PowerShell 出問題就把真的 session 全部踢掉。
 * 非 Windows 或格式不是 FILETIME 數字的 procStart 一律略過。
 */
export type ProcStartChecker = {
  matches(pid: number, procStart: unknown): Promise<boolean>;
  /** pid 已確認死亡或被回收：清掉快取，下次同號碼再出現會重查 */
  forget(pid: number): void;
};

/** 查不到時多久後才允許再試一次，避免每次掃描都起 PowerShell */
const RETRY_AFTER_MS = 60_000;
const QUERY_TIMEOUT_MS = 5_000;

type Entry = { value: string | null; at: number } | { pending: Promise<string | null> };

export function createProcStartChecker(
  query: (pid: number) => Promise<string | null>,
  platform: string = process.platform,
  now: () => number = Date.now,
): ProcStartChecker {
  const cache = new Map<number, Entry>();

  const lookup = async (pid: number): Promise<string | null> => {
    const hit = cache.get(pid);
    if (hit) {
      if ("pending" in hit) return hit.pending;
      if (hit.value !== null || now() - hit.at < RETRY_AFTER_MS) return hit.value;
    }
    const pending = query(pid).catch(() => null);
    cache.set(pid, { pending });
    const value = await pending;
    cache.set(pid, { value, at: now() });
    return value;
  };

  return {
    async matches(pid, procStart) {
      if (platform !== "win32") return true;
      if (typeof procStart !== "string" || !/^\d{15,20}$/.test(procStart)) return true;
      const actual = await lookup(pid);
      return actual === null || actual === procStart;
    },
    forget(pid) {
      cache.delete(pid);
    },
  };
}

/** Windows：用 PowerShell 取 process 啟動時間的 FILETIME（字串）。pid 不存在或失敗回 null */
export function queryProcStartWindows(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop).StartTime.ToFileTimeUtc()`],
      { timeout: QUERY_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        const out = String(stdout).trim();
        resolve(!err && /^\d{15,20}$/.test(out) ? out : null);
      },
    );
  });
}

export const defaultProcStartChecker: ProcStartChecker = createProcStartChecker(queryProcStartWindows);
