import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyUsageLine,
  createTranscriptUsageReader,
  createUsageTracker,
  encodeProjectDir,
  parseAssistantUsage,
  summarizeUsage,
} from "@server/collectors/claudeUsage.js";

const SID = "aaaaaaaa-1111-2222-3333-444444444444";
const SECRET = "TOP-SECRET-CONVERSATION-TEXT";

function asst(id: string, usage: Record<string, unknown>, model = "claude-sonnet-4-6", extra: object = {}): string {
  return JSON.stringify({
    type: "assistant",
    ...extra,
    message: { id, model, role: "assistant", content: [{ type: "text", text: SECRET }], usage },
  });
}

describe("parseAssistantUsage", () => {
  it("只取 assistant 行的 id / model / 數字用量", () => {
    const r = parseAssistantUsage(
      asst("m1", { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 11 }),
    );
    expect(r).toEqual({
      id: "m1",
      usage: {
        model: "claude-sonnet-4-6",
        inputTokens: 3,
        outputTokens: 5,
        cacheReadTokens: 7,
        cacheCreationTokens: 11,
        sidechain: false,
      },
    });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("非 assistant、壞 JSON、沒有 usage／id、synthetic 模型都處理得宜", () => {
    expect(parseAssistantUsage(JSON.stringify({ type: "user", message: { content: "assistant" } }))).toBeNull();
    expect(parseAssistantUsage("{ 壞掉 assistant")).toBeNull();
    expect(parseAssistantUsage(JSON.stringify({ type: "assistant", message: { id: "x" } }))).toBeNull();
    expect(parseAssistantUsage(JSON.stringify({ type: "assistant", message: { usage: {} } }))).toBeNull();
    const syn = parseAssistantUsage(asst("s", { input_tokens: 0 }, "<synthetic>"));
    expect(syn?.usage.model).toBeUndefined();
  });

  it("負數／非數字欄位當 0", () => {
    const r = parseAssistantUsage(asst("m", { input_tokens: -5, output_tokens: "9" }));
    expect(r?.usage.inputTokens).toBe(0);
    expect(r?.usage.outputTokens).toBe(0);
  });
});

describe("summarizeUsage", () => {
  it("同一個 message.id 多行只算一次（後到的覆蓋）", () => {
    const t = createUsageTracker();
    applyUsageLine(t, asst("m1", { input_tokens: 1, output_tokens: 2 }));
    applyUsageLine(t, asst("m1", { input_tokens: 1, output_tokens: 50 }));
    applyUsageLine(
      t,
      asst("m2", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
    );
    const u = summarizeUsage(t)!;
    expect(u.inputTokens).toBe(11);
    expect(u.outputTokens).toBe(55);
    expect(u.cacheReadTokens).toBe(100);
    expect(u.cacheCreationTokens).toBe(20);
  });

  it("contextTokens = 最後一則 input+cacheRead+cacheCreation，附 model 與 contextLimit", () => {
    const t = createUsageTracker();
    applyUsageLine(t, asst("m1", { input_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 }));
    applyUsageLine(
      t,
      asst("m2", { input_tokens: 2, cache_read_input_tokens: 30, cache_creation_input_tokens: 400 }, "claude-haiku-4-5-2025"),
    );
    const u = summarizeUsage(t)!;
    expect(u.contextTokens).toBe(432);
    expect(u.model).toBe("claude-haiku-4-5-2025");
    expect(u.contextLimit).toBe(200_000);
  });

  it("sidechain 訊息計入總量，但不影響 contextTokens", () => {
    const t = createUsageTracker();
    applyUsageLine(t, asst("m1", { input_tokens: 5 }));
    applyUsageLine(t, asst("m2", { input_tokens: 9999 }, "claude-sonnet-4-6", { isSidechain: true }));
    const u = summarizeUsage(t)!;
    expect(u.inputTokens).toBe(10_004);
    expect(u.contextTokens).toBe(5);
  });

  it("成本逐則依各自模型計價；全部不認得 → 不填 costUsd", () => {
    const t = createUsageTracker();
    applyUsageLine(t, asst("m1", { input_tokens: 1_000_000 }, "claude-sonnet-4-6"));
    expect(summarizeUsage(t)?.costUsd).toBeCloseTo(3, 6);
    const t2 = createUsageTracker();
    applyUsageLine(t2, asst("m1", { input_tokens: 1_000_000 }, "mystery-model"));
    expect(summarizeUsage(t2)?.costUsd).toBeUndefined();
  });

  it("沒有任何 assistant 行 → 不給 usage", () => {
    expect(summarizeUsage(createUsageTracker())).toBeUndefined();
  });
});

describe("encodeProjectDir", () => {
  it("非英數字元全換成 -", () => {
    expect(encodeProjectDir("C:\\lab\\AI_monitor")).toBe("C--lab-AI-monitor");
  });
});

describe("createTranscriptUsageReader（暫存目錄 + 增量 offset）", () => {
  let root: string;
  const cwd = "C:\\lab\\proj";
  let file: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aimon-usage-"));
    await mkdir(join(root, encodeProjectDir(cwd)), { recursive: true });
    file = join(root, encodeProjectDir(cwd), `${SID}.jsonl`);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("找不到 transcript → 不填 usage", async () => {
    const r = createTranscriptUsageReader(root);
    expect(await r.read(SID, cwd)).toEqual({});
  });

  it("增量讀取：追加的行才被讀，重複 id 不重複計算，半行等下次", async () => {
    const r = createTranscriptUsageReader(root);
    await writeFile(
      file,
      asst("m1", { input_tokens: 1, output_tokens: 1 }) + "\n" + JSON.stringify({ type: "user" }) + "\n",
    );
    const a = await r.read(SID, cwd);
    expect(a.usage?.inputTokens).toBe(1);
    expect(a.mtimeMs).toBeGreaterThan(0);

    // 同一 id 的串流分段 + 新訊息，其中新訊息只寫了一半
    const full = asst("m2", { input_tokens: 10, output_tokens: 10 });
    await appendFile(file, asst("m1", { input_tokens: 1, output_tokens: 4 }) + "\n" + full.slice(0, 40));
    const b = await r.read(SID, cwd);
    expect(b.usage?.inputTokens).toBe(1);
    expect(b.usage?.outputTokens).toBe(4);

    await appendFile(file, full.slice(40) + "\n");
    const c = await r.read(SID, cwd);
    expect(c.usage?.inputTokens).toBe(11);
    expect(c.usage?.outputTokens).toBe(14);
  });

  it("cwd 編碼對不上時掃描 projects 目錄找到", async () => {
    const r = createTranscriptUsageReader(root);
    await writeFile(file, asst("m1", { input_tokens: 2 }) + "\n");
    expect((await r.read(SID, "D:\\somewhere\\else")).usage?.inputTokens).toBe(2);
  });

  it("sessionId 不是 UUID（路徑穿越）→ 直接拒絕", async () => {
    const r = createTranscriptUsageReader(root);
    expect(await r.read("../../etc/passwd", cwd)).toEqual({});
  });

  it("輸出不含任何對話文字", async () => {
    const r = createTranscriptUsageReader(root);
    await writeFile(file, asst("m1", { input_tokens: 2 }) + "\n");
    expect(JSON.stringify(await r.read(SID, cwd))).not.toContain(SECRET);
  });

  it("background 模式：首次 read 立刻回（無 usage、有 mtime），讀完才 onPrimed 並帶 usage；超過 chunk 的大檔也讀得完整", async () => {
    // 比 READ_CHUNK_BYTES（2MB）大，且中文字元會被切在 chunk 邊界
    const pad = "測".repeat(1000);
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) lines.push(asst(`m${i}`, { input_tokens: 1, output_tokens: 2 }, "claude-sonnet-4-6", { pad }));
    await writeFile(file, lines.join("\n") + "\n");
    let primed = 0;
    const r = createTranscriptUsageReader(root, { background: true, onPrimed: () => primed++ });
    const first = await r.read(SID, cwd);
    expect(first.usage).toBeUndefined();
    expect(first.mtimeMs).toBeGreaterThan(0);
    expect(primed).toBe(0);
    await vi.waitFor(() => expect(primed).toBe(1));
    const second = await r.read(SID, cwd);
    expect(second.usage?.inputTokens).toBe(1000);
    expect(second.usage?.outputTokens).toBe(2000);
    expect(primed).toBe(1);
  });
});
