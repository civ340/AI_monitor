# AI Agent 辦公室

> English: [README.md](./README.md)

把「監控我的 AI coding agent」變成一個可愛的辦公室場景：每個 agent 是一隻在房間裡走動的
角色，頭上冒出目前在做什麼的對話泡泡，點下去看它手上的任務。資料全部來自本機各 agent
自己寫的狀態檔，即時更新。

## 監控對象

| 工位 | 資料來源 |
|---|---|
| Claude Code（每個 session 一個） | `~/.claude/sessions/`、`~/.claude/tasks/` |
| Claude Code 背景 job | `~/.claude/jobs/` |
| Claude Code session 內 subagent（Task/Agent tool） | `.data/subagents.jsonl`（透過 Claude Code hooks，見下方） |
| Codex（Claude Code 的 codex plugin） | `~/.claude/plugins/data/codex-openai-codex/state/` |
| Codex CLI（直接下 `codex` 指令跑的） | `~/.codex/sessions/` |

常駐 agent（Claude Code、Codex）站在自己的工位；臨時的背景 job 與 session 內 subagent
會走進房間、做完離場。

### 監控範圍：背景 job 與 session 內 subagent

上面每個來源最終都會變成監控讀得到的狀態檔或事件記錄：

- ✅ 會顯示：Claude Code session、`~/.claude/jobs/` 的 daemon job、`/codex:rescue --background`
  等 codex plugin job、原生 `codex` CLI 執行，以及 —— 因為 subagent 本身不會寫狀態檔 ——
  透過 Claude Code hook 補抓到的 Task/Agent tool subagent（scout / executor / verifier 等）。

#### session 內 subagent：怎麼抓到的

subagent 跑在 parent Claude Code 行程**內部**，不會自己寫狀態檔，所以任何 collector 都無法
直接從磁碟讀到它。改用 project-local 的 hook（`.claude/settings.local.json`）在三個 hook
事件觸發時把一筆精簡事件 append 進 `.data/subagents.jsonl`，`server/collectors/claudeSubagents.ts`
再增量讀取這份記錄：

```json
{
  "hooks": {
    "SubagentStart": [{ "matcher": "", "hooks": [
      { "type": "command", "command": "node \"C:/lab/AI_monitor/hooks/record.mjs\"", "async": true, "timeout": 5 }
    ]}],
    "SubagentStop": [{ "matcher": "", "hooks": [
      { "type": "command", "command": "node \"C:/lab/AI_monitor/hooks/record.mjs\"", "async": true, "timeout": 5 }
    ]}],
    "PreToolUse": [{ "matcher": "^(Agent|Task)$", "hooks": [
      { "type": "command", "command": "node \"C:/lab/AI_monitor/hooks/record.mjs\"", "async": true, "timeout": 5 }
    ]}],
    "Notification": [{ "matcher": "", "hooks": [
      { "type": "command", "command": "node \"C:/lab/AI_monitor/hooks/record.mjs\"", "async": true, "timeout": 5 }
    ]}],
    "UserPromptSubmit": [{ "matcher": "", "hooks": [
      { "type": "command", "command": "node \"C:/lab/AI_monitor/hooks/record.mjs\"", "async": true, "timeout": 5 }
    ]}],
    "Stop": [{ "matcher": "", "hooks": [
      { "type": "command", "command": "node \"C:/lab/AI_monitor/hooks/record.mjs\"", "async": true, "timeout": 5 }
    ]}],
    "PostToolUse": [{ "matcher": "", "hooks": [
      { "type": "command", "command": "node \"C:/lab/AI_monitor/hooks/record.mjs\"", "async": true, "timeout": 5 }
    ]}]
  }
}
```

`hooks/record.mjs`依事件做欄位白名單，絕不寫入 prompt、assistant 回覆內容或 transcript
路徑 —— 只留 `ts`、`session_id`、`agent_id`/`tool_use_id`、`subagent_type`/`agent_type`、
截斷過的 `description`、以及 `cwd`。目前這是 project-local 的 hook 註冊（不是 app 本身內建
的功能），所以只有跑在這個 repo 底下的 session 才會觸發。

另外四個事件（`Notification`、`UserPromptSubmit`、`Stop`、`PostToolUse`）寫到另一個檔
`.data/session-events.jsonl`，用來判斷「**等你回覆**」（waiting）狀態。白名單只有 `ts`、`ev`、
`session_id`，Notification 另存截斷過的 `notification_type` —— 絕不寫入通知訊息文字、prompt、
`tool_input`、`transcript_path`。每個 session 以最新一筆事件為準：權限類 Notification →
waiting/permission；`idle_prompt` Notification 或 `Stop` → waiting/input；`UserPromptSubmit` /
`PostToolUse` 則清除。已經 offline 的 session 不會標 waiting。

**重要：waiting 只對有註冊 hook 的專案有效。** waiting 的「原因」與「Claude 回完話、換你了」
（input）都只來自 hook 事件；沒註冊 hook 的專案不會有這些訊號。（Claude Code 自己寫在 session 檔的
`waiting` status 也會被採用當後備、顯示成 waiting/permission，但沒有 hook 就沒有 input 狀態，也分不出
過期與否。）想被監看的每個專案都要註冊 hook。若 waiting 事件之後 session 檔的 status 變回 `busy`
（你已核准、長工具執行中），waiting 會自動清除，不需要額外的 hook。

**歷史檔不存內容文字。** `.data/history.jsonl` 只記狀態轉換（時間、agent id／名稱／類型／cwd、from／to），
絕不存 `detail`（可能是 prompt 開頭或 subagent 描述）；只有轉成 `error` 的事件會帶一行 `error` 摘要
（≤120 字）。今天的事件在記憶體快取，檔案用非同步讀取。

**`server-start` 標記與心跳檔。** 每次啟動 server 會寫一筆 `{"marker":"server-start","id":"server"}` 事件；
收到 SIGINT / SIGTERM / SIGHUP（Windows 另有 SIGBREAK）時會先替每個 agent 寫離場事件。
**Windows 上 `taskkill /F`、直接結束行程或關掉主控台視窗通常不會觸發任何 handler**，所以常態是「沒有離場事件」。
為此 server 每分鐘把存活時間寫進 `.data/heartbeat.json`（`{"ts": <epoch ms>}`，先寫暫存檔再 rename），
下次啟動時讀出來放進標記的 `lastAliveAt`。今日摘要與前端時間軸遇到標記時，會把仍開著的段落結束在
`lastAliveAt`（不會晚於標記本身）；沒有心跳檔就退回標記前最後一筆事件。這樣停機時間不會被算成工作時間，
而最後一次心跳（至多約 1 分鐘誤差）以前的真實工作時間也不會被抹掉。檔案只有一個時間戳，沒有任何內容文字。
臨時人力（subagent）每個 id 每天只計一次，server 中途重啟也不會重複計數。

啟動時 `/events` 與 `/api/state` 會等所有 collector 首輪掃描完成（上限 5 秒，逾時一次後就不再等）才送出第一份 snapshot；
前端對「每次（重）連線後的第一份 snapshot」只同步狀態、不發通知與提示音，所以 server 重啟不會重發
permission 通知。

`SubagentStop` 代表「這一輪做完」而不是「結束」：背景 subagent 每輪結束都會發一次，被
SendMessage 等方式重新喚醒時也不會再發 `SubagentStart`。所以收到 Stop 只把角色轉成 idle，
20 秒內沒有新的 Stop 才離場（每次 Stop 重新起算）。沒看過 start 的 id 的 Stop（Claude Code
內部的輔助 agent）一律忽略。

## 架構

```
collectors/*.ts   讀各 agent 的狀態檔（格式不歸我們控制）
      ↓ normalize 成 AgentState（shared/types.ts）
store.ts          記憶體狀態，diff 後只推有變的
      ↓
Fastify @127.0.0.1:4321   GET /api/state（首屏）、GET /events（SSE）
      ↓
React + Vite      透視視角的房間場景
```

加一個新的 agent 來源＝寫一個 `collectors/*.ts` + 在 `collectors/index.ts` 註冊一行，
server 與前端都不用動，因為它們只認識 `AgentState`。

## 使用技術

| 層 | 選擇 | 理由 |
|---|---|---|
| 語言 | TypeScript（前後端） | `AgentState` 契約只有編譯器強制才守得住 |
| 後端 | Fastify（底層是 Node 內建 `http`） | SSE + schema，有成長空間；就約 3 個端點 |
| 即時 | Server-Sent Events | 單向推播；內建自動重連、純文字好除錯，比 WebSocket 適合 |
| 檔案監看 | chokidar | Windows `fs.watch` 會漏掉 jsonl 的 append |
| 前端 | React 19 + Vite | 臨時角色進出是 list-diff 問題，正是 React 的強項 |
| 動畫 | Motion（framer-motion） | `AnimatePresence` 讓退場動畫在 unmount 後還能播完 |
| 狀態 | Zustand | 單一 SSE 串流灌進一個 store；用 Context 會整棵重繪 |
| 測試 | Vitest | 複用 Vite 管線，路徑別名直接可用 |
| CI | GitHub Actions | 每次 push 自動跑 typecheck + build + test |

除了 Fastify + chokidar，執行期沒有其他 npm 依賴 —— collector 這層刻意保持精簡。

## 專案結構

```
AI_monitor/
├─ shared/
│  └─ types.ts              AgentState — 前後端共用的契約
├─ server/                  collector 服務（Fastify + SSE，綁 127.0.0.1）
│  ├─ index.ts              HTTP：/api/state、/events (SSE)、/api/open、靜態檔
│  ├─ store.ts              記憶體狀態 + diff 推播
│  ├─ openCwd.ts            POST /api/open：開啟 agent 的 cwd（驗證過、不經 shell）
│  └─ collectors/
│     ├─ index.ts           註冊表 — 加來源時唯一要動的檔
│     ├─ isAlive.ts         共用的 pid 存活檢查（戳破殭屍狀態）
│     ├─ claudeSessions.ts  Claude Code session（+ 任務）
│     ├─ claudeTasks.ts     每個 session 的任務檔 + 進度
│     ├─ claudeJobs.ts      Claude Code 背景 job + timeline
│     ├─ claudeSubagents.ts Claude Code session 內 subagent（hook 事件記錄）
│     ├─ codexJobs.ts       Codex plugin 的 job
│     └─ codexCli.ts        原生 codex CLI（~/.codex/）
├─ web/                     前端（Vite root）
│  ├─ index.html
│  └─ src/
│     ├─ main.tsx           進入點
│     ├─ App.tsx            房間場景：舞台、工位、角色、面板
│     ├─ Station.tsx        常駐的桌子 + 狀態
│     ├─ Walker.tsx         一隻純 CSS 畫的 chibi 角色
│     ├─ TaskPanel.tsx      點擊開啟的任務詳情
│     ├─ agentStyle.ts      id 前綴 → 顏色 / 名稱 / 台詞
│     ├─ useAgentStream.ts  EventSource → Zustand store
│     └─ styles.css         token、主題、透視地板
├─ tests/                   Vitest 單元測試（每個 collector 一份）
├─ config.json             agent 名稱 / 配色 / fallback 台詞
├─ vite.config.ts          前端 build + dev proxy
├─ vitest.config.ts        測試（root 與 app 不同）
├─ tsconfig.json
└─ .github/workflows/ci.yml   push 時跑 typecheck + build + test
```

## 開發

```bash
npm install
npm run dev:server   # collector 服務，127.0.0.1:4321
npm run dev:web      # Vite dev server，5173（proxy 轉 /api、/events）
```

開 http://localhost:5173 。右上角顯示「已連線」代表 SSE 通了；沒有 agent 時是空辦公室，
不是連線失敗。

```bash
npm run typecheck    # tsc --noEmit
npm test             # Vitest 單元測試（collector）
```

## 上線

```bash
npm run build        # 產出 server/public/
npm start            # 只跑 server，開 http://127.0.0.1:4321
```

## 安全

- 服務只綁 `127.0.0.1` —— 這頁會顯示你所有專案的工作內容，絕不對外。
- collector 走欄位白名單。`timeline.jsonl` 的 `text` 欄位是完整對話全文，永遠不會送到前端。

### `POST /api/open` —— 開啟 agent 的工作目錄

點角色可以用檔案總管或 VS Code 開啟該 agent 的 `cwd`。這等於讓瀏覽器觸發本機程式執行，
所以端點刻意收得很窄（實作：`server/openCwd.ts`）：

- body 為 `{ "id": string, "target": "folder" | "editor" }`（JSON schema 驗證，`id` ≤ 200 字、
  不允許多餘欄位）。**路徑絕不來自 client** —— server 用 id 從自己的 store 查 `cwd`；
  查不到或沒有 cwd → 404。
- cwd 必須是本機絕對路徑（Windows 要有磁碟機代號）。UNC（`\\server\share`）與裝置路徑
  （`\\?\`、`\\.\`）在碰檔案系統**之前**就拒絕（對 UNC 做 realpath 會讓 Windows 發起 SMB 連線）。
  `realpath` 後仍須是本機路徑，且必須是資料夾 —— 檔案會被 explorer／open 直接執行，一律不收。
- 用 `spawn` + 陣列參數、`shell: false`、`detached` + `unref` 啟動，執行檔用絕對路徑：
  Windows `%SystemRoot%\explorer.exe`、macOS `/usr/bin/open`、Linux `xdg-open`。editor 在 Windows
  直接找 `Code.exe`（不用需要 `cmd.exe` 的 `code.cmd`），找不到回 501；其他平台以不經 shell 的方式
  執行 `code`。editor 的路徑放在 `--` 之後；子程序環境會移除 `ELECTRON_RUN_AS_NODE`／`NODE_OPTIONS`。
- CSRF／DNS rebinding：必須帶 `X-AI-Monitor: 1`（強制 CORS preflight，而 server 不回任何 CORS
  header）、`Content-Type: application/json`、`Host` 為 `127.0.0.1|localhost|[::1]:4321`，有 `Origin`
  時必須是 loopback 且 port 只能是 4321（本服務）或 5173（Vite dev server）。Vite dev proxy 會把 `Host` 改寫成 `127.0.0.1:4321`，但不動 `Origin`。
- 同一個 agent id 每秒只處理一次（否則 429）。錯誤一律 `{ "error": string }`，不帶系統細節。

## 設定

`config.json` 調各 agent 的顯示名、配色與 fallback 對話台詞。泡泡優先顯示 agent 真實的
當前工作，沒有時才用這裡的台詞墊檔。
