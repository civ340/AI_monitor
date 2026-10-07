/** 顯示用的數字／路徑格式化。純函式，方便單元測試。 */

/** 1234 → "1.2K"、1_234_567 → "1.2M"。壞值（NaN／負數／undefined）一律當 0 */
export function fmtTokens(n: number | undefined): string {
  const v = typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [base, suffix] of units) {
    if (v >= base) {
      const x = v / base;
      // 99.96K 四捨五入會變 "100.0K"，十位數以上不留小數
      return `${x >= 99.95 ? Math.round(x) : x.toFixed(1)}${suffix}`;
    }
  }
  return String(Math.round(v));
}

/** 12.3456 → "$12.35"；有花錢但不到 1 分 → "<$0.01"；沒有值 → "—" */
export function fmtUsd(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${Math.max(0, n).toFixed(2)}`;
}

/** 毫秒 → "2 小時 5 分"／"7 分"／"<1 分" */
export function fmtDuration(ms: number | undefined): string {
  const v = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
  const min = Math.floor(v / 60_000);
  if (min < 1) return v > 0 ? "<1 分" : "0 分";
  const h = Math.floor(min / 60);
  return h > 0 ? `${h} 小時 ${min % 60} 分` : `${min} 分`;
}

/** cwd 只顯示最後一段資料夾名（Windows 與 POSIX 路徑都吃）；沒有就回空字串 */
export function projectName(cwd: string | undefined): string {
  if (!cwd) return "";
  const parts = cwd.split(/[\\/]+/).filter((p) => p !== "");
  const last = parts[parts.length - 1] ?? "";
  // "C:" 這種只剩磁碟機代號的當作沒有名字
  return /^[A-Za-z]:$/.test(last) ? "" : last;
}

/** context 使用率 0–1；缺 usage 或上限時回 undefined（不畫能量條） */
export function contextRatio(
  u: { contextTokens?: number; contextLimit?: number } | undefined,
): number | undefined {
  if (!u || !u.contextTokens || !u.contextLimit || u.contextLimit <= 0) return undefined;
  return Math.min(1, Math.max(0, u.contextTokens / u.contextLimit));
}
