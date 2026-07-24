/**
 * 檢查 pid 是否還活著。
 *
 * 各家 agent 的狀態檔都有同一個毛病：process 被強制中止時來不及寫回終態，
 * 檔案會永遠停在 running/busy。實測就有一個 2026-07-10 的 codex job
 * 至今仍宣稱 running。所以「檔案說它在跑」永遠要再問一次作業系統。
 */
export function isAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    // signal 0 只做存在性檢查，不會真的送訊號
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM＝process 存在但沒權限查，仍算活著；ESRCH 才是真的不在了
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
