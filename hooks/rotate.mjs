/**
 * hooks/record.mjs 的 rotate。獨立成檔是為了能單獨測試（record.mjs 一載入就會讀 stdin）。
 * 零相依、不碰 stdin；任何錯誤都吞掉，絕不能讓 hook 失敗。
 */
import { appendFileSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";

/**
 * 檔案超過 maxBytes 就轉成 out + ".1"（只保留一份舊檔）。
 *
 * 競態：兩支 hook 同時看到「檔案太大」時，如果各自直接 rename(out, out.1)，
 * 第二支會把第一支剛 rotate 完、已經開始累積新內容的新檔搬去蓋掉 .1 —— 舊內容整份消失。
 * 所以改成：先 rename 成帶 pid + 時間戳的暫名（rename 是原子的，兩支不會搬到同一個檔），
 * 搬完再量一次大小。真的是大檔才換成 .1；量出來是小的，代表搬到的是別人剛開的新檔，
 * 把內容接回 out、刪掉暫名即可（每筆事件是單行 append，接回頂多是行序略有不同）。
 *
 * stat 參數只用在第一次「要不要 rotate」的預檢，測試用來模擬「預檢時看到大檔、動手前被別人 rotate 掉」。
 */
export function rotateIfNeeded(out, maxBytes, stat = statSync) {
  try {
    if (stat(out).size <= maxBytes) return;
  } catch {
    return; // 檔案還不存在
  }
  const tmp = `${out}.rot-${process.pid}-${Date.now()}`;
  try {
    renameSync(out, tmp);
  } catch {
    return; // 檔案已被另一支 hook 搬走，或 rename 失敗：不擋寫入
  }
  try {
    if (statSync(tmp).size > maxBytes) {
      renameSync(tmp, out + ".1");
    } else {
      // 搬到的是別人剛 rotate 完開的新檔：還回去
      appendFileSync(out, readFileSync(tmp));
      unlinkSync(tmp);
    }
  } catch {
    // 最壞情況留下一個暫名檔，不影響寫入
  }
}
