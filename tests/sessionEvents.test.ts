import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentState } from "@shared/types.js";
import {
  applySessionEvent,
  createSessionEventsReader,
  createSessionEventsState,
  parseSessionEventLine,
  waitingFor,
  waitingOf,
  type SessionEvent,
} from "@server/collectors/sessionEvents.js";
import { applyWaiting } from "@server/collectors/claudeSessions.js";

const S = "aaaaaaaa-1111-2222-3333-444444444444";
const ev = (e: SessionEvent["ev"], ts: number, nt?: string, sid = S): SessionEvent => ({
  ts,
  ev: e,
  session_id: sid,
  notification_type: nt,
});

describe("waitingOf 規則", () => {
  it("permission_prompt → permission；idle_prompt → input", () => {
    expect(waitingOf(ev("notification", 1, "permission_prompt"))).toBe("permission");
    expect(waitingOf(ev("notification", 1, "idle_prompt"))).toBe("input");
  });
  it("不認得或缺少的 notification_type 當作 permission", () => {
    expect(waitingOf(ev("notification", 1, "something_new"))).toBe("permission");
    expect(waitingOf(ev("notification", 1))).toBe("permission");
  });
  it("Stop → input；UserPromptSubmit / PostToolUse → 清除", () => {
    expect(waitingOf(ev("stop", 1))).toBe("input");
    expect(waitingOf(ev("prompt", 1))).toBeUndefined();
    expect(waitingOf(ev("tool", 1))).toBeUndefined();
  });
});

describe("每個 session 以最新一筆為準", () => {
  it("權限通知後 PostToolUse 清除；Stop 後 prompt 清除", () => {
    const st = createSessionEventsState();
    applySessionEvent(st, ev("notification", 1, "permission_prompt"));
    expect(waitingFor(st, S)).toBe("permission");
    applySessionEvent(st, ev("tool", 2));
    expect(waitingFor(st, S)).toBeUndefined();
    applySessionEvent(st, ev("stop", 3));
    expect(waitingFor(st, S)).toBe("input");
    applySessionEvent(st, ev("prompt", 4));
    expect(waitingFor(st, S)).toBeUndefined();
  });

  it("亂序到達的舊事件不覆蓋新的；不同 session 互不影響", () => {
    const st = createSessionEventsState();
    applySessionEvent(st, ev("stop", 10));
    applySessionEvent(st, ev("prompt", 5));
    expect(waitingFor(st, S)).toBe("input");
    expect(waitingFor(st, "other")).toBeUndefined();
  });
});

describe("parseSessionEventLine 防禦性解析", () => {
  it("接受合法行、截斷過長 notification_type", () => {
    const e = parseSessionEventLine(
      JSON.stringify({ ts: 1, ev: "notification", session_id: S, notification_type: "x".repeat(500) }),
    );
    expect(e?.notification_type?.length).toBe(64);
  });
  it("壞 JSON / 非物件 / 未知 ev / 缺欄位 → null", () => {
    const bad = [
      "{壞",
      "null",
      "[]",
      JSON.stringify({ ts: 1, ev: "weird", session_id: S }),
      JSON.stringify({ ev: "stop", session_id: S }),
      JSON.stringify({ ts: 1, ev: "stop" }),
    ];
    for (const l of bad) expect(parseSessionEventLine(l)).toBeNull();
  });
});

describe("claudeSessions 疊加 waiting", () => {
  const base: AgentState = {
    id: "claude:aaaaaaaa",
    kind: "resident",
    name: "Claude Code",
    state: "idle",
    tasks: [],
    updatedAt: 1,
  };

  it("idle / working 的 session 疊上 waiting 與原因", () => {
    expect(applyWaiting(base, "input")).toMatchObject({ state: "waiting", waitingReason: "input" });
    expect(applyWaiting({ ...base, state: "working" }, "permission")).toMatchObject({
      state: "waiting",
      waitingReason: "permission",
    });
  });
  it("offline 不標 waiting；沒有 waiting 時原樣回傳", () => {
    const off = { ...base, state: "offline" as const };
    expect(applyWaiting(off, "input")).toBe(off);
    expect(applyWaiting(base, undefined)).toBe(base);
  });
});

describe("createSessionEventsReader（暫存檔、增量、rotate）", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-sev-"));
    file = join(dir, "session-events.jsonl");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("檔案不存在不報錯；追加後只讀新內容", async () => {
    const r = createSessionEventsReader(file);
    await r.refresh();
    expect(waitingFor(r.state, S)).toBeUndefined();
    await appendFile(file, JSON.stringify({ ts: 1, ev: "stop", session_id: S }) + "\n");
    await r.refresh();
    expect(waitingFor(r.state, S)).toBe("input");
    await appendFile(file, JSON.stringify({ ts: 2, ev: "prompt", session_id: S }) + "\n");
    await r.refresh();
    expect(waitingFor(r.state, S)).toBeUndefined();
  });

  it("檔案被 rotate 後從頭讀新檔", async () => {
    const r = createSessionEventsReader(file);
    await appendFile(
      file,
      JSON.stringify({ ts: 1, ev: "stop", session_id: S }) + "\n" + JSON.stringify({ ts: 2, ev: "tool", session_id: S }) + "\n",
    );
    await r.refresh();
    expect(waitingFor(r.state, S)).toBeUndefined();
    await rm(file);
    await appendFile(
      file,
      JSON.stringify({ ts: 3, ev: "notification", session_id: S, notification_type: "permission_prompt" }) + "\n",
    );
    await r.refresh();
    expect(waitingFor(r.state, S)).toBe("permission");
  });
});

describe("hooks/record.mjs 新事件白名單（複製到暫存目錄執行）", () => {
  let dir: string;
  let script: string;
  const SECRET = "SECRET-PROMPT-TEXT";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-hook2-"));
    await mkdir(join(dir, "hooks"), { recursive: true });
    script = join(dir, "hooks", "record.mjs");
    await copyFile(fileURLToPath(new URL("../hooks/record.mjs", import.meta.url)), script);
    await copyFile(fileURLToPath(new URL("../hooks/rotate.mjs", import.meta.url)), join(dir, "hooks", "rotate.mjs"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (payload: unknown): void => {
    execFileSync(process.execPath, [script], { input: JSON.stringify(payload), stdio: ["pipe", "ignore", "ignore"] });
  };
  const sessionFile = (): string => join(dir, ".data", "session-events.jsonl");
  const lastLine = async (): Promise<Record<string, unknown>> => {
    const lines = (await readFile(sessionFile(), "utf8")).trim().split("\n");
    return JSON.parse(lines[lines.length - 1] ?? "null") as Record<string, unknown>;
  };
  const noisy = {
    session_id: S,
    message: SECRET,
    prompt: SECRET,
    tool_input: { command: SECRET },
    tool_response: SECRET,
    transcript_path: "C:/x/" + SECRET + ".jsonl",
    cwd: "C:/secret-cwd",
    last_assistant_message: SECRET,
  };

  it("Notification 只存 ts / ev / session_id / notification_type", async () => {
    run({ hook_event_name: "Notification", notification_type: "permission_prompt", ...noisy });
    const l = await lastLine();
    expect(Object.keys(l).sort()).toEqual(["ev", "notification_type", "session_id", "ts"]);
    expect(l.ev).toBe("notification");
    expect(l.notification_type).toBe("permission_prompt");
    expect(await readFile(sessionFile(), "utf8")).not.toContain(SECRET);
  });

  it("notification_type 被截斷到 64 字", async () => {
    run({ hook_event_name: "Notification", notification_type: "n".repeat(300), session_id: S });
    expect(String((await lastLine()).notification_type).length).toBe(64);
  });

  it.each([
    ["UserPromptSubmit", "prompt"],
    ["Stop", "stop"],
    ["PostToolUse", "tool"],
  ])("%s 寫 ev=%s，只有 ts/ev/session_id，不含 prompt／tool_input／transcript", async (name, evName) => {
    run({ hook_event_name: name, ...noisy });
    const l = await lastLine();
    expect(Object.keys(l).sort()).toEqual(["ev", "session_id", "ts"]);
    expect(l.ev).toBe(evName);
    const raw = await readFile(sessionFile(), "utf8");
    for (const bad of [SECRET, "transcript", "secret-cwd"]) expect(raw).not.toContain(bad);
  });

  it("沒有 session_id 的事件整筆丟掉；子 agent 事件仍寫到 subagents.jsonl 而非 session 檔", async () => {
    run({ hook_event_name: "Stop" });
    await expect(stat(sessionFile())).rejects.toThrow();
    run({ hook_event_name: "SubagentStop", session_id: S, agent_id: "a1" });
    await expect(stat(sessionFile())).rejects.toThrow();
    expect(await readFile(join(dir, ".data", "subagents.jsonl"), "utf8")).toContain('"ev":"stop"');
  });
});
