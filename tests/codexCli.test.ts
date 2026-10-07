import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCwd, cleanThreadName, readRollout } from "@server/collectors/codexCli.js";

describe("parseCwd", () => {
  it("從 session_meta 抽出 cwd（Windows 反斜線路徑）", () => {
    const line = JSON.stringify({ type: "session_meta", payload: { cwd: "C:\\lab\\AI_monitor" } });
    expect(parseCwd(line)).toBe("C:\\lab\\AI_monitor");
  });

  it("即使該行很長（>18KB）也抽得到 —— 不靠整行 JSON.parse", () => {
    const line = JSON.stringify({
      type: "session_meta",
      payload: { base_instructions: "X".repeat(20_000), cwd: "C:\\deep\\path" },
    });
    expect(line.length).toBeGreaterThan(18_000);
    expect(parseCwd(line)).toBe("C:\\deep\\path");
  });

  it("沒有 cwd 時回傳 undefined", () => {
    expect(parseCwd(JSON.stringify({ type: "session_meta", payload: {} }))).toBeUndefined();
  });
});

describe("cleanThreadName", () => {
  it("去掉 Codex Companion Task 前綴與 <task> 標籤", () => {
    expect(cleanThreadName("Codex Companion Task: <task>調查上傳流程</task>")).toBe("調查上傳流程");
  });

  it("多餘空白收斂成單一空格", () => {
    expect(cleanThreadName("查   詢   路徑")).toBe("查 詢 路徑");
  });
});

describe("readRollout task_started/complete 配對", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-codex-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const meta = JSON.stringify({ type: "session_meta", payload: { cwd: "C:\\ws" } });
  const ev = (type: string, extra: object = {}) =>
    JSON.stringify({ type: "event_msg", payload: { type, ...extra } });

  const write = (lines: string[]) => writeFile(join(dir, "r.jsonl"), lines.join("\n") + "\n");

  it("有 task_started 沒有配對的 complete → working", async () => {
    await write([meta, ev("task_started", { turn_id: "T1" })]);
    const info = await readRollout(join(dir, "r.jsonl"));
    expect(info.working).toBe(true);
    expect(info.cwd).toBe("C:\\ws");
  });

  it("start 與 complete 同一個 turn_id → 不在跑", async () => {
    await write([meta, ev("task_started", { turn_id: "T1" }), ev("task_complete", { turn_id: "T1" })]);
    const info = await readRollout(join(dir, "r.jsonl"));
    expect(info.working).toBe(false);
  });

  it("user_message 成為 detail，且不洩漏完整訊息以外的東西", async () => {
    await write([
      meta,
      ev("task_started", { turn_id: "T1" }),
      ev("user_message", { message: "codex 對話存在哪" }),
      ev("task_complete", { turn_id: "T1" }),
    ]);
    const info = await readRollout(join(dir, "r.jsonl"));
    expect(info.detail).toBe("codex 對話存在哪");
  });

  it("沒有任何 task 事件 → working 為 undefined（無法判斷，交給 mtime）", async () => {
    await write([meta, ev("user_message", { message: "hi" })]);
    const info = await readRollout(join(dir, "r.jsonl"));
    expect(info.working).toBeUndefined();
  });

  it("檔案不存在時回傳空物件，不丟錯", async () => {
    expect(await readRollout(join(dir, "nope.jsonl"))).toEqual({});
  });
});

describe("codexCli token_count 與 error", () => {
  const tc = (total: object, last: object, window = 258400) =>
    JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: window } },
    });

  it("parseTokenCount：input 扣掉 cached，context 用 last 的 input_tokens", async () => {
    const { parseTokenCount } = await import("@server/collectors/codexCli.js");
    const u = parseTokenCount({
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 5, output_tokens: 70 },
        last_token_usage: { input_tokens: 300 },
        model_context_window: 258400,
      },
    });
    expect(u).toEqual({ inputTokens: 600, outputTokens: 70, cacheReadTokens: 400, cacheCreationTokens: 5, contextTokens: 300, contextLimit: 258400 });
    expect(parseTokenCount({ type: "token_count", info: null })).toBeUndefined();
  });

  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-codex-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ev = (payload: object) => JSON.stringify({ type: "event_msg", payload });

  it("readRollout 取最後一筆 token_count 當 usage", async () => {
    const f = join(dir, "r.jsonl");
    await writeFile(
      f,
      [
        JSON.stringify({ type: "session_meta", payload: { cwd: "C:/x" } }),
        ev({ type: "task_started", turn_id: "t1" }),
        tc({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 }, { input_tokens: 10 }),
        tc({ input_tokens: 50, cached_input_tokens: 20, output_tokens: 9 }, { input_tokens: 40 }),
        ev({ type: "task_complete", turn_id: "t1" }),
      ].join("\n") + "\n",
    );
    const info = await readRollout(f);
    expect(info.usage).toMatchObject({ inputTokens: 30, cacheReadTokens: 20, outputTokens: 9, contextTokens: 40 });
    expect(info.working).toBe(false);
    expect(info.error).toBeUndefined();
  });

  it("error 事件記下單行摘要；下一輪 task_started 會清掉", async () => {
    const f = join(dir, "e.jsonl");
    await writeFile(f, [ev({ type: "task_started", turn_id: "t1" }), ev({ type: "error", message: "rate\nlimit  hit" })].join("\n") + "\n");
    expect((await readRollout(f)).error).toBe("rate limit hit");
    await writeFile(f, [ev({ type: "error", message: "old" }), ev({ type: "task_started", turn_id: "t2" })].join("\n") + "\n");
    expect((await readRollout(f)).error).toBeUndefined();
  });
});
