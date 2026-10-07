import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, appendFile, copyFile, mkdir, readFile, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEvent,
  createReadState,
  createTrackerState,
  parseLine,
  pruneDead,
  nextGraceExpiry,
  STOP_GRACE_MS,
  readAppendedLines,
  toAgentStates,
  watchDataDir,
  type SubEvent,
  type TrackerState,
} from "@server/collectors/claudeSubagents.js";

const SID_A = "aaaaaaaa-1111-2222-3333-444444444444";
const SID_B = "bbbbbbbb-1111-2222-3333-444444444444";

function spawn(ts: number, overrides: Partial<SubEvent> = {}): SubEvent {
  return {
    ev: "spawn",
    ts,
    session_id: SID_A,
    tool_use_id: "tu_1",
    subagent_type: "scout",
    description: "查一下 foo",
    ...overrides,
  } as SubEvent;
}

function start(ts: number, overrides: Partial<SubEvent> = {}): SubEvent {
  return {
    ev: "start",
    ts,
    session_id: SID_A,
    agent_id: "agent1",
    agent_type: "scout",
    cwd: "C:\\lab\\AI_monitor",
    ...overrides,
  } as SubEvent;
}

function stop(ts: number, overrides: Partial<SubEvent> = {}): SubEvent {
  return { ev: "stop", ts, session_id: SID_A, agent_id: "agent1", ...overrides } as SubEvent;
}

const LIVE_A = new Set([SID_A]);

describe("start/stop 配對", () => {
  it("start 後出現一筆 working 的 transient，stop 後轉 idle、寬限期過後才消失", () => {
    const state = createTrackerState();
    applyEvent(state, spawn(1000));
    applyEvent(state, start(1200));

    let agents = toAgentStates(state);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "claude-sub:agent1",
      kind: "transient",
      parent: "claude:aaaaaaaa",
      name: "scout",
      state: "working",
      detail: "查一下 foo",
      cwd: "C:\\lab\\AI_monitor",
      updatedAt: 1200,
    });

    applyEvent(state, stop(1500));
    agents = toAgentStates(state);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ state: "idle", updatedAt: 1500 });

    const live = new Set([SID_A]);
    expect(pruneDead(state, 1500 + STOP_GRACE_MS, live)).toBe(false);
    expect(pruneDead(state, 1500 + STOP_GRACE_MS + 1, live)).toBe(true);
    expect(toAgentStates(state)).toHaveLength(0);
  });

  it("寬限期內再收到 Stop 會重新起算（背景 agent 被反覆喚醒時要一直留在畫面上）", () => {
    const state = createTrackerState();
    const live = new Set([SID_A]);
    applyEvent(state, start(1000));
    applyEvent(state, stop(2000));
    applyEvent(state, stop(2000 + STOP_GRACE_MS - 100));

    // 以第一個 Stop 算早就該走了，但第二個 Stop 把倒數推後
    expect(pruneDead(state, 2000 + STOP_GRACE_MS + 1, live)).toBe(false);
    expect(nextGraceExpiry(state)).toBe(2000 + 2 * STOP_GRACE_MS - 100);
    expect(pruneDead(state, 2000 + 2 * STOP_GRACE_MS, live)).toBe(true);
  });

  it("亂序到達的舊 Stop 不能把倒數往前拉", () => {
    const state = createTrackerState();
    applyEvent(state, start(1000));
    applyEvent(state, stop(5000));
    applyEvent(state, stop(3000));
    expect(nextGraceExpiry(state)).toBe(5000 + STOP_GRACE_MS);
  });

  it("沒 start 過的 id 收到 Stop 不會憑空生出角色", () => {
    const state = createTrackerState();
    applyEvent(state, stop(1000, { agent_id: "ghost" }));
    expect(toAgentStates(state)).toHaveLength(0);
    expect(nextGraceExpiry(state)).toBeUndefined();
  });

  it("TTL 以最後一次動靜計，不是出生時間", () => {
    const state = createTrackerState();
    const live = new Set([SID_A]);
    applyEvent(state, start(0));
    const TWO_HOURS = 2 * 60 * 60_000;
    applyEvent(state, stop(TWO_HOURS));
    // 出生已超過 2 小時，但剛 Stop 過，還在寬限期內
    expect(pruneDead(state, TWO_HOURS + 1000, live)).toBe(false);
  });
});

describe("description 配對", () => {
  it("挑最近的候補", () => {
    const state = createTrackerState();
    applyEvent(state, spawn(1000, { description: "舊的" }));
    applyEvent(state, spawn(1005, { description: "新的" }));
    applyEvent(state, start(1006, { agent_id: "agent1" }));
    expect(toAgentStates(state)[0]?.detail).toBe("新的");
  });

  it("type 不同不配對", () => {
    const state = createTrackerState();
    applyEvent(state, spawn(1000, { subagent_type: "executor", description: "不該被配對" }));
    applyEvent(state, start(1006, { agent_type: "scout" }));
    expect(toAgentStates(state)[0]?.detail).toBeUndefined();
  });

  it("超過 10 秒窗口不配對", () => {
    const state = createTrackerState();
    applyEvent(state, spawn(1000, { description: "太舊了" }));
    applyEvent(state, start(1000 + 10_001));
    expect(toAgentStates(state)[0]?.detail).toBeUndefined();
  });

  it("同一筆候補只能被消耗一次", () => {
    const state = createTrackerState();
    applyEvent(state, spawn(1000, { description: "只有一個" }));
    applyEvent(state, start(1001, { agent_id: "agent1" }));
    applyEvent(state, start(1002, { agent_id: "agent2" }));
    const agents = toAgentStates(state);
    const byId = new Map(agents.map((a) => [a.id, a]));
    expect(byId.get("claude-sub:agent1")?.detail).toBe("只有一個");
    expect(byId.get("claude-sub:agent2")?.detail).toBeUndefined();
  });

  it("不同 session 不配對", () => {
    const state = createTrackerState();
    applyEvent(state, spawn(1000, { session_id: SID_B, description: "別的 session" }));
    applyEvent(state, start(1001, { session_id: SID_A }));
    expect(toAgentStates(state)[0]?.detail).toBeUndefined();
  });
});

describe("parseLine 防禦性解析", () => {
  it("合法 JSON 但不是物件（null、陣列、數字）要回 null，不能丟例外", () => {
    for (const line of ["null", "[]", "42", '"str"']) {
      expect(() => parseLine(line)).not.toThrow();
      expect(parseLine(line)).toBeNull();
    }
  });

  it("ts 不是有限數字（1e999 → Infinity）要擋下", () => {
    expect(parseLine(`{"ts":1e999,"ev":"stop","session_id":"${SID_A}","agent_id":"a1"}`)).toBeNull();
  });

  it("壞掉的 JSON 回 null", () => {
    expect(parseLine("{ 壞掉的 json")).toBeNull();
  });

  it("session_id 不是合法 UUID 回 null", () => {
    expect(parseLine(JSON.stringify({ ts: 1, ev: "stop", session_id: "not-a-uuid", agent_id: "a1" }))).toBeNull();
  });

  it("session_id 長得像路徑穿越時回 null", () => {
    expect(
      parseLine(JSON.stringify({ ts: 1, ev: "stop", session_id: "../../etc/passwd", agent_id: "a1" })),
    ).toBeNull();
  });

  it("agent_id 含非法字元回 null", () => {
    expect(
      parseLine(JSON.stringify({ ts: 1, ev: "stop", session_id: SID_A, agent_id: "../evil" })),
    ).toBeNull();
  });

  it("未知的 ev 回 null", () => {
    expect(parseLine(JSON.stringify({ ts: 1, ev: "mystery", session_id: SID_A }))).toBeNull();
  });

  it("缺必要欄位回 null", () => {
    expect(parseLine(JSON.stringify({ ts: 1, ev: "start", session_id: SID_A }))).toBeNull();
  });

  it("合法的 spawn 行解析成功，description 超長會截斷", () => {
    const ev = parseLine(
      JSON.stringify({
        ts: 1000,
        ev: "spawn",
        session_id: SID_A,
        tool_use_id: "tu_1",
        subagent_type: "scout",
        description: "X".repeat(500),
      }),
    );
    expect(ev).not.toBeNull();
    expect(ev?.ev).toBe("spawn");
    if (ev?.ev === "spawn") expect(ev.description?.length).toBe(80);
  });
});

describe("readAppendedLines 增量讀取", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-subagents-"));
    file = join(dir, "subagents.jsonl");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("檔案不存在時回空陣列，不丟錯", async () => {
    const rs = createReadState();
    expect(await readAppendedLines(file, rs)).toEqual([]);
  });

  it("分兩次寫入，第二次只讀到新增的那行", async () => {
    const rs = createReadState();
    await appendFile(file, '{"a":1}\n');
    expect(await readAppendedLines(file, rs)).toEqual(['{"a":1}']);

    await appendFile(file, '{"a":2}\n');
    expect(await readAppendedLines(file, rs)).toEqual(['{"a":2}']);
  });

  it("半截行（沒有結尾換行）先留在 carry，下次接上才吐出完整行", async () => {
    const rs = createReadState();
    await appendFile(file, '{"a":1}\n{"a":2');
    expect(await readAppendedLines(file, rs)).toEqual(['{"a":1}']);

    await appendFile(file, '}\n{"a":3}\n');
    expect(await readAppendedLines(file, rs)).toEqual(['{"a":2}', '{"a":3}']);
  });

  it("檔案被 rotate（變小）時從頭重讀", async () => {
    const rs = createReadState();
    await appendFile(file, '{"a":1}\n{"a":2}\n');
    await readAppendedLines(file, rs);

    // 模擬 hooks/record.mjs 的 rotate：搬走舊檔，開一份新的小檔
    await rename(file, file + ".1");
    await writeFile(file, '{"a":3}\n');

    expect(await readAppendedLines(file, rs)).toEqual(['{"a":3}']);
  });
});

describe("pruneDead 幽靈清除", () => {
  function stateWithOneActive(startedAt: number, sessionId = SID_A): TrackerState {
    const state = createTrackerState();
    applyEvent(state, start(startedAt, { session_id: sessionId }));
    return state;
  }

  it("parent session 已死 → 清掉", () => {
    const state = stateWithOneActive(1000);
    const changed = pruneDead(state, 2000, new Set());
    expect(changed).toBe(true);
    expect(toAgentStates(state)).toHaveLength(0);
  });

  it("parent session 還活著 → 留著", () => {
    const state = stateWithOneActive(1000);
    const changed = pruneDead(state, 2000, LIVE_A);
    expect(changed).toBe(false);
    expect(toAgentStates(state)).toHaveLength(1);
  });

  it("超過 2 小時 TTL → 即使 parent 活著也清掉", () => {
    const state = stateWithOneActive(1000);
    const twoHoursLater = 1000 + 2 * 60 * 60_000 + 1;
    const changed = pruneDead(state, twoHoursLater, LIVE_A);
    expect(changed).toBe(true);
    expect(toAgentStates(state)).toHaveLength(0);
  });

  it("沒有東西可清時回傳 false", () => {
    const state = createTrackerState();
    expect(pruneDead(state, Date.now(), LIVE_A)).toBe(false);
  });
});

describe("readAppendedLines rotate 時補回還沒讀到的尾巴（Codex 對抗性審查 defect 4）", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-subagents-rotate-"));
    file = join(dir, "subagents.jsonl");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rotate 前寫入但還沒讀到的那行，rotate 後仍從舊檔（.1）補回來", async () => {
    const rs = createReadState();
    await appendFile(file, '{"a":1}\n');
    expect(await readAppendedLines(file, rs)).toEqual(['{"a":1}']);

    // 第二行寫進同一份檔案，但在被讀到之前就 rotate 了（見 hooks/record.mjs 的 rotateIfNeeded）。
    // 新檔特意留空，確保「新檔比 rs.offset 還小」的判斷穩定觸發，不受兩邊行長度巧合相等影響。
    await appendFile(file, '{"a":2}\n');
    await rename(file, file + ".1");
    await writeFile(file, "");

    // 沒有這個修法的話 {"a":2} 會直接消失 —— 新檔比 rs.offset 還小，舊內容整份被搬走
    expect(await readAppendedLines(file, rs)).toEqual(['{"a":2}']);

    // 新檔之後才寫入的內容要能正常接續讀到
    await appendFile(file, '{"a":3}\n');
    expect(await readAppendedLines(file, rs)).toEqual(['{"a":3}']);
  });

  it("完整情境：start 讀到但 stop 卡在 rotate 前沒讀到，補回來後 agent 才會真的消失", async () => {
    const rs = createReadState();
    const state = createTrackerState();
    const runOnce = async (): Promise<void> => {
      for (const line of await readAppendedLines(file, rs)) {
        const ev = parseLine(line);
        if (ev) applyEvent(state, ev);
      }
    };

    await appendFile(file, JSON.stringify(start(1000)) + "\n");
    await runOnce();
    expect(toAgentStates(state).map((a) => a.id)).toEqual(["claude-sub:agent1"]);

    // stop 寫進同一份檔案，但在被讀到之前就 rotate 了。新檔留空，理由同上一個測試。
    await appendFile(file, JSON.stringify(stop(1500)) + "\n");
    await rename(file, file + ".1");
    await writeFile(file, "");

    await runOnce();
    // 補回的 stop 有被套用＝轉成 idle（離場由寬限期決定，這裡只驗 stop 沒被 rotate 吃掉）
    expect(toAgentStates(state)).toEqual([expect.objectContaining({ id: "claude-sub:agent1", state: "idle" })]);
    pruneDead(state, 1500 + STOP_GRACE_MS + 1, new Set([SID_A]));
    expect(toAgentStates(state)).toEqual([]);

    // rotate 後新檔陸續進來的事件要能正常接續處理
    await appendFile(file, JSON.stringify(start(1600, { agent_id: "agent2" })) + "\n");
    await runOnce();
    expect(toAgentStates(state).map((a) => a.id)).toEqual(["claude-sub:agent2"]);
  });
});

describe("readAppendedLines 多位元組字元跨兩次讀取不能爛掉（Codex 對抗性審查 defect 3）", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-subagents-utf8-"));
    file = join(dir, "subagents.jsonl");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("「文」字被切在兩次寫入中間，接起來後仍是正確的字，不是替代字元", async () => {
    const full = Buffer.from('{"detail":"文字很重要"}\n', "utf8");
    const charStart = full.indexOf(Buffer.from("文", "utf8"));
    // 切在多位元組字元的第一個 byte 之後 —— 兩半各自單獨 decode 都會產生 U+FFFD
    const splitAt = charStart + 1;
    expect(splitAt).toBeGreaterThan(0);
    expect(splitAt).toBeLessThan(full.length);

    await writeFile(file, full.subarray(0, splitAt));
    const rs = createReadState();
    // 這時候連換行都還沒寫到，本來就不會吐出完整行；重點是後面接起來要正確
    expect(await readAppendedLines(file, rs)).toEqual([]);

    await appendFile(file, full.subarray(splitAt));
    const lines = await readAppendedLines(file, rs);
    expect(lines).toEqual(['{"detail":"文字很重要"}']);
    expect(lines[0]).not.toContain("\uFFFD");
  });
});

describe("watchDataDir：.data 目錄一開始不存在也要能收到之後的檔案事件（defect 1）", () => {
  it("watch 一個不存在的巢狀目錄，建立目錄後在裡面新增檔案仍會觸發 onChange", async () => {
    const root = await mkdtemp(join(tmpdir(), "aimon-subwatch-"));
    // 故意連父層都不先建，模擬 server 啟動時 .data 還沒被任何 hook 建立過的情境
    const dir = join(root, "nested", "data");

    let fired = 0;
    const watcher = await watchDataDir(dir, () => {
      fired++;
    });
    try {
      // ignoreInitial 只吃「watch 啟動當下已存在」的檔案 —— 一定要等 chokidar 回報
      // 初始掃描完成（ready），才能確保接下來寫的檔案會被當成真正的新事件觸發
      await new Promise<void>((resolve) => watcher.once("ready", resolve));
      await writeFile(join(dir, "subagents.jsonl"), '{"a":1}\n');
      await waitFor(() => fired > 0, 5000);
      expect(fired).toBeGreaterThan(0);
    } finally {
      await watcher.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});

/** chokidar 事件是非同步的，用短輪詢代替死等固定時間 */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: 超過時間仍未達成條件");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("hooks/record.mjs 欄位白名單（把腳本複製到暫存目錄執行，不會動到真正的 .data）", () => {
  let dir: string;
  let scriptPath: string;
  let outFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-hook-"));
    const hooksDir = join(dir, "hooks");
    await mkdir(hooksDir, { recursive: true });
    scriptPath = join(hooksDir, "record.mjs");
    // record.mjs 用 import.meta.url 定錨 .data 路徑，複製到暫存目錄後它會自己寫到
    // <dir>/.data/subagents.jsonl，完全不會碰到專案真正的 .data —— 這樣才能真的執行
    // 這支腳本（而不是只測邏輯的複製品）又不污染正式環境。
    await copyFile(fileURLToPath(new URL("../hooks/record.mjs", import.meta.url)), scriptPath);
    await copyFile(fileURLToPath(new URL("../hooks/rotate.mjs", import.meta.url)), join(hooksDir, "rotate.mjs"));
    outFile = join(dir, ".data", "subagents.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function run(payload: unknown): void {
    execFileSync(process.execPath, [scriptPath], {
      input: JSON.stringify(payload),
      stdio: ["pipe", "ignore", "ignore"],
    });
  }

  async function lastLine(): Promise<Record<string, unknown>> {
    const content = (await readFile(outFile, "utf8")).trim();
    const lines = content.split("\n");
    return JSON.parse(lines[lines.length - 1] ?? "null") as Record<string, unknown>;
  }

  it("Agent tool 沒帶 subagent_type 時預設 general-purpose（defect 2）", async () => {
    run({
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      session_id: SID_A,
      tool_use_id: "tu_1",
      tool_input: { description: "隨便看一下" },
    });
    const ev = await lastLine();
    expect(ev.ev).toBe("spawn");
    expect(ev.subagent_type).toBe("general-purpose");
  });

  it("subagent_type 是空字串也當沒指定，退回 general-purpose", async () => {
    run({
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      session_id: SID_A,
      tool_use_id: "tu_3",
      tool_input: { subagent_type: "", description: "空字串" },
    });
    const ev = await lastLine();
    expect(ev.subagent_type).toBe("general-purpose");
  });

  it("Task tool 帶了 subagent_type 就照用，不覆蓋", async () => {
    run({
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      session_id: SID_A,
      tool_use_id: "tu_2",
      tool_input: { subagent_type: "scout", description: "查一下" },
    });
    const ev = await lastLine();
    expect(ev.subagent_type).toBe("scout");
  });

  it("必要欄位型別不對（session_id 不是字串）就整筆丟掉，不寫入檔案（defect 6）", async () => {
    run({ hook_event_name: "SubagentStart", session_id: 12345, agent_id: "a1", agent_type: "scout" });
    await expect(readFile(outFile, "utf8")).rejects.toThrow();
  });

  it("SubagentStop 缺 agent_id 就整筆丟掉", async () => {
    run({ hook_event_name: "SubagentStop", session_id: SID_A });
    await expect(readFile(outFile, "utf8")).rejects.toThrow();
  });

  it("subagent_type / cwd 超長會被截斷（defect 6）", async () => {
    run({
      hook_event_name: "SubagentStart",
      session_id: SID_A,
      agent_id: "agent1",
      agent_type: "X".repeat(200),
      cwd: "C:\\" + "y".repeat(500),
    });
    const ev = await lastLine();
    expect((ev.agent_type as string).length).toBe(64);
    expect((ev.cwd as string).length).toBe(300);
  });

  it("空輸入 / 壞掉的 JSON 仍正常結束，不拋錯、不寫檔（鐵律，含 defect 7 的 stdin 前提）", () => {
    expect(() =>
      execFileSync(process.execPath, [scriptPath], { input: "", stdio: ["pipe", "ignore", "ignore"] }),
    ).not.toThrow();
    expect(() =>
      execFileSync(process.execPath, [scriptPath], { input: "{ 壞掉的 json", stdio: ["pipe", "ignore", "ignore"] }),
    ).not.toThrow();
  });
});

describe("item 7：rotate／重讀造成的舊事件重放是冪等的", () => {
  it("已 stop 的 subagent，重放同一筆（或更舊的）start 不會復活它、也不會清掉 stoppedAt", () => {
    const state = createTrackerState();
    applyEvent(state, start(1200));
    applyEvent(state, stop(1500));
    applyEvent(state, start(1200)); // 重放
    applyEvent(state, start(1000)); // 更舊
    expect(toAgentStates(state)[0]).toMatchObject({ state: "idle", updatedAt: 1500 });
  });

  it("重放的 spawn 不會多出一筆候補；更新的 start（同 id 再開始）仍會重新起算", () => {
    const state = createTrackerState();
    applyEvent(state, spawn(1000));
    applyEvent(state, spawn(1000));
    expect(state.pending).toHaveLength(1);
    applyEvent(state, start(1200));
    applyEvent(state, stop(1500));
    applyEvent(state, start(3000));
    expect(toAgentStates(state)[0]).toMatchObject({ state: "working", updatedAt: 3000 });
  });
});
