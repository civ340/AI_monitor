/**
 * 模型價格表 —— 估算用，cached 2026-09-25，可自行調整。
 * 單位：每百萬 token 美元。實際帳單以官方為準；這裡只是讓儀表板有個數量級的概念。
 *
 * - 沒列 cacheRead 的用 input × 0.1
 * - cache write（cache creation）一律 input × 1.25
 */
export type ModelPrice = {
  /** 模型名前綴（比對時取最長的符合者，所以 claude-opus-5-5 會贏過 claude-opus-5） */
  prefix: string;
  input: number;
  output: number;
  cacheRead?: number;
  contextLimit: number;
};

const MILLION_CONTEXT = 1_000_000;

export const PRICES: ModelPrice[] = [
  { prefix: "claude-fable-5-1", input: 10, output: 50, cacheRead: 0.25, contextLimit: MILLION_CONTEXT },
  { prefix: "claude-fable-5", input: 10, output: 50, cacheRead: 1.0, contextLimit: MILLION_CONTEXT },
  { prefix: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.2, contextLimit: MILLION_CONTEXT },
  { prefix: "claude-opus-5", input: 5, output: 25, contextLimit: MILLION_CONTEXT },
  { prefix: "claude-opus-4-8", input: 5, output: 25, contextLimit: MILLION_CONTEXT },
  { prefix: "claude-opus-4-7", input: 5, output: 25, contextLimit: MILLION_CONTEXT },
  { prefix: "claude-opus-4-6", input: 5, output: 25, contextLimit: MILLION_CONTEXT },
  { prefix: "claude-sonnet-5-5", input: 2, output: 10, cacheRead: 0.2, contextLimit: MILLION_CONTEXT },
  { prefix: "claude-sonnet-5", input: 2, output: 10, cacheRead: 0.2, contextLimit: MILLION_CONTEXT },
  { prefix: "claude-sonnet-4-6", input: 3, output: 15, contextLimit: MILLION_CONTEXT },
  { prefix: "claude-haiku-4-5", input: 1, output: 5, contextLimit: 200_000 },
];

/** 前綴比對：transcript 的 model 可能帶日期後綴或 `[1m]` 之類；比不到回 undefined */
export function findPrice(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  let best: ModelPrice | undefined;
  for (const p of PRICES) {
    if (m.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix.length)) best = p;
  }
  return best;
}

export type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

/** 估算美元成本；模型不在價格表內回 undefined（不猜） */
export function estimateCostUsd(model: string | undefined, t: TokenCounts): number | undefined {
  const p = findPrice(model);
  if (!p) return undefined;
  const cacheRead = p.cacheRead ?? p.input * 0.1;
  const cacheWrite = p.input * 1.25;
  return (
    (t.inputTokens * p.input +
      t.outputTokens * p.output +
      t.cacheReadTokens * cacheRead +
      t.cacheCreationTokens * cacheWrite) /
    1_000_000
  );
}

export function contextLimitFor(model: string | undefined): number | undefined {
  return findPrice(model)?.contextLimit;
}
