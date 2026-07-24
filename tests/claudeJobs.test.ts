import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveState, inFlightAsTasks, latestDetail } from "@server/collectors/claudeJobs.js";

describe("claudeJobs deriveState", () => {
  it("working → working", () => expect(deriveState("working")).toBe("working"));
  it("blocked → idle（卡住不是下班，要看得見）", () => expect(deriveState("blocked")).toBe("idle"));
  it("done → offline", () => expect(deriveState("done")).toBe("offline"));
  it("未知值 → offline", () => expect(deriveState("???")).toBe("offline"));
  it("undefined → offline", () => expect(deriveState(undefined)).toBe("offline"));
});

describe("inFlightAsTasks", () => {
  it("同時有進行中與排隊，各產一筆", () => {
    const tasks = inFlightAsTasks({ inFlight: { tasks: 2, queued: 1 } });
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ status: "in_progress", progress: 0.5 });
    expect(tasks[1]).toMatchObject({ status: "pending", progress: 0 });
  });

  it("都是 0 時不產任何任務", () => {
    expect(inFlightAsTasks({ inFlight: { tasks: 0, queued: 0 } })).toEqual([]);
  });

  it("沒有 inFlight 欄位時不炸，回空陣列", () => {
    expect(inFlightAsTasks({})).toEqual([]);
  });
});

describe("latestDetail 檔尾讀取", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-jobs-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeTimeline = (lines: string[]) =>
    writeFile(join(dir, "timeline.jsonl"), lines.join("\n") + "\n");

  it("取最後一行的 detail", async () => {
    await writeTimeline([
      JSON.stringify({ at: "t1", detail: "第一步", text: "全文A" }),
      JSON.stringify({ at: "t2", detail: "第二步", text: "全文B" }),
    ]);
    expect(await latestDetail(dir, "fallback")).toBe("第二步");
  });

  it("大檔（14MB）也只取最後一行，且不洩漏 text", async () => {
    const filler = "X".repeat(180);
    const lines: string[] = [];
    for (let i = 0; i < 55_000; i++) {
      lines.push(JSON.stringify({ at: `t${i}`, detail: `第 ${i} 步`, text: filler }));
    }
    lines.push(JSON.stringify({ at: "last", detail: "最後一行", text: "LEAK_CANARY_" + filler }));
    await writeTimeline(lines);

    const result = await latestDetail(dir, "fallback");
    expect(result).toBe("最後一行");
    // text 全文絕不能出現在回傳裡
    expect(result).not.toContain("LEAK_CANARY");
  });

  it("空檔回退 fallback", async () => {
    await writeFile(join(dir, "timeline.jsonl"), "");
    expect(await latestDetail(dir, "fallback")).toBe("fallback");
  });

  it("最後一行是壞 JSON 時回退 fallback", async () => {
    await writeTimeline([JSON.stringify({ detail: "好的一行" }), "{ 壞掉的 json"]);
    expect(await latestDetail(dir, "fallback")).toBe("fallback");
  });

  it("檔案不存在時回退 fallback（不丟錯）", async () => {
    expect(await latestDetail(dir, "fallback")).toBe("fallback");
  });

  it("detail 為空字串時回退 fallback", async () => {
    await writeTimeline([JSON.stringify({ detail: "" })]);
    expect(await latestDetail(dir, "fallback")).toBe("fallback");
  });
});
