/**
 * POST /api/open —— 點角色，在本機用檔案總管／VS Code 開啟該 agent 的工作目錄。
 *
 * 這是「瀏覽器觸發本機程式執行」的入口，設計上的底線：
 *   1. 路徑絕不來自 client：只收 agent id，cwd 一律從 store 查。
 *   2. cwd 本身也不盲信：必須是本機磁碟上的絕對路徑，UNC／裝置路徑在碰檔案系統之前就擋掉
 *      （對 \\attacker\share 做 realpath 會觸發 SMB 連線，等於把 NTLM 雜湊送出去）。
 *   3. 不經 shell：spawn 陣列參數、shell:false、執行檔用絕對路徑（Windows 的 libuv 找 PATH
 *      前會先找目前目錄，用裸名 explorer.exe 有被同名檔劫持的風險）。
 *   4. CSRF／DNS rebinding：自訂 header + Host 白名單 + Origin 必須是 loopback + 強制 JSON。
 *
 * 所有外部依賴（spawn / fs / platform / env / 時鐘 / agent 查詢）都可注入，測試中絕不真的開視窗。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SpawnOptions } from "node:child_process";
import path from "node:path";

export type OpenTarget = "folder" | "editor";

export type StatLike = { isDirectory(): boolean; isFile(): boolean };

export type FsLike = {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<StatLike>;
};

/** child_process.spawn 回傳值中我們用得到的部分 */
export type ChildLike = {
  once(event: "spawn", fn: () => void): unknown;
  once(event: "error", fn: (err: Error) => void): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
  unref(): void;
};

export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildLike;

export type Env = Readonly<Record<string, string | undefined>>;

export type Launcher = { command: string; args: string[] };

export type OpenDeps = {
  /** 依 id 查 agent；只會讀 cwd */
  lookup(id: string): { cwd?: string } | undefined;
  fs: FsLike;
  spawn: SpawnLike;
  platform: NodeJS.Platform;
  env: Env;
  /** Host header 允許的 port（127.0.0.1 / localhost / [::1] 搭配這些 port） */
  allowedPorts: readonly number[];
  /** Origin header 允許的 port（collector 自己 + vite dev server）。Origin 的 hostname 仍須是 loopback */
  allowedOriginPorts: readonly number[];
  now?: () => number;
  /** 同一個 id 的節流視窗，預設 1000ms */
  throttleMs?: number;
};

/** 對外只帶固定訊息的錯誤；status 直接當 HTTP 狀態碼 */
export class OpenError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenError";
  }
}

// ---------------------------------------------------------------------------
// 請求驗證（header 層）
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

type Headers = Readonly<Record<string, string | string[] | undefined>>;

function single(h: string | string[] | undefined): string | undefined {
  // 重複的 header 一律視為可疑，不挑其中一個用
  return typeof h === "string" ? h : undefined;
}

/**
 * header 層的 CSRF／DNS rebinding 防護。通過回 null，否則回對應的 OpenError。
 *
 * - X-AI-Monitor: 1 —— 自訂 header 讓跨站請求一定要先過 preflight，而我們不回任何 CORS
 *   header，所以 preflight 失敗、請求根本送不出來。
 * - Host —— DNS rebinding 時 Host 是攻擊者的網域，不在白名單內。
 *   注意：vite dev proxy 的字串寫法（vite.config.ts 的 "/api": "http://127.0.0.1:4321"）
 *   在 Vite 內部會被展開成 changeOrigin: true，所以經 proxy 進來的 Host 會被改寫成
 *   127.0.0.1:4321；白名單只需要 collector 自己的 port。經 proxy 的 rebinding 由 Vite
 *   自身的 server.allowedHosts 擋，以及下面的 Origin 檢查兜底（proxy 不改寫一般 HTTP 的 Origin）。
 * - Origin —— 有帶就必須是 loopback 且 port 在 allowedOriginPorts 內（collector 自己 + vite dev server），
 *   不再放行任意 port：其他本機服務（任何 loopback 上的網頁）不該能呼叫這支。瀏覽器的 POST 一定帶。
 * - Content-Type —— 必須是 application/json（再加一層：simple request 不能帶這個 type）。
 */
export function checkRequestHeaders(
  headers: Headers,
  allowedPorts: readonly number[],
  allowedOriginPorts: readonly number[],
): OpenError | null {
  if (single(headers["x-ai-monitor"]) !== "1") return new OpenError(403, "拒絕：缺少必要的 header");

  const host = single(headers.host)?.toLowerCase();
  if (!host || !isAllowedHost(host, allowedPorts)) return new OpenError(403, "拒絕：Host 不允許");

  const rawOrigin = headers.origin;
  if (rawOrigin !== undefined) {
    const origin = single(rawOrigin);
    if (origin === undefined || !isAllowedOrigin(origin, allowedOriginPorts)) return new OpenError(403, "拒絕：來源不允許");
  }

  const ct = single(headers["content-type"]);
  const mediaType = ct?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return new OpenError(415, "Content-Type 必須是 application/json");

  return null;
}

function isAllowedHost(host: string, allowedPorts: readonly number[]): boolean {
  // [::1]:4321 → hostname "[::1]"、port "4321"；沒有 port 的 Host 一律拒絕
  const m = /^(\[::1\]|127\.0\.0\.1|localhost):(\d{1,5})$/.exec(host);
  if (!m) return false;
  return allowedPorts.includes(Number(m[2]));
}

function isAllowedOrigin(origin: string, allowedPorts: readonly number[]): boolean {
  // "null"（sandbox iframe、file:// 等）在 URL 解析就會失敗 → 拒絕
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  // 沒寫 port（預設 80/443）一律拒絕，我們的服務都跑在明確的 port 上
  if (!/^\d{1,5}$/.test(u.port) || !allowedPorts.includes(Number(u.port))) return false;
  return LOOPBACK_HOSTNAMES.has(u.hostname.toLowerCase());
}

// ---------------------------------------------------------------------------
// 解析目錄
// ---------------------------------------------------------------------------

const MAX_PATH_LEN = 4096;
// C0 控制字元與 DEL —— 合法的工作目錄不會有，有就代表資料被污染
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * 字串層檢查，**不碰檔案系統**。UNC（\\server\share、//server/share）與裝置路徑
 * （\\?\、\\.\）必須在這裡擋，否則 realpath 就會先對遠端發起連線。
 */
export function validateCwdString(cwd: unknown, platform: NodeJS.Platform): string {
  if (typeof cwd !== "string" || cwd.length === 0) throw new OpenError(404, "這個 agent 沒有工作目錄");
  if (cwd.length > MAX_PATH_LEN || CONTROL_CHARS.test(cwd)) throw new OpenError(400, "工作目錄格式不支援");

  if (platform === "win32") {
    // \\ 或 // 開頭：UNC、\\?\ 與 \\.\ 裝置路徑（含 \\?\UNC\…）全部在此擋下
    if (/^[\\/]{2}/.test(cwd)) throw new OpenError(400, "不支援網路或裝置路徑");
    // 只接受「磁碟機代號 + 根目錄」開頭的絕對路徑；\foo（目前磁碟的根）與 C:foo（相對）都不收
    if (!/^[A-Za-z]:[\\/]/.test(cwd)) throw new OpenError(400, "工作目錄必須是絕對路徑");
    // 磁碟機代號之後不該再有冒號（NTFS alternate data stream 之類）
    if (cwd.indexOf(":", 2) !== -1) throw new OpenError(400, "工作目錄格式不支援");
    if (!path.win32.isAbsolute(cwd)) throw new OpenError(400, "工作目錄必須是絕對路徑");
  } else {
    if (!path.posix.isAbsolute(cwd)) throw new OpenError(400, "工作目錄必須是絕對路徑");
  }
  return cwd;
}

/** realpath 之後的結果再驗一次（junction／symlink／對應磁碟機可能把路徑變成 UNC） */
function validateResolved(real: string, platform: NodeJS.Platform): void {
  if (platform === "win32") {
    if (/^[\\/]{2}/.test(real) || !/^[A-Za-z]:[\\/]/.test(real)) throw new OpenError(400, "不支援網路或裝置路徑");
  } else if (!real.startsWith("/")) {
    throw new OpenError(400, "工作目錄必須是絕對路徑");
  }
  // 參數陣列不經 shell，但仍確保路徑不會被當成 flag
  if (real.startsWith("-")) throw new OpenError(400, "工作目錄格式不支援");
  if (CONTROL_CHARS.test(real)) throw new OpenError(400, "工作目錄格式不支援");
}

/** cwd → 經過驗證、實際存在的目錄的 canonical 路徑 */
export async function resolveAgentDir(cwd: unknown, platform: NodeJS.Platform, fs: FsLike): Promise<string> {
  const checked = validateCwdString(cwd, platform);
  let real: string;
  try {
    real = await fs.realpath(checked);
  } catch {
    throw new OpenError(404, "工作目錄不存在");
  }
  validateResolved(real, platform);
  let st: StatLike;
  try {
    st = await fs.stat(real);
  } catch {
    throw new OpenError(404, "工作目錄不存在");
  }
  // 一定要是目錄：把檔案路徑丟給 explorer / open / xdg-open 等於「用預設程式執行它」
  if (!st.isDirectory()) throw new OpenError(404, "工作目錄不是資料夾");
  return real;
}

// ---------------------------------------------------------------------------
// 選擇執行檔與參數
// ---------------------------------------------------------------------------

/** 環境變數裡的目錄只收本機磁碟的絕對路徑（避免對 UNC 做 stat） */
function localWinDir(v: string | undefined): string | undefined {
  if (!v || /^[\\/]{2}/.test(v) || !/^[A-Za-z]:[\\/]/.test(v) || CONTROL_CHARS.test(v)) return undefined;
  return v;
}

/** Windows 上 VS Code 的 Code.exe 可能位置（user install 優先） */
export function vscodeCandidates(env: Env): string[] {
  const out: string[] = [];
  const local = localWinDir(env.LOCALAPPDATA);
  if (local) out.push(path.win32.join(local, "Programs", "Microsoft VS Code", "Code.exe"));
  const pf = localWinDir(env.ProgramFiles);
  if (pf) out.push(path.win32.join(pf, "Microsoft VS Code", "Code.exe"));
  const pf86 = localWinDir(env["ProgramFiles(x86)"]);
  if (pf86) out.push(path.win32.join(pf86, "Microsoft VS Code", "Code.exe"));
  return out;
}

async function isFile(fs: FsLike, p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * target + 平台 → 執行檔（絕對路徑或不經 shell 的指令名）與參數陣列。
 * dir 必須是 resolveAgentDir 的結果。
 */
export async function chooseLauncher(
  target: OpenTarget,
  dir: string,
  platform: NodeJS.Platform,
  env: Env,
  fs: FsLike,
): Promise<Launcher> {
  if (target === "folder") {
    if (platform === "win32") {
      // explorer.exe 自己用逗號切參數（/select,… /root,…），含逗號的路徑會被拆成多段，
      // 其中一段可能被當成相對檔名交給 ShellExecute。這類路徑罕見，直接拒絕。
      if (dir.includes(",")) throw new OpenError(400, "路徑含逗號，無法安全地用檔案總管開啟");
      const root = localWinDir(env.SystemRoot) ?? localWinDir(env.windir) ?? "C:\\Windows";
      return { command: path.win32.join(root, "explorer.exe"), args: [dir] };
    }
    // open / xdg-open 不認 "--"（xdg-open 會當成未知選項報錯），路徑已確認以 "/" 開頭
    if (platform === "darwin") return { command: "/usr/bin/open", args: [dir] };
    if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
      return { command: "xdg-open", args: [dir] };
    }
    throw new OpenError(501, "這個作業系統不支援開啟資料夾");
  }

  // editor：VS Code
  if (platform === "win32") {
    // `code` 在 Windows 是 code.cmd，直接執行必須經 cmd.exe（有參數注入風險），所以改找 Code.exe。
    // Code.exe 本身支援 "--" 分隔（VS Code 自己註冊的 URL handler 就是 Code.exe --open-url -- "%1"）。
    for (const exe of vscodeCandidates(env)) {
      if (await isFile(fs, exe)) return { command: exe, args: ["--", dir] };
    }
    throw new OpenError(501, "找不到 VS Code");
  }
  // macOS / Linux 的 code 是 shell script，execve 走 shebang，參數一樣是陣列、不經 shell
  return { command: "code", args: ["--", dir] };
}

/**
 * 給子程序的環境變數：拿掉會改變 Electron／Node 行為的變數。
 * ELECTRON_RUN_AS_NODE=1 會讓 Code.exe 變成 node，把目錄當成模組執行（index.js / package.json main）。
 */
export function childEnv(env: Env): Record<string, string> {
  const drop = new Set(["electron_run_as_node", "node_options", "electron_no_attach_console"]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !drop.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * 不經 shell、detached + unref 啟動。等 'spawn' 或 'error' 其中一個事件再回應，
 * 這樣啟動失敗能回 500，且 error 一定有 listener（沒 listener 的 'error' 會讓整個 server 掛掉）。
 */
export function launch(spawn: SpawnLike, launcher: Launcher, env: Env): Promise<void> {
  const options: SpawnOptions = {
    shell: false,
    detached: true,
    stdio: "ignore",
    env: childEnv(env),
    // 刻意不開 windowsHide：我們在 Windows 只啟動 GUI 執行檔（explorer.exe / Code.exe），
    // 本來就不會產生 console 視窗；windowsHide 會在 STARTUPINFO 帶 SW_HIDE，
    // GUI 程式的第一個 ShowWindow 會沿用它，導致 VS Code 冷啟動時視窗是隱藏的。
    windowsHide: false,
  };
  return new Promise<void>((resolve, reject) => {
    let child: ChildLike;
    try {
      child = spawn(launcher.command, launcher.args, options);
    } catch {
      reject(new OpenError(500, "無法啟動程式"));
      return;
    }
    // 永久的 noop listener：spawn 之後的 error 也不能變成 uncaught
    child.on("error", () => {});
    child.once("error", () => reject(new OpenError(500, "無法啟動程式")));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// 節流
// ---------------------------------------------------------------------------

/** 同一個 key 在 windowMs 內只放行一次。key 只會是 store 裡存在的 agent id，數量有界 */
export function createThrottle(windowMs: number, now: () => number): (key: string) => boolean {
  const last = new Map<string, number>();
  return (key) => {
    const t = now();
    for (const [k, at] of last) if (t - at >= windowMs) last.delete(k);
    if (last.has(key)) return false;
    last.set(key, t);
    return true;
  };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

type OpenBody = { id: string; target: OpenTarget };

export const openBodySchema = {
  type: "object",
  required: ["id", "target"],
  // Fastify 預設的 Ajv 開了 removeAdditional，單靠 additionalProperties:false 只會把多的欄位
  // 默默刪掉而不是拒絕；propertyNames 會在刪除之前先驗，多欄位直接 400。
  propertyNames: { enum: ["id", "target"] },
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 200 },
    target: { type: "string", enum: ["folder", "editor"] },
  },
} as const;

function sendError(reply: FastifyReply, err: OpenError): FastifyReply {
  return reply.code(err.status).send({ error: err.message });
}

export function registerOpenRoute(app: FastifyInstance, deps: OpenDeps): void {
  const allow = createThrottle(deps.throttleMs ?? 1000, deps.now ?? Date.now);

  app.post<{ Body: OpenBody }>(
    "/api/open",
    {
      bodyLimit: 1024,
      schema: { body: openBodySchema },
      // header 層檢查放 onRequest：在解析 body 之前就擋
      onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
        const err = checkRequestHeaders(req.headers, deps.allowedPorts, deps.allowedOriginPorts);
        if (err) return sendError(reply, err);
      },
      // 這條路由的錯誤一律回 { error } 且不帶框架或系統細節
      errorHandler: (error: FastifyError, req, reply) => {
        if (error instanceof OpenError) return sendError(reply, error);
        const status = error.statusCode ?? 500;
        if (error.validation || status === 400) return sendError(reply, new OpenError(400, "請求格式錯誤"));
        if (status === 413) return sendError(reply, new OpenError(413, "請求太大"));
        if (status === 415) return sendError(reply, new OpenError(415, "Content-Type 必須是 application/json"));
        req.log.error({ err: error }, "open route failed");
        return sendError(reply, new OpenError(500, "內部錯誤"));
      },
    },
    async (req, reply) => {
      const { id, target } = req.body;
      const agent = deps.lookup(id);
      if (!agent) throw new OpenError(404, "找不到這個 agent");
      if (!allow(id)) throw new OpenError(429, "操作太頻繁，請稍候");
      const dir = await resolveAgentDir(agent.cwd, deps.platform, deps.fs);
      const launcher = await chooseLauncher(target, dir, deps.platform, deps.env, deps.fs);
      await launch(deps.spawn, launcher, deps.env);
      return reply.code(204).send();
    },
  );
}
