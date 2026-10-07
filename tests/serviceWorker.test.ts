import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const SRC = readFileSync(new URL("../web/public/sw.js", import.meta.url), "utf8");
const ORIGIN = "http://localhost:4321";

type Handler = (e: Record<string, unknown>) => void;

/** 在 vm 裡載入 sw.js，提供假的 self / caches / fetch */
function loadSw(opts: { existing?: string[]; fetchImpl?: (req: unknown) => Promise<unknown> } = {}) {
  const handlers: Record<string, Handler> = {};
  const stores = new Map<string, Map<string, unknown>>();
  for (const name of opts.existing ?? []) stores.set(name, new Map());
  const puts: { cache: string; key: string }[] = [];
  const cacheObj = (name: string) => ({
    addAll: async () => {},
    put: async (key: unknown, value: unknown) => {
      const k = typeof key === "string" ? key : (key as { url: string }).url;
      puts.push({ cache: name, key: k });
      stores.get(name)!.set(k, value);
    },
  });
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      return cacheObj(name);
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async () => undefined,
  };
  const self = {
    addEventListener: (type: string, fn: Handler) => (handlers[type] = fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    location: { origin: ORIGIN },
  };
  runInNewContext(SRC, { self, caches, fetch: opts.fetchImpl ?? (async () => ({})), URL, Promise, Response: class {} });
  return { handlers, stores, puts };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const fetchEvent = (url: string, mode: string) => {
  let responded: Promise<unknown> | undefined;
  const e = {
    request: { method: "GET", url, mode },
    respondWith: (p: Promise<unknown>) => (responded = p),
  };
  return { e, responded: () => responded };
};

const res = (ok: boolean) => ({ ok, status: ok ? 200 : 500, clone: () => res(ok) });

describe("sw.js", () => {
  it("navigate 回應不是 ok（例如 500／錯誤頁）時不更新快取殼", async () => {
    const sw = loadSw({ fetchImpl: async () => res(false) });
    const { e, responded } = fetchEvent(ORIGIN + "/", "navigate");
    sw.handlers.fetch!(e);
    await responded();
    await flush();
    expect(sw.puts.filter((p) => p.key === "/")).toEqual([]);
  });

  it("navigate 回應 ok 時才更新快取殼", async () => {
    const sw = loadSw({ fetchImpl: async () => res(true) });
    const { e, responded } = fetchEvent(ORIGIN + "/", "navigate");
    sw.handlers.fetch!(e);
    await responded();
    await flush();
    expect(sw.puts.filter((p) => p.key === "/")).toHaveLength(1);
  });

  it("cache 名稱帶版本；activate 時刪除舊版 cache，只留目前這份", async () => {
    const sw = loadSw({ existing: ["ai-monitor-shell-v1", "ai-monitor-shell-v2"] });
    let waited: Promise<unknown> | undefined;
    sw.handlers.install!({ waitUntil: (p: Promise<unknown>) => (waited = p) });
    await waited;
    const current = [...sw.stores.keys()].filter((k) => !["ai-monitor-shell-v1", "ai-monitor-shell-v2"].includes(k));
    expect(current).toHaveLength(1);
    expect(current[0]).toMatch(/^ai-monitor-shell-v\d+/);

    sw.handlers.activate!({ waitUntil: (p: Promise<unknown>) => (waited = p) });
    await waited;
    expect([...sw.stores.keys()]).toEqual(current);
  });

  it("/api 與 /events 不攔截", () => {
    const sw = loadSw();
    for (const p of ["/api/state", "/events"]) {
      const { e, responded } = fetchEvent(ORIGIN + p, "cors");
      sw.handlers.fetch!(e);
      expect(responded()).toBeUndefined();
    }
  });

  it("靜態資產分支：回應不是 ok 不寫進快取；ok 才寫", async () => {
    const bad = loadSw({ fetchImpl: async () => res(false) });
    const a = fetchEvent(ORIGIN + "/assets/index-abc.js", "no-cors");
    bad.handlers.fetch!(a.e);
    await a.responded();
    await flush();
    expect(bad.puts.filter((p) => p.key.endsWith("/assets/index-abc.js"))).toEqual([]);

    const good = loadSw({ fetchImpl: async () => res(true) });
    const b = fetchEvent(ORIGIN + "/assets/index-abc.js", "no-cors");
    good.handlers.fetch!(b.e);
    await b.responded();
    await flush();
    expect(good.puts.filter((p) => p.key.endsWith("/assets/index-abc.js"))).toHaveLength(1);
  });
});
