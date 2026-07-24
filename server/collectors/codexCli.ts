import { open, readdir, readFile, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AgentState, Collector } from "@shared/types.js";

const CODEX_HOME = join(homedir(), ".codex");
const SESSIONS_ROOT = join(CODEX_HOME, "sessions");
const INDEX_FILE = join(CODEX_HOME, "session_index.jsonl");

/** rollout 檔這段時間內有寫入 = 正在跑 */
const ACTIVE_MS = 90_000;
/** 這段時間內跑過的才留在畫面上 */
const RECENT_MS = 30 * 60_000;

/** sessions/ 從年初累積至今，只看最近幾天的目錄，不然每次掃描都要走完整棵樹 */
const SCAN_DAYS = 2;

const POLL_MS = 5_000;
const DEBOUNCE_MS = 300;
const INDEX_TAIL_BYTES = 64 * 1024;
/** rollout 檔頭：夠讀到第一行 session_meta */
const HEAD_BYTES = 8 * 1024;
/** rollout 檔尾：夠涵蓋最近幾輪的事件 */
const TAIL_BYTES = 64 * 1024;
/** detail 是狀態列的一句話，超過就截斷 */
const MAX_DETAIL_CHARS = 120;

/** rollout-2026-07-22T08-37-16-<uuid>.jsonl */
const ROLLOUT_RE = /^rollout-.+?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * 資料源 7：原生 codex CLI（~/.codex/），跟 Claude Code 的 codex plugin 是兩條路。
 * 你直接下 `codex` 指令跑的工作只會出現在這裡。
 *
 * codex 不寫狀態檔，但 rollout 記錄裡有 task_started / task_complete 事件，
 * 用 turn_id 配對就能判斷是否還在跑；事件讀不到時才退回 mtime 猜測。
 */
export function codexCliCollector(): Collector {
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;

  return {
    name: "codex-cli",

    async start(emit) {
      const scan = async (): Promise<void> => {
        try {
          emit(await collect());
        } catch (err) {
          console.error("[codex-cli] 掃描失敗:", err);
        }
      };

      const schedule = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => void scan(), DEBOUNCE_MS);
      };

      // 只監看單一索引檔：watch 整棵 sessions/ 要建立上萬個 watcher，代價太高
      watcher = chokidar.watch(INDEX_FILE, { ignoreInitial: true });
      watcher.on("add", schedule).on("change", schedule);
      watcher.on("error", (err) => console.error("[codex-cli] watcher:", err));

      // rollout 檔的寫入不會動到索引檔，所以仍需低頻輪詢補上
      poll = setInterval(() => void scan(), POLL_MS);

      await scan();
    },

    async stop() {
      clearTimeout(timer);
      clearInterval(poll);
      await watcher?.close();
    },
  };
}

async function collect(): Promise<AgentState[]> {
  const names = await readIndex();
  const out: AgentState[] = [];

  for (const dir of recentDayDirs()) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue; // 那天沒開過 codex
    }

    for (const file of files) {
      const id = ROLLOUT_RE.exec(file)?.[1];
      if (!id) continue;

      let mtime: number;
      try {
        mtime = (await stat(join(dir, file))).mtimeMs;
      } catch {
        continue;
      }

      const age = Date.now() - mtime;
      if (age > RECENT_MS) continue;

      const info = await readRollout(join(dir, file));

      out.push({
        id: `codex-cli:${id.slice(0, 8)}`,
        kind: "resident",
        name: "Codex CLI",
        // 事件說了算；事件讀不到才退回 mtime 猜測
        state: (info.working ?? age < ACTIVE_MS) ? "working" : "idle",
        detail: info.detail ?? names.get(id),
        cwd: info.cwd,
        tasks: [],
        updatedAt: mtime,
      });
    }
  }

  return out;
}

type RolloutInfo = {
  /** true=有一輪還沒結束；undefined=事件不在讀取範圍內，無法判斷 */
  working?: boolean;
  detail?: string;
  cwd?: string;
};

/**
 * 從 rollout 檔讀出「現在在做什麼」。
 *
 * codex 不寫狀態檔，但它的事件流裡有 task_started / task_complete，
 * 兩者用 turn_id 配對 —— 有開始沒結束就是還在跑。這比看 mtime 準得多。
 *
 * 檔案含完整對話，可能很大，所以檔頭檔尾都只讀固定長度：
 * 檔頭拿 session_meta 的 cwd，檔尾拿最近的事件。
 */
async function readRollout(path: string): Promise<RolloutInfo> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    if (size === 0) return {};

    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    await handle.read(head, 0, head.length, 0);
    const cwd = parseCwd(head.toString("utf8"));

    const start = Math.max(0, size - TAIL_BYTES);
    const tail = Buffer.alloc(Math.min(TAIL_BYTES, size));
    await handle.read(tail, 0, tail.length, start);

    const lines = tail.toString("utf8").split("\n").filter((l) => l.trim() !== "");
    if (start > 0) lines.shift();

    let startedTurn: string | undefined;
    let completedTurn: string | undefined;
    let detail: string | undefined;

    for (const line of lines) {
      let payload: { type?: string; turn_id?: string; message?: string };
      try {
        const entry = JSON.parse(line) as { type?: string; payload?: typeof payload };
        if (entry.type !== "event_msg" || !entry.payload) continue;
        payload = entry.payload;
      } catch {
        continue;
      }

      switch (payload.type) {
        case "task_started":
          startedTurn = payload.turn_id;
          break;
        case "task_complete":
          completedTurn = payload.turn_id;
          break;
        case "user_message":
          // 使用者交辦的那句話就是「目前工作」；只取開頭，不要整段搬進前端
          if (payload.message) detail = payload.message.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_CHARS);
          break;
      }
    }

    const working = startedTurn === undefined ? undefined : startedTurn !== completedTurn;
    return { working, detail, cwd };
  } catch {
    return {};
  } finally {
    await handle?.close();
  }
}

/**
 * 從第一行的 session_meta 取工作目錄。
 *
 * 這行實測有 18KB（塞了一堆 session 設定），整行讀進來再 JSON.parse 很浪費，
 * 而且無論上限設多大都可能被更長的一行打敗。cwd 是固定欄位，直接抽出來即可。
 */
const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

function parseCwd(head: string): string | undefined {
  const raw = CWD_RE.exec(head)?.[1];
  if (!raw) return undefined;
  try {
    // 還原 JSON 字串的跳脫（Windows 路徑滿是反斜線）
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return undefined;
  }
}

/** 最近幾天的 sessions/YYYY/MM/DD 目錄 */
function recentDayDirs(): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < SCAN_DAYS; i++) {
    const d = new Date(Date.now() - i * 86_400_000);
    dirs.push(
      join(
        SESSIONS_ROOT,
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, "0"),
        String(d.getDate()).padStart(2, "0"),
      ),
    );
  }
  return dirs;
}

/**
 * session id → 工作描述。
 * 索引檔是 append-only，只讀檔尾即可 —— 我們只在意最近的 session。
 */
async function readIndex(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const { size } = await stat(INDEX_FILE);
    const buf = await readFile(INDEX_FILE);
    const chunk = buf.subarray(Math.max(0, size - INDEX_TAIL_BYTES)).toString("utf8");
    const lines = chunk.split("\n").filter((l) => l.trim() !== "");
    if (size > INDEX_TAIL_BYTES) lines.shift(); // 切半的首行

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { id?: string; thread_name?: string };
        if (entry.id && entry.thread_name) map.set(entry.id, clean(entry.thread_name));
      } catch {
        // 壞掉的一行不該影響其他
      }
    }
  } catch {
    // 沒有索引檔就沒有描述，agent 仍會顯示，只是沒有狀態文字
  }
  return map;
}

/** thread_name 常帶 "Codex Companion Task: <task>..." 這種前綴，去掉雜訊只留人看得懂的部分 */
function clean(name: string): string {
  return name
    .replace(/^Codex Companion Task:\s*/i, "")
    .replace(/<\/?task>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
