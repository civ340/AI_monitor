import { mkdir, open, stat } from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";

/**
 * append-only jsonl 的增量讀取 + 資料目錄 watch，給 claudeSubagents / sessionEvents / transcript 用量共用。
 * （原本寫在 claudeSubagents.ts，抽出來避免 claudeSessions ↔ claudeSubagents 循環引用。）
 */

/**
 * carry 故意存 Buffer 而不是字串 —— 一個多位元組字元（例如中文）有機率被切在兩次
 * read 之間，這時 half 的 bytes 各自 toString("utf8") 都會產生替代字元（U+FFFD）
 * 把資料弄壞。只在湊齊一整行的 bytes 之後才 decode，就不會有這個問題。
 */
export type ReadState = { offset: number; carry: Buffer };

export function createReadState(): ReadState {
  return { offset: 0, carry: Buffer.alloc(0) };
}

/** 把新讀到的 bytes 接上 carry，依 0x0A（換行）切出完整行，剩下的半截留給下次 */
export function splitCompleteLines(carry: Buffer, chunk: Buffer): { lines: string[]; carry: Buffer } {
  const combined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < combined.length; i++) {
    if (combined[i] === 0x0a) {
      const text = combined.subarray(start, i).toString("utf8");
      if (text.trim() !== "") lines.push(text);
      start = i + 1;
    }
  }
  return { lines, carry: combined.subarray(start) };
}

export async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const len = end - start;
    const buf = Buffer.alloc(len);
    if (len > 0) await handle.read(buf, 0, len, start);
    return buf;
  } finally {
    await handle.close();
  }
}

/**
 * 讀出檔案裡「上次讀完之後新增的內容」，只回傳湊成完整一行的部分——
 * 沒寫完的尾巴留在 rs.carry，下次跟新資料接起來再切。
 *
 * append-only log 的標準讀法：整份重讀一次成本隨檔案增長，長跑的 session 撐不住。
 */
export async function readAppendedLines(path: string, rs: ReadState): Promise<string[]> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    // 檔案還不存在，還沒有任何 subagent 事件
    return [];
  }

  const out: string[] = [];

  if (size < rs.offset) {
    // 比記錄的 offset 還小＝被 hooks/record.mjs rotate 過：新檔從 0 開始，
    // 舊內容整份搬去 subagents.jsonl.1。rotate 那一瞬間可能還有幾筆事件
    // 我們沒讀到就被搬走了，所以先去舊檔把 [offset, 舊檔大小) 這段補回來，
    // 不然這幾筆事件（很可能就包含一筆 stop）會直接消失，變成永遠下不了班的幽靈。
    const rotatedPath = path + ".1";
    try {
      const rotSize = (await stat(rotatedPath)).size;
      if (rotSize >= rs.offset) {
        const tail = await readRange(rotatedPath, rs.offset, rotSize);
        out.push(...splitCompleteLines(rs.carry, tail).lines);
      }
    } catch {
      // 沒有舊檔可補，或讀取失敗：漏掉這一小段事件，總比讓整個 collector 掛掉好
    }
    rs.offset = 0;
    rs.carry = Buffer.alloc(0);
  }

  if (size === rs.offset) return out;

  const tail = await readRange(path, rs.offset, size);
  rs.offset = size;
  const { lines, carry } = splitCompleteLines(rs.carry, tail);
  rs.carry = carry;
  out.push(...lines);
  return out;
}

/**
 * 目錄要先存在，watch 才靠得住 —— chokidar 4 watch 不存在的目錄時，之後在裡面新增檔案
 * 不保證會補上 add/change（實測只在目錄本身出現那一刻打一次 addDir，檔案的事件收不到，
 * 得等 server 重啟才會發現）。所以自己先把目錄建好，不依賴「先有目錄再有檔案」這個 race。
 *
 * 抽成獨立函式方便測試：直接 watch 一個一開始不存在的目錄，驗證建立後檔案事件收得到。
 */
export async function watchDataDir(dir: string, onChange: (path: string) => void): Promise<FSWatcher> {
  await mkdir(dir, { recursive: true }).catch(() => {});
  const watcher = chokidar.watch(dir, { ignoreInitial: true, depth: 0 });
  watcher.on("add", onChange).on("change", onChange);
  watcher.on("error", (err) => console.error("[data-dir] watcher:", err));
  return watcher;
}
