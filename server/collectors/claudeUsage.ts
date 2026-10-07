import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentUsage } from "@shared/types.js";
import { contextLimitFor, estimateCostUsd } from "../pricing.js";
import { SESSION_ID_RE } from "./claudeTasks.js";
import { createReadState, readRange, splitCompleteLines, type ReadState } from "./incrementalRead.js";

export const PROJECTS_ROOT = join(homedir(), ".claude", "projects");

/** model 名是白名單內的短字串，超長一律當異常截斷 */
const MAX_MODEL_CHARS = 64;
/** 超過這個長度的單行直接跳過，不拿去 JSON.parse（含大量工具輸出的行可能很長） */
const MAX_LINE_CHARS = 4 * 1024 * 1024;

/** 一則 assistant 訊息的用量（只有數字與模型名） */
export type MessageUsage = {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 子 agent（isSidechain）的訊息不代表主 session 的 context 大小 */
  sidechain: boolean;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * 解析 transcript 的一行。只認 type === "assistant"，且只取 message.id / model / usage 的數字欄位 ——
 * message.content（對話全文）在這裡根本不會被讀出來，更不會離開這個函式。
 */
export function parseAssistantUsage(line: string): { id: string; usage: MessageUsage } | null {
  // 快速排除：非 assistant 行（user/attachment 等佔大宗）連 parse 都不用
  if (line.length > MAX_LINE_CHARS || !line.includes('"assistant"')) return null;
  let raw: { type?: unknown; isSidechain?: unknown; message?: unknown };
  try {
    raw = JSON.parse(line) as typeof raw;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || raw.type !== "assistant") return null;
  const msg = raw.message as { id?: unknown; model?: unknown; usage?: unknown } | null;
  if (!msg || typeof msg !== "object") return null;
  const u = msg.usage as Record<string, unknown> | null;
  if (!u || typeof u !== "object") return null;
  if (typeof msg.id !== "string" || msg.id === "") return null;
  // Claude Code 對失敗／合成訊息會寫 <synthetic> 且 usage 全 0
  const model = typeof msg.model === "string" && msg.model !== "<synthetic>" ? msg.model.slice(0, MAX_MODEL_CHARS) : undefined;
  return {
    id: msg.id.slice(0, 200),
    usage: {
      model,
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
      cacheCreationTokens: num(u.cache_creation_input_tokens),
      sidechain: raw.isSidechain === true,
    },
  };
}

export type UsageTracker = {
  /** message.id → 該則最新的用量；同一則訊息串流分段會出現多行，後到的覆蓋前面（不累加） */
  byId: Map<string, MessageUsage>;
  /** 檔案順序中最後一則非 sidechain assistant 訊息 */
  last?: MessageUsage;
};

export function createUsageTracker(): UsageTracker {
  return { byId: new Map() };
}

export function applyUsageLine(t: UsageTracker, line: string): void {
  const parsed = parseAssistantUsage(line);
  if (!parsed) return;
  t.byId.set(parsed.id, parsed.usage);
  if (!parsed.usage.sidechain) t.last = parsed.usage;
}

/** 沒看過任何 assistant 訊息時回 undefined —— 不填 usage，不要塞 0 */
export function summarizeUsage(t: UsageTracker): AgentUsage | undefined {
  if (t.byId.size === 0) return undefined;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let cost = 0;
  let priced = false;
  for (const m of t.byId.values()) {
    input += m.inputTokens;
    output += m.outputTokens;
    cacheRead += m.cacheReadTokens;
    cacheCreation += m.cacheCreationTokens;
    const c = estimateCostUsd(m.model, m);
    if (c !== undefined) {
      cost += c;
      priced = true;
    }
  }
  const usage: AgentUsage = {
    model: t.last?.model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
  };
  if (t.last) {
    usage.contextTokens = t.last.inputTokens + t.last.cacheReadTokens + t.last.cacheCreationTokens;
    usage.contextLimit = contextLimitFor(t.last.model);
  }
  if (priced) usage.costUsd = cost;
  return usage;
}

/** Claude Code 把 cwd 編成目錄名的規則：所有非英數字元換成 "-"（C:\lab\AI_monitor → C--lab-AI-monitor） */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** 一次讀進記憶體並 parse 的上限；每段之間讓出 event loop，讀數十 MB 的 transcript 不會卡住 HTTP／SSE */
export const READ_CHUNK_BYTES = 2 * 1024 * 1024;

const yieldToEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * 分段讀出 append-only 檔案上次之後新增的完整行，逐段交給 onLines，段與段之間讓出 event loop。
 * transcript 不會 rotate；檔案變小視為被取代，從頭重讀（呼叫端的 tracker 需自行重置）。
 * 重頭讀之前先呼叫 onReset 讓呼叫端清掉累計狀態。
 */
async function readChunked(
  path: string,
  rs: ReadState,
  onLines: (lines: string[]) => void,
  onReset: () => void,
): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return;
  }
  if (size < rs.offset) {
    rs.offset = 0;
    rs.carry = Buffer.alloc(0);
    onReset();
  }
  while (rs.offset < size) {
    const end = Math.min(size, rs.offset + READ_CHUNK_BYTES);
    const buf = await readRange(path, rs.offset, end);
    rs.offset = end;
    const { lines, carry } = splitCompleteLines(rs.carry, buf);
    rs.carry = carry;
    onLines(lines);
    if (rs.offset < size) await yieldToEventLoop();
  }
}

export type UsageReaderOptions = {
  /**
   * true＝首次讀取在背景完成：read() 立刻回傳（不含 usage），該 session 的 transcript 逐 session 依序讀完後呼叫 onPrimed。
   * 預設 false（read() 等讀完才回，測試用）。
   */
  background?: boolean;
  /** 背景首次讀取完成（usage 已可用）時呼叫，通常用來觸發一次重新掃描 */
  onPrimed?: () => void;
};

type Entry = {
  path?: string;
  /** 背景模式：首次讀取已完成，usage 可對外 */
  primed: boolean;
  priming: boolean;
  rs: ReadState;
  tracker: UsageTracker;
  /** 串行化：scan 可能重疊，兩個讀取同時推進同一個 offset 會互相踩到 */
  chain: Promise<unknown>;
  mtimeMs?: number;
};

export type TranscriptUsage = { usage?: AgentUsage; mtimeMs?: number };

/**
 * 每個 session 一份增量讀取狀態；用完（session 離場）要呼叫 forget 釋放。
 * root 可注入，方便測試。
 */
export function createTranscriptUsageReader(root: string = PROJECTS_ROOT, opts: UsageReaderOptions = {}) {
  const entries = new Map<string, Entry>();
  /** 背景首次讀取一次只跑一個 session，避免同時 parse 多個大檔 */
  let primeChain: Promise<unknown> = Promise.resolve();

  const locate = async (sessionId: string, cwd: string | undefined): Promise<string | undefined> => {
    const file = `${sessionId}.jsonl`;
    const candidates: string[] = [];
    if (cwd) candidates.push(join(root, encodeProjectDir(cwd), file));
    for (const c of candidates) {
      try {
        await stat(c);
        return c;
      } catch {
        // 編碼規則對不上時走下面的掃描
      }
    }
    try {
      for (const d of await readdir(root)) {
        const p = join(root, d, file);
        try {
          await stat(p);
          return p;
        } catch {
          // 不在這個專案目錄
        }
      }
    } catch {
      // 沒有 projects 目錄
    }
    return undefined;
  };

  return {
    async read(sessionId: string, cwd: string | undefined): Promise<TranscriptUsage> {
      // sessionId 會被組成路徑，先確認只是 UUID（理由同 claudeTasks.readTasks）
      if (!SESSION_ID_RE.test(sessionId)) return {};
      let e = entries.get(sessionId);
      if (!e) {
        e = { rs: createReadState(), tracker: createUsageTracker(), chain: Promise.resolve(), primed: !opts.background, priming: false };
        entries.set(sessionId, e);
      }
      const entry = e;
      const run = async (): Promise<TranscriptUsage> => {
        try {
          if (!entry.path) entry.path = await locate(sessionId, cwd);
          if (!entry.path) return {};
          await readChunked(
            entry.path,
            entry.rs,
            (lines) => {
              for (const l of lines) applyUsageLine(entry.tracker, l);
            },
            () => {
              entry.tracker = createUsageTracker();
            },
          );
          entry.mtimeMs = (await stat(entry.path)).mtimeMs;
        } catch (err) {
          console.error("[claude-usage] 讀取 transcript 失敗:", err);
        }
        return { usage: summarizeUsage(entry.tracker), mtimeMs: entry.mtimeMs };
      };
      if (!entry.primed) {
        // 背景首次讀取：先回不含 usage 的結果（只帶 mtime），讀完再通知呼叫端重新掃描
        if (!entry.priming) {
          entry.priming = true;
          const prime = (): Promise<void> =>
            run().then(
              () => {
                entry.primed = true;
                if (entries.get(sessionId) === entry) opts.onPrimed?.();
              },
              () => {},
            );
          primeChain = primeChain.then(prime, prime);
        }
        try {
          if (!entry.path) entry.path = await locate(sessionId, cwd);
          if (entry.path) entry.mtimeMs = (await stat(entry.path)).mtimeMs;
        } catch {
          // 拿不到 mtime 就算了
        }
        return { mtimeMs: entry.mtimeMs };
      }
      const next = entry.chain.then(run, run) as Promise<TranscriptUsage>;
      entry.chain = next.catch(() => {});
      return next;
    },

    /** 釋放指定 session 的增量讀取狀態（只在確定 pid 死亡或 session 檔消失時呼叫） */
    release(sessionIds: Iterable<string>): void {
      for (const id of sessionIds) entries.delete(id);
    },

    /** 只保留還在場的 session，其餘釋放 */
    retainOnly(sessionIds: ReadonlySet<string>): void {
      for (const id of entries.keys()) if (!sessionIds.has(id)) entries.delete(id);
    },
  };
}
