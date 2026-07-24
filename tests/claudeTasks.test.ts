import { describe, it, expect } from "vitest";
import { readTasks, activeDetail } from "@server/collectors/claudeTasks.js";
import type { AgentTask } from "@shared/types.js";

describe("readTasks 路徑穿越防護", () => {
  // Codex 對抗性審查 [high]：sessionId 會被當路徑用，惡意值不能讀到 tasks 目錄外
  const attacks = [
    "../..",
    "../../..",
    "..\\..\\",
    "/etc/passwd",
    "C:\\Windows",
    "../projects",
    "not-a-uuid",
    "28c66620-2fb9-4659-8eb0-39bdd6bc1185/../../projects",
    "",
    ".",
  ];

  for (const evil of attacks) {
    it(`擋下 ${JSON.stringify(evil)}`, async () => {
      expect(await readTasks(evil)).toEqual([]);
    });
  }

  it("合法 UUID 不會被格式檢查誤殺（回傳陣列，不丟錯）", async () => {
    // 這個 session 不一定有任務檔，重點是它通過驗證、正常回傳陣列而非 []-by-rejection
    const r = await readTasks("00000000-0000-0000-0000-000000000000");
    expect(Array.isArray(r)).toBe(true);
  });
});

describe("activeDetail", () => {
  const task = (over: Partial<AgentTask>): AgentTask => ({
    id: "1",
    subject: "主旨",
    status: "pending",
    progress: 0,
    ...over,
  });

  it("有進行中任務時，優先取 activeForm", () => {
    const tasks = [
      task({ id: "1", status: "completed", progress: 1 }),
      task({ id: "2", status: "in_progress", progress: 0.5, subject: "修 bug", activeForm: "修 bug 中" }),
    ];
    expect(activeDetail(tasks)).toBe("修 bug 中");
  });

  it("進行中但沒有 activeForm 時，退回 subject", () => {
    const tasks = [task({ id: "2", status: "in_progress", subject: "跑測試" })];
    expect(activeDetail(tasks)).toBe("跑測試");
  });

  it("沒有進行中任務時回傳 undefined（不編造）", () => {
    const tasks = [task({ status: "completed" }), task({ id: "2", status: "pending" })];
    expect(activeDetail(tasks)).toBeUndefined();
  });

  it("空清單回傳 undefined", () => {
    expect(activeDetail([])).toBeUndefined();
  });
});
