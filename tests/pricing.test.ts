import { describe, it, expect } from "vitest";
import { contextLimitFor, estimateCostUsd, findPrice } from "@server/pricing.js";

const M = 1_000_000;

describe("pricing 前綴比對", () => {
  it("帶日期後綴與 [1m] 也比得到", () => {
    expect(findPrice("claude-sonnet-4-6-20260101")?.prefix).toBe("claude-sonnet-4-6");
    expect(findPrice("claude-opus-5-5[1m]")?.prefix).toBe("claude-opus-5-5");
  });

  it("取最長前綴：opus-5-5 不被 opus-5 吃掉，fable-5-1 不被 fable-5 吃掉", () => {
    expect(findPrice("claude-opus-5-5")?.output).toBe(20);
    expect(findPrice("claude-opus-5")?.output).toBe(25);
    expect(findPrice("claude-fable-5-1")?.cacheRead).toBe(0.25);
    expect(findPrice("claude-fable-5")?.cacheRead).toBe(1.0);
  });

  it("不認得的模型 → 無價格、無成本", () => {
    expect(findPrice("gpt-5")).toBeUndefined();
    expect(findPrice(undefined)).toBeUndefined();
    expect(
      estimateCostUsd("gpt-5", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    ).toBeUndefined();
  });
});

describe("pricing 成本與 context 上限", () => {
  it("sonnet-4-6：沒列 cacheRead 用 input x 0.1；cache write 用 input x 1.25", () => {
    const c = estimateCostUsd("claude-sonnet-4-6", {
      inputTokens: M,
      outputTokens: M,
      cacheReadTokens: M,
      cacheCreationTokens: M,
    });
    expect(c).toBeCloseTo(3 + 15 + 0.3 + 3.75, 6);
  });

  it("opus-5-5 使用明列的 cacheRead 0.20", () => {
    const c = estimateCostUsd("claude-opus-5-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: M,
      cacheCreationTokens: 0,
    });
    expect(c).toBeCloseTo(0.2, 6);
  });

  it("haiku-4-5 context 20 萬，其餘 100 萬", () => {
    expect(contextLimitFor("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(contextLimitFor("claude-opus-5")).toBe(1_000_000);
    expect(contextLimitFor("unknown")).toBeUndefined();
  });
});
