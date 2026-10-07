import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionEventsReader, waitingFor } from "@server/collectors/sessionEvents.js";

const rotatePath = new URL("../hooks/rotate.mjs", import.meta.url).href;
const MAX = 100;

describe("hooks/rotate.mjs rotateIfNeeded", () => {
  let dir: string;
  let out: string;
  let rotateIfNeeded: (out: string, max: number, stat?: (p: string) => { size: number }) => void;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-rot-"));
    out = join(dir, "events.jsonl");
    ({ rotateIfNeeded } = await import(/* @vite-ignore */ rotatePath));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("超過上限 → 舊內容整份進 .1，新檔從空開始", async () => {
    await writeFile(out, "x".repeat(MAX + 1));
    rotateIfNeeded(out, MAX);
    expect(await readFile(out + ".1", "utf8")).toBe("x".repeat(MAX + 1));
    await expect(stat(out)).rejects.toThrow();
  });

  it("競態：預檢看到大檔、動手前已被另一支 rotate（現在是小的新檔）→ 不得蓋掉 .1，新檔內容保留", async () => {
    // 另一支 hook 已經 rotate 完：.1 是大的舊內容，out 是剛開始累積的新檔
    await writeFile(out + ".1", "OLD-BIG-CONTENT");
    await writeFile(out, '{"ts":1,"new":true}\n');
    // 預檢謊報成大檔（模擬 stat 與 rename 之間的 TOCTOU）
    rotateIfNeeded(out, MAX, () => ({ size: MAX + 1 }));
    expect(await readFile(out + ".1", "utf8")).toBe("OLD-BIG-CONTENT");
    expect(await readFile(out, "utf8")).toBe('{"ts":1,"new":true}\n');
    // 沒有殘留暫名檔
    expect((await readdir(dir)).sort()).toEqual(["events.jsonl", "events.jsonl.1"]);
  });

  it("沒超過上限或檔案不存在 → 什麼都不做、不丟例外", async () => {
    expect(() => rotateIfNeeded(out, MAX)).not.toThrow();
    await writeFile(out, "small");
    rotateIfNeeded(out, MAX);
    expect(statSync(out).size).toBe(5);
  });
});

describe("sessionEvents reader 啟動時讀 .1", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aimon-sev1-"));
    file = join(dir, "session-events.jsonl");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const A = "aaaaaaaa-1111-2222-3333-444444444444";
  const B = "bbbbbbbb-1111-2222-3333-444444444444";

  it("只在 .1 裡有事件的 session 也拿得到最新狀態；主檔較新的事件優先", async () => {
    await writeFile(file + ".1", JSON.stringify({ ts: 1, ev: "stop", session_id: A }) + "\n" + JSON.stringify({ ts: 1, ev: "stop", session_id: B }) + "\n");
    await writeFile(file, JSON.stringify({ ts: 2, ev: "prompt", session_id: B }) + "\n");
    const r = createSessionEventsReader(file);
    await r.refresh();
    expect(waitingFor(r.state, A)).toBe("input");
    expect(waitingFor(r.state, B)).toBeUndefined();
    // 之後的增量讀取照常
    await appendFile(file, JSON.stringify({ ts: 3, ev: "stop", session_id: B }) + "\n");
    await r.refresh();
    expect(waitingFor(r.state, B)).toBe("input");
  });
});
