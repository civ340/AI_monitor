import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { WaitingReason } from "@shared/types.js";
import { createReadState, readAppendedLines, type ReadState } from "./incrementalRead.js";

const DATA_DIR = fileURLToPath(new URL("../../.data/", import.meta.url));
export const SESSION_EVENTS_FILE = DATA_DIR + "session-events.jsonl";
export const SESSION_EVENTS_DIR = DATA_DIR;

const MAX_NTYPE_CHARS = 64;
/** 最多追蹤這麼多 session（死掉的 session 也會留在 map 裡，硬上限防長期跑下來無限長大） */
const MAX_SESSIONS = 500;

/**
 * hooks/record.mjs 寫進 session-events.jsonl 的事件。只有白名單欄位，沒有任何對話文字。
 * ev 值：notification / prompt / stop / tool
 */
export type SessionEvent = {
  ts: number;
  ev: "notification" | "prompt" | "stop" | "tool";
  session_id: string;
  notification_type?: string;
};

const EVENTS = new Set(["notification", "prompt", "stop", "tool"]);

/** 防禦性解析：壞 JSON、型別不對的一律回 null（這個檔案雖是自己的 hook 寫的，仍視為不可信輸入） */
export function parseSessionEventLine(line: string): SessionEvent | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.ts !== "number" || !Number.isFinite(raw.ts)) return null;
  if (typeof raw.session_id !== "string" || raw.session_id === "" || raw.session_id.length > 300) return null;
  if (typeof raw.ev !== "string" || !EVENTS.has(raw.ev)) return null;
  const nt = raw.notification_type;
  return {
    ts: raw.ts,
    ev: raw.ev as SessionEvent["ev"],
    session_id: raw.session_id,
    notification_type: typeof nt === "string" ? nt.slice(0, MAX_NTYPE_CHARS) : undefined,
  };
}

/**
 * 單一事件 → 它造成的等待狀態（undefined＝清除 waiting）。
 *
 * - Notification idle_prompt → input；其餘（permission_prompt 與不認得的類型）→ permission
 * - Stop → input（Claude 回完話在等使用者）
 * - UserPromptSubmit / PostToolUse → 清除
 */
export function waitingOf(ev: SessionEvent): WaitingReason | undefined {
  switch (ev.ev) {
    case "notification":
      return ev.notification_type === "idle_prompt" ? "input" : "permission";
    case "stop":
      return "input";
    default:
      return undefined;
  }
}

export type SessionEventsState = {
  /** sessionId → 該 session 最新一筆事件 */
  latest: Map<string, SessionEvent>;
};

export function createSessionEventsState(): SessionEventsState {
  return { latest: new Map() };
}

/** 以每個 session 最新一筆為準；亂序到達的舊事件（ts 較小）不覆蓋新的 */
export function applySessionEvent(state: SessionEventsState, ev: SessionEvent): void {
  const prev = state.latest.get(ev.session_id);
  if (prev && prev.ts > ev.ts) return;
  state.latest.delete(ev.session_id); // 重新插入以維持「最近更新排最後」，方便裁剪
  state.latest.set(ev.session_id, ev);
  if (state.latest.size > MAX_SESSIONS) {
    const oldest = state.latest.keys().next().value;
    if (oldest !== undefined) state.latest.delete(oldest);
  }
}

/**
 * 該 session 目前該不該顯示「等你」。
 *
 * 能清掉 waiting 的 hook 只有 PostToolUse / UserPromptSubmit，核准權限後如果工具要跑很久，
 * 這段時間畫面會一直卡在「等你核准」。session 檔提供第二個訊號：status 在最後一筆等待事件
 * 「之後」變回 busy（updatedAt > ev.ts）＝使用者已經回應、Claude 又開始做事，就清除。
 * 不傳 session（或 session 檔沒這個資訊）時只看 hook 事件。
 */
export function waitingFor(
  state: SessionEventsState,
  sessionId: string,
  session?: { status?: string; updatedAt?: number },
): WaitingReason | undefined {
  const ev = state.latest.get(sessionId);
  const reason = ev ? waitingOf(ev) : undefined;
  if (!ev || !reason) return undefined;
  if (session?.status === "busy" && typeof session.updatedAt === "number" && session.updatedAt > ev.ts) return undefined;
  return reason;
}

/** 該 session 最後一次收到事件的時間（任何事件都算真實活動） */
export function lastEventTs(state: SessionEventsState, sessionId: string): number | undefined {
  return state.latest.get(sessionId)?.ts;
}

/**
 * 增量讀取 session-events.jsonl 的有狀態讀取器。
 * refresh() 讀新增的行並套進 state；呼叫端須自行避免併發重入（claudeSessions 每次 scan 前 await 即可，
 * 這裡用 promise chain 串行化確保 offset 不被踩到）。
 */
export function createSessionEventsReader(file: string = SESSION_EVENTS_FILE) {
  const rs: ReadState = createReadState();
  const state = createSessionEventsState();
  let chain: Promise<unknown> = Promise.resolve();

  /**
   * 啟動時先讀 .1（hook 轉檔出去的舊內容）：只在 .1 裡有事件的 session 才拿得到最新狀態。
   * 每個 session 以最新 ts 為準，所以先讀舊檔再讀主檔，亂序也不會蓋掉新的。
   */
  let primed = false;
  const primeFromRotated = async (): Promise<void> => {
    try {
      const text = await readFile(file + ".1", "utf8");
      for (const line of text.split("\n")) {
        const ev = line ? parseSessionEventLine(line) : null;
        if (ev) applySessionEvent(state, ev);
      }
    } catch {
      // 沒有 .1 很正常
    }
  };

  const doRefresh = async (): Promise<void> => {
    if (!primed) {
      primed = true;
      await primeFromRotated();
    }
    const lines = await readAppendedLines(file, rs);
    for (const line of lines) {
      const ev = parseSessionEventLine(line);
      if (ev) applySessionEvent(state, ev);
    }
  };

  return {
    state,
    refresh(): Promise<void> {
      const next = chain.then(doRefresh, doRefresh);
      chain = next.catch(() => {});
      return next.catch((err) => {
        console.error("[session-events] 讀取失敗:", err);
      });
    },
  };
}
