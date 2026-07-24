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
