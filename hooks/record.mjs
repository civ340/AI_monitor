/**
 * Claude Code hook → subagent 事件檔。
 *
 * 兩條輸出、每種事件只留白名單欄位：
 *   - subagents.jsonl      ← PreToolUse(Agent/Task)、SubagentStart、SubagentStop
 *   - session-events.jsonl ← Notification、UserPromptSubmit、Stop、PostToolUse（只有 ts/ev/session_id，
 *                            Notification 另存截斷過的 notification_type；判斷「等你回覆」用）
 * 原始 payload 含 prompt / 對話全文（PreToolUse 的 tool_input、Notification 的 message、
 * UserPromptSubmit 的 prompt、SubagentStop 的 last_assistant_message、transcript 路徑等），一律不落地。
 *
 * 鐵律：這支腳本絕不能讓 agent 變慢或失敗。任何錯誤都吞掉、一律 exit 0。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rotateIfNeeded } from "./rotate.mjs";

// 以腳本自身位置定錨，不依賴 hook 執行時的 cwd
const DATA_DIR = fileURLToPath(new URL("../.data/", import.meta.url));
const OUT_SUBAGENTS = DATA_DIR + "subagents.jsonl";
const OUT_SESSION = DATA_DIR + "session-events.jsonl";

/** 超過這個大小就轉一份，避免長期跑下來這支檔案無限長大 */
const ROTATE_BYTES = 1024 * 1024;

// 跟 server/collectors/claudeSubagents.ts 用一樣的上限 —— 那邊也會再驗一次，
// 這裡先截斷只是不想把過長的字串留在磁碟上（這支腳本是純 JS，沒辦法直接 import 那份 TS 常數）。
const MAX_TYPE_CHARS = 64;
const MAX_DESC_CHARS = 80;
const MAX_STR_CHARS = 300;
const MAX_NTYPE_CHARS = 64;

/** Agent tool 沒指定 subagent_type 時，Claude Code 內部預設就是 general-purpose */
const DEFAULT_SUBAGENT_TYPE = "general-purpose";

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("error", () => process.exit(0));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(buf);
    const sessionLine = toSessionLine(payload);
    const rec = sessionLine || toLine(payload);
    if (rec) {
      const out = sessionLine ? OUT_SESSION : OUT_SUBAGENTS;
      mkdirSync(DATA_DIR, { recursive: true });
      rotateIfNeeded(out, ROTATE_BYTES);
      // 單次 write 一整行，降低多 session 併發 append 交錯的機會
      appendFileSync(out, JSON.stringify(rec) + "\n");
    }
  } catch {
    // 吞掉：寧可漏一筆事件，也不能干擾 agent
  }
  process.exit(0);
});

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : undefined);

/**
 * session 層級事件（判斷「等你回覆」用）。只回 ts / ev / session_id，Notification 另加 notification_type。
 * 刻意不讀 message、prompt、tool_input、tool_response、transcript_path —— 連讀出來都不做。
 */
function toSessionLine(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  let ev;
  switch (payload.hook_event_name) {
    case "Notification":
      ev = "notification";
      break;
    case "UserPromptSubmit":
      ev = "prompt";
      break;
    case "Stop":
      ev = "stop";
      break;
    case "PostToolUse":
      ev = "tool";
      break;
    default:
      return null;
  }
  const sessionId = str(payload.session_id, MAX_STR_CHARS);
  if (!sessionId) return null;
  const line = { ts: Date.now(), ev, session_id: sessionId };
  if (ev === "notification") {
    const nt = str(payload.notification_type, MAX_NTYPE_CHARS);
    if (nt) line.notification_type = nt;
  }
  return line;
}

/**
 * 白名單轉換。只認得三種事件，其餘（含未來可能新增的 hook 事件）一律回 null 不寫。
 * 欄位名照 payload 原樣（snake_case）保留，方便跟 hooks 文件對照。
 *
 * 每個必要欄位都先做型別檢查，型別不對就整筆丟掉（回 null）——
 * 寧可漏一筆事件，也不要把壞資料寫進 jsonl 讓下游 collector 白忙一場去擋它。
 */
function toLine(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const ts = Date.now();

  switch (payload.hook_event_name) {
    case "PreToolUse": {
      if (payload.tool_name !== "Agent" && payload.tool_name !== "Task") return null;
      const sessionId = str(payload.session_id, MAX_STR_CHARS);
      const toolUseId = str(payload.tool_use_id, MAX_STR_CHARS);
      if (!sessionId || !toolUseId) return null;

      const input = typeof payload.tool_input === "object" && payload.tool_input !== null ? payload.tool_input : {};
      // Agent/Task tool 的 subagent_type 是選填欄位，沒填時 Claude Code 內部用 general-purpose
      const subagentType = str(input.subagent_type, MAX_TYPE_CHARS) || DEFAULT_SUBAGENT_TYPE;

      return {
        ts,
        ev: "spawn",
        session_id: sessionId,
        tool_use_id: toolUseId,
        subagent_type: subagentType,
        description: str(input.description, MAX_DESC_CHARS),
      };
    }
    case "SubagentStart": {
      const sessionId = str(payload.session_id, MAX_STR_CHARS);
      const agentId = str(payload.agent_id, MAX_STR_CHARS);
      const agentType = str(payload.agent_type, MAX_TYPE_CHARS);
      if (!sessionId || !agentId || !agentType) return null;

      return {
        ts,
        ev: "start",
        session_id: sessionId,
        agent_id: agentId,
        agent_type: agentType,
        cwd: str(payload.cwd, MAX_STR_CHARS),
      };
    }
    case "SubagentStop": {
      const sessionId = str(payload.session_id, MAX_STR_CHARS);
      const agentId = str(payload.agent_id, MAX_STR_CHARS);
      if (!sessionId || !agentId) return null;

      return { ts, ev: "stop", session_id: sessionId, agent_id: agentId };
    }
    default:
      return null;
  }
}
