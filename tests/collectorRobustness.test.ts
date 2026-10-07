import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureOf } from "@server/collectors/claudeJobs.js";
import { toAgent } from "@server/collectors/codexJobs.js";
import { readRollout } from "@server/collectors/codexCli.js";

describe("claudeJobs failureOf：非字串欄位不丟例外", () => {
  it("error 是物件 → 退回 detail / 'failed'", () => {
    expect(() => failureOf({ state: "failed", error: { message: "x" } as unknown as string })).not.toThrow();
    expect(failureOf({ state: "failed", error: { message: "x" } as unknown as string })).toBe("failed");
    expect(failureOf({ state: "failed", error: { message: "x" } as unknown as string, detail: "d" })).toBe("d");
  });
  it("detail 是數字、exitCode 非 0 → exit code 摘要", () => {
    expect(failureOf({ exitCode: 1, detail: 42 as unknown as string })).toBe("exit code 1");
  });
});

describe("codexJobs toAgent：壞欄位不丟例外", () => {
  it("errorMessage / summary / title 非字串", () => {
    const a = toAgent(
      { id: "j", status: "failed", errorMessage: { a: 1 }, summary: 5, title: ["t"], updatedAt: new Date().toISOString() } as never,
      "p",
    );
    expect(a?.state).toBe("error");
    expect(a?.error).toBe("failed");
    expect(typeof a?.detail === "string" || a?.detail === undefined).toBe(true);
  });
  it("job 本身是 null → null", () => {
    expect(toAgent(null as never, "p")).toBeNull();
  });
});

describe("codexCli readRollout：error / user_message 的 message 非字串", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-rollout-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("仍回傳 working 與 error，不被整個丟掉", async () => {
    const lines = [
      { type: "session_meta", payload: { cwd: "/work/x" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      { type: "event_msg", payload: { type: "user_message", message: 42 } },
      { type: "event_msg", payload: { type: "error", message: { code: 1 } } },
    ].map((l) => JSON.stringify(l));
    const f = join(dir, "r.jsonl");
    await writeFile(f, lines.join("\n") + "\n");
    const info = await readRollout(f);
    expect(info.working).toBe(true);
    expect(info.error).toBe("error");
    expect(info.cwd).toBe("/work/x");
  });
});
