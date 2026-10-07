import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { SpawnOptions } from "node:child_process";
import {
  checkRequestHeaders,
  childEnv,
  chooseLauncher,
  createThrottle,
  registerOpenRoute,
  resolveAgentDir,
  validateCwdString,
  type ChildLike,
  type Env,
  type FsLike,
  type OpenDeps,
  type SpawnLike,
  type StatLike,
} from "@server/openCwd.js";

// ---------------------------------------------------------------------------
// fakes —— 測試中絕不碰真的 child_process 或檔案系統
// ---------------------------------------------------------------------------

type Entry = "dir" | "file";

/** 以 map 模擬檔案系統；links 模擬 realpath 的改寫（junction / symlink） */
function fakeFs(entries: Record<string, Entry>, links: Record<string, string> = {}): FsLike & { touched: string[] } {
  const touched: string[] = [];
  const stat = (kind: Entry): StatLike => ({ isDirectory: () => kind === "dir", isFile: () => kind === "file" });
  return {
    touched,
    async realpath(p) {
      touched.push(p);
      const real = links[p] ?? p;
      if (!(real in entries)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return real;
    },
    async stat(p) {
      touched.push(p);
      const kind = entries[p];
      if (!kind) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return stat(kind);
    },
  };
}

type SpawnCall = { command: string; args: readonly string[]; options: SpawnOptions };

/** 假 spawn：記下參數，下一個 tick 發 'spawn'（或 'error'） */
function fakeSpawn(mode: "ok" | "error" = "ok"): SpawnLike & { calls: SpawnCall[]; unrefs: number } {
  const calls: SpawnCall[] = [];
  const fn = ((command: string, args: readonly string[], options: SpawnOptions): ChildLike => {
    calls.push({ command, args, options });
    const handlers: Record<string, ((e?: Error) => void)[]> = { spawn: [], error: [] };
    const child: ChildLike = {
      once: (ev: "spawn" | "error", h: (e?: Error) => void) => handlers[ev]!.push(h),
      on: (ev: "error", h: (e: Error) => void) => handlers[ev]!.push(h as (e?: Error) => void),
      unref: () => {
        spawnFn.unrefs++;
      },
    } as ChildLike;
    setImmediate(() => {
      if (mode === "ok") for (const h of handlers.spawn!) h();
      else for (const h of handlers.error!) h(new Error("spawn C:\\secret\\thing ENOENT"));
    });
    return child;
  }) as SpawnLike & { calls: SpawnCall[]; unrefs: number };
  const spawnFn = fn;
  spawnFn.calls = calls;
  spawnFn.unrefs = 0;
  return spawnFn;
}

const PROJ = "C:\\lab\\proj";
const CODE_USER = "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";
const WIN_ENV: Env = {
  SystemRoot: "C:\\Windows",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  ProgramFiles: "C:\\Program Files",
  ELECTRON_RUN_AS_NODE: "1",
  NODE_OPTIONS: "--require evil.js",
  PATH: "C:\\Windows",
};

const AGENTS: Record<string, { cwd?: string }> = {
  "claude:a": { cwd: PROJ },
  "claude:nocwd": {},
  "claude:gone": { cwd: "C:\\lab\\deleted" },
  "claude:unc": { cwd: "\\\\attacker\\share\\x" },
  "claude:dev": { cwd: "\\\\?\\C:\\lab\\proj" },
  "claude:file": { cwd: "C:\\lab\\proj\\file.txt" },
  "claude:comma": { cwd: "C:\\lab\\a,b" },
};

const GOOD_HEADERS = {
  "x-ai-monitor": "1",
  host: "127.0.0.1:4321",
  origin: "http://localhost:5173",
  "content-type": "application/json",
};

let app: FastifyInstance;
let spawn: ReturnType<typeof fakeSpawn>;
let fs: ReturnType<typeof fakeFs>;
let clock: number;

async function build(over: Partial<OpenDeps> = {}): Promise<void> {
  spawn = (over.spawn as ReturnType<typeof fakeSpawn>) ?? fakeSpawn();
  fs =
    (over.fs as ReturnType<typeof fakeFs>) ??
    fakeFs({ [PROJ]: "dir", "C:\\lab\\proj\\file.txt": "file", "C:\\lab\\a,b": "dir", [CODE_USER]: "file" });
  clock = 1_000_000;
  app = Fastify({ logger: false });
  registerOpenRoute(app, {
    lookup: (id) => AGENTS[id],
    platform: "win32",
    env: WIN_ENV,
    allowedPorts: [4321],
    allowedOriginPorts: [4321, 5173],
    now: () => clock,
    ...over,
    fs,
    spawn,
  });
  await app.ready();
}

function post(body: unknown, headers: Record<string, string | undefined> = {}) {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...GOOD_HEADERS, ...headers })) if (v !== undefined) h[k] = v;
  return app.inject({
    method: "POST",
    url: "/api/open",
    headers: h,
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(async () => {
  await build();
});
afterEach(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

describe("POST /api/open 成功路徑", () => {
  it("folder：Windows 用絕對路徑的 explorer.exe，陣列參數、不經 shell、detached + unref", async () => {
    const res = await post({ id: "claude:a", target: "folder" });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(spawn.calls).toHaveLength(1);
    const call = spawn.calls[0]!;
    expect(call.command).toBe("C:\\Windows\\explorer.exe");
    expect(Array.isArray(call.args)).toBe(true);
    expect(call.args).toEqual([PROJ]);
    expect(call.options.shell).not.toBe(true);
    expect(call.options.shell).toBe(false);
    expect(call.options.detached).toBe(true);
    expect(call.options.stdio).toBe("ignore");
    expect(spawn.unrefs).toBe(1);
  });

  it("editor：Windows 直接執行 Code.exe（不是 code.cmd），路徑前加 --，清掉 ELECTRON_RUN_AS_NODE", async () => {
    const res = await post({ id: "claude:a", target: "editor" });
    expect(res.statusCode).toBe(204);
    const call = spawn.calls[0]!;
    expect(call.command).toBe(CODE_USER);
    expect(call.command.toLowerCase().endsWith(".cmd")).toBe(false);
    expect(call.args).toEqual(["--", PROJ]);
    expect(call.options.shell).toBe(false);
    const env = call.options.env as Record<string, string>;
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH).toBe("C:\\Windows");
  });

  it("charset 參數的 application/json 也接受", async () => {
    const res = await post({ id: "claude:a", target: "folder" }, { "content-type": "application/json; charset=utf-8" });
    expect(res.statusCode).toBe(204);
  });

  it("沒有 Origin（非瀏覽器的本機呼叫）也接受；localhost / [::1] 的 Host 也接受", async () => {
    expect((await post({ id: "claude:a", target: "folder" }, { origin: undefined })).statusCode).toBe(204);
    clock += 2000;
    expect((await post({ id: "claude:a", target: "folder" }, { host: "localhost:4321" })).statusCode).toBe(204);
    clock += 2000;
    expect((await post({ id: "claude:a", target: "folder" }, { host: "[::1]:4321" })).statusCode).toBe(204);
  });
});

describe("POST /api/open 找不到／不合法的目錄", () => {
  it("未知 id → 404，不 spawn", async () => {
    const res = await post({ id: "claude:nobody", target: "folder" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: expect.any(String) });
    expect(spawn.calls).toHaveLength(0);
  });

  it("agent 沒有 cwd → 404", async () => {
    const res = await post({ id: "claude:nocwd", target: "folder" });
    expect(res.statusCode).toBe(404);
    expect(spawn.calls).toHaveLength(0);
  });

  it("cwd 不存在 → 404", async () => {
    const res = await post({ id: "claude:gone", target: "folder" });
    expect(res.statusCode).toBe(404);
    expect(spawn.calls).toHaveLength(0);
  });

  it("cwd 是檔案不是資料夾 → 404（避免 explorer 把檔案當程式執行）", async () => {
    const res = await post({ id: "claude:file", target: "folder" });
    expect(res.statusCode).toBe(404);
    expect(spawn.calls).toHaveLength(0);
  });

  it("UNC cwd → 400，且完全沒碰檔案系統（不對遠端發起 SMB 連線）", async () => {
    const res = await post({ id: "claude:unc", target: "folder" });
    expect(res.statusCode).toBe(400);
    expect(fs.touched).toEqual([]);
    expect(spawn.calls).toHaveLength(0);
  });

  it("裝置路徑 \\\\?\\ → 400", async () => {
    const res = await post({ id: "claude:dev", target: "folder" });
    expect(res.statusCode).toBe(400);
    expect(fs.touched).toEqual([]);
  });

  it("realpath 後變成 UNC（junction 指向網路）→ 400，不 spawn", async () => {
    await app.close();
    await build({ fs: fakeFs({ "\\\\srv\\share\\p": "dir" }, { [PROJ]: "\\\\srv\\share\\p" }) });
    const res = await post({ id: "claude:a", target: "folder" });
    expect(res.statusCode).toBe(400);
    expect(spawn.calls).toHaveLength(0);
  });

  it("explorer 不能安全處理含逗號的路徑 → 400；同一路徑用 editor 開沒問題", async () => {
    expect((await post({ id: "claude:comma", target: "folder" })).statusCode).toBe(400);
    clock += 2000;
    expect((await post({ id: "claude:comma", target: "editor" })).statusCode).toBe(204);
    expect(spawn.calls).toHaveLength(1);
  });

  it("Windows 找不到 Code.exe → 501 找不到 VS Code", async () => {
    await app.close();
    await build({ fs: fakeFs({ [PROJ]: "dir" }) });
    const res = await post({ id: "claude:a", target: "editor" });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: "找不到 VS Code" });
    expect(spawn.calls).toHaveLength(0);
  });

  it("spawn 失敗 → 500，訊息不帶系統細節", async () => {
    await app.close();
    await build({ spawn: fakeSpawn("error") });
    const res = await post({ id: "claude:a", target: "folder" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret");
    expect(res.body).not.toContain("ENOENT");
    expect(res.json()).toEqual({ error: expect.any(String) });
  });
});

describe("POST /api/open CSRF / DNS rebinding", () => {
  it("缺 X-AI-Monitor → 403", async () => {
    const res = await post({ id: "claude:a", target: "folder" }, { "x-ai-monitor": undefined });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: expect.any(String) });
    expect(spawn.calls).toHaveLength(0);
  });

  it("X-AI-Monitor 值不是 1 → 403", async () => {
    expect((await post({ id: "claude:a", target: "folder" }, { "x-ai-monitor": "true" })).statusCode).toBe(403);
  });

  it("Host 不在白名單（rebinding 網域、錯的 port、沒 port）→ 403", async () => {
    for (const host of ["evil.example:4321", "127.0.0.1:5173", "localhost", "127.0.0.1.evil.example:4321", "0.0.0.0:4321"]) {
      const res = await post({ id: "claude:a", target: "folder" }, { host });
      expect(res.statusCode, host).toBe(403);
    }
    expect(spawn.calls).toHaveLength(0);
  });

  it("外部 Origin / null Origin → 403", async () => {
    for (const origin of ["http://evil.example", "http://localhost.evil.example:5173", "null", "file://", "http://127.0.0.2:5173"]) {
      const res = await post({ id: "claude:a", target: "folder" }, { origin });
      expect(res.statusCode, origin).toBe(403);
    }
    expect(spawn.calls).toHaveLength(0);
  });

  it("vite dev port 的 Origin 也接受", async () => {
    expect((await post({ id: "claude:a", target: "folder" }, { origin: "http://localhost:5173" })).statusCode).toBe(204);
  });

  it("Origin 只接受 server port 與 vite dev port；其他 loopback port 或沒寫 port → 403", async () => {
    expect((await post({ id: "claude:a", target: "folder" }, { origin: "http://127.0.0.1:4321" })).statusCode).toBe(204);
    for (const origin of ["http://127.0.0.1:9999", "http://localhost:3000", "http://localhost", "https://127.0.0.1"]) {
      expect((await post({ id: "claude:a", target: "folder" }, { origin })).statusCode, origin).toBe(403);
    }
  });

  it("Content-Type 不是 application/json → 415（text/plain 等 simple request 用的 type 全擋）", async () => {
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const res = await post({ id: "claude:a", target: "folder" }, { "content-type": ct });
      expect(res.statusCode, ct).toBe(415);
      expect(res.json()).toEqual({ error: expect.any(String) });
    }
    expect(spawn.calls).toHaveLength(0);
  });

  it("沒有 Content-Type → 415", async () => {
    const res = await post({ id: "claude:a", target: "folder" }, { "content-type": undefined });
    expect(res.statusCode).toBe(415);
  });
});

describe("POST /api/open body 驗證", () => {
  const bad: [string, unknown][] = [
    ["缺 target", { id: "claude:a" }],
    ["缺 id", { target: "folder" }],
    ["target 不在 enum", { id: "claude:a", target: "shell" }],
    ["id 太長", { id: "x".repeat(201), target: "folder" }],
    ["id 空字串", { id: "", target: "folder" }],
    ["id 是物件", { id: { $ne: 1 }, target: "folder" }],
    ["多餘欄位（例如想夾帶 path）", { id: "claude:a", target: "folder", path: "C:\\Windows" }],
    ["不是物件", ["claude:a", "folder"]],
  ];
  for (const [name, body] of bad) {
    it(`${name} → 400`, async () => {
      const res = await post(body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: expect.any(String) });
      expect(spawn.calls).toHaveLength(0);
    });
  }

  it("壞 JSON → 400，回應不帶 parser 細節", async () => {
    const res = await post("{ not json");
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json())).toEqual(["error"]);
  });

  it("body 過大 → 413", async () => {
    const res = await post({ id: "claude:a", target: "folder", pad: "x".repeat(4000) });
    expect(res.statusCode).toBe(413);
    expect(Object.keys(res.json())).toEqual(["error"]);
  });
});

describe("POST /api/open 節流", () => {
  it("同一個 id 1 秒內第二次 → 429，只 spawn 一次；過了 1 秒再放行", async () => {
    expect((await post({ id: "claude:a", target: "folder" })).statusCode).toBe(204);
    clock += 500;
    expect((await post({ id: "claude:a", target: "editor" })).statusCode).toBe(429);
    expect(spawn.calls).toHaveLength(1);
    clock += 600;
    expect((await post({ id: "claude:a", target: "folder" })).statusCode).toBe(204);
    expect(spawn.calls).toHaveLength(2);
  });

  it("不同 id 互不影響", async () => {
    expect((await post({ id: "claude:a", target: "folder" })).statusCode).toBe(204);
    expect((await post({ id: "claude:comma", target: "editor" })).statusCode).toBe(204);
  });

  it("未知 id 不佔節流表（不能用亂數 id 撐爆記憶體）", () => {
    // 由路由順序保證：lookup 失敗在節流之前就 404。這裡直接驗 throttle 會清掉過期項目
    let t = 0;
    const allow = createThrottle(1000, () => t);
    expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(false);
    t = 1000;
    expect(allow("a")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 純函式
// ---------------------------------------------------------------------------

describe("validateCwdString", () => {
  it("Windows：接受磁碟機絕對路徑", () => {
    expect(validateCwdString("C:\\a\\b", "win32")).toBe("C:\\a\\b");
    expect(validateCwdString("d:/a", "win32")).toBe("d:/a");
  });
  it.each([
    ["\\\\server\\share", 400],
    ["//server/share", 400],
    ["\\\\?\\C:\\x", 400],
    ["\\\\.\\PhysicalDrive0", 400],
    ["\\\\?\\UNC\\srv\\s", 400],
    ["\\foo", 400],
    ["C:foo", 400],
    ["relative\\dir", 400],
    ["C:\\a\\b:stream", 400],
    ["C:\\a\nb", 400],
    ["C:\\a\u0000b", 400],
    ["", 404],
  ])("Windows 拒絕 %j", (p, status) => {
    expect(() => validateCwdString(p, "win32")).toThrow(expect.objectContaining({ status }));
  });
  it("POSIX：要絕對路徑", () => {
    expect(validateCwdString("/home/me/p", "linux")).toBe("/home/me/p");
    expect(() => validateCwdString("home/me", "linux")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => validateCwdString("-rf", "linux")).toThrow(expect.objectContaining({ status: 400 }));
  });
  it("非字串 → 404", () => {
    expect(() => validateCwdString(undefined, "linux")).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => validateCwdString(42, "win32")).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe("resolveAgentDir", () => {
  it("回傳 realpath 後的路徑", async () => {
    const f = fakeFs({ "/real/p": "dir" }, { "/link/p": "/real/p" });
    expect(await resolveAgentDir("/link/p", "linux", f)).toBe("/real/p");
  });
});

describe("chooseLauncher", () => {
  const noFs = fakeFs({});
  it("macOS：/usr/bin/open 與 code --", async () => {
    expect(await chooseLauncher("folder", "/p", "darwin", {}, noFs)).toEqual({ command: "/usr/bin/open", args: ["/p"] });
    expect(await chooseLauncher("editor", "/p", "darwin", {}, noFs)).toEqual({ command: "code", args: ["--", "/p"] });
  });
  it("Linux：xdg-open（不加 --，xdg-open 不認）", async () => {
    expect(await chooseLauncher("folder", "/p", "linux", {}, noFs)).toEqual({ command: "xdg-open", args: ["/p"] });
  });
  it("Windows：Code.exe 依序找 LOCALAPPDATA → ProgramFiles → ProgramFiles(x86)", async () => {
    const pf86 = "C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe";
    const f = fakeFs({ [pf86]: "file" });
    const env = { LOCALAPPDATA: "C:\\L", ProgramFiles: "C:\\P", "ProgramFiles(x86)": "C:\\Program Files (x86)" };
    expect(await chooseLauncher("editor", "C:\\p", "win32", env, f)).toEqual({ command: pf86, args: ["--", "C:\\p"] });
  });
  it("Windows：環境變數是 UNC 時不採用（不對網路路徑做 stat）", async () => {
    const f = fakeFs({});
    await expect(chooseLauncher("editor", "C:\\p", "win32", { LOCALAPPDATA: "\\\\evil\\s" }, f)).rejects.toMatchObject({
      status: 501,
    });
    expect(f.touched).toEqual([]);
  });
  it("Windows：SystemRoot 缺或可疑時退回 C:\\Windows\\explorer.exe", async () => {
    expect((await chooseLauncher("folder", "C:\\p", "win32", { SystemRoot: "\\\\evil\\s" }, noFs)).command).toBe(
      "C:\\Windows\\explorer.exe",
    );
  });
});

describe("checkRequestHeaders", () => {
  it("重複的 header（陣列）視為不合法", () => {
    expect(checkRequestHeaders({ ...GOOD_HEADERS, origin: ["http://localhost", "http://evil"] }, [4321], [4321, 5173])?.status).toBe(403);
    expect(checkRequestHeaders({ ...GOOD_HEADERS, "x-ai-monitor": ["1", "1"] }, [4321], [4321, 5173])?.status).toBe(403);
  });
  it("Origin 帶帳密 → 403", () => {
    expect(checkRequestHeaders({ ...GOOD_HEADERS, origin: "http://a@localhost:5173" }, [4321], [4321, 5173])?.status).toBe(403);
  });
  it("全部正確 → null", () => {
    expect(checkRequestHeaders(GOOD_HEADERS, [4321], [4321, 5173])).toBeNull();
  });
});

describe("childEnv", () => {
  it("大小寫不拘地拿掉 ELECTRON_RUN_AS_NODE / NODE_OPTIONS", () => {
    expect(childEnv({ electron_run_as_node: "1", Node_Options: "x", Path: "p", EMPTY: undefined })).toEqual({ Path: "p" });
  });
});
