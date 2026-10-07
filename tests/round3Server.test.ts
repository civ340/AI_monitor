import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { Collector } from "@shared/types.js";
import { createReadyGate } from "@server/ready.js";
import { registerEventsRoute } from "@server/eventsRoute.js";
import { startCollectorList } from "@server/collectors/index.js";

describe("item 3：/events 在 ready 之前就送出 response headers", () => {
  let app: ReturnType<typeof Fastify> | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it("gate 還沒 ready 時，client 就已收到 200 與 text/event-stream", async () => {
    app = Fastify();
    const gate = createReadyGate(60_000); // 永遠不 ready
    const store = { visible: () => ({ agents: [], overflow: 0 }), subscribe: () => () => {} };
    registerEventsRoute(app, { ready: gate, store });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;

    const status = await new Promise<{ code?: number; type?: string | string[] }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/events" }, (res) => {
        resolve({ code: res.statusCode, type: res.headers["content-type"] });
        res.destroy();
      });
      req.on("error", reject);
      req.end();
      setTimeout(() => reject(new Error("ready 前沒收到 headers")), 2_000).unref();
    });
    expect(status.code).toBe(200);
    expect(status.type).toBe("text/event-stream");
  });
});

describe("item 4：ready gate 逾時一次後不再等", () => {
  afterEach(() => vi.useRealTimers());

  it("第一次 wait 逾時放行後，之後的 wait 立刻 resolve（不再各自等 5 秒）", async () => {
    vi.useFakeTimers();
    const g = createReadyGate(5_000);
    void g.wait();
    await vi.advanceTimersByTimeAsync(5_001);
    let done = false;
    void g.wait().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });
});

describe("item 4：collector 並行啟動，單一卡住或拋錯不影響其他", () => {
  const mk = (name: string, start: Collector["start"]): Collector => ({ name, start, stop: async () => {} });

  it("一個永遠不 resolve、一個拋錯，其餘照常啟動並 emit", async () => {
    const started: string[] = [];
    const got: Record<string, number> = {};
    const hang = mk("hang", () => new Promise<void>(() => {}));
    const boom = mk("boom", async () => {
      throw new Error("start failed");
    });
    const ok = mk("ok", async (emit) => {
      started.push("ok");
      emit([]);
    });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    void startCollectorList([hang, boom, ok], (name) => (got[name] = (got[name] ?? 0) + 1));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(started).toEqual(["ok"]);
    expect(got["ok"]).toBe(1);
    warn.mockRestore();
  });

  it("全部都不卡時 resolve，且拋錯的只 log、不 reject", async () => {
    const boom = mk("boom", async () => {
      throw new Error("x");
    });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(startCollectorList([boom, mk("ok", async () => {})], () => {})).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
