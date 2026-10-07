import { describe, it, expect } from "vitest";
import { failureOf } from "@server/collectors/claudeJobs.js";

describe("claudeJobs failureOf", () => {
  it("state failed / error → 摘要取 error，其次 detail", () => {
    expect(failureOf({ state: "failed", detail: "壞了" })).toBe("壞了");
    expect(failureOf({ state: "error", error: "boom", detail: "x" })).toBe("boom");
  });

  it("非 0 exitCode → error，沒有文字時用 exit code", () => {
    expect(failureOf({ state: "done", exitCode: 3 })).toBe("exit code 3");
  });

  it("working / done / blocked / exitCode 0 → 不是失敗", () => {
    expect(failureOf({ state: "working" })).toBeUndefined();
    expect(failureOf({ state: "done", exitCode: 0 })).toBeUndefined();
    expect(failureOf({ state: "blocked" })).toBeUndefined();
  });

  it("摘要截斷 160 字、壓成單行", () => {
    const s = failureOf({ state: "failed", detail: "a\n" + "b".repeat(300) });
    expect(s?.length).toBe(160);
    expect(s).not.toContain("\n");
  });
});
