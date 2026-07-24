import { describe, it, expect } from "vitest";
import { isAlive } from "@server/collectors/isAlive.js";

describe("isAlive", () => {
  it("目前這個 process 一定活著", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it("不可能存在的 pid 判為死亡", () => {
    // 極大 pid 幾乎不可能被使用，process.kill 會丟 ESRCH
    expect(isAlive(2_000_000_000)).toBe(false);
  });

  it("非法輸入一律當死亡（不是活著）", () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(null)).toBe(false);
    expect(isAlive(undefined)).toBe(false);
    expect(isAlive(NaN)).toBe(false);
  });
});
