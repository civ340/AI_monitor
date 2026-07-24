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
| Codex（Claude Code 的 codex plugin） | `~/.claude/plugins/data/codex-openai-codex/state/` |
| Codex CLI（直接下 `codex` 指令跑的） | `~/.codex/sessions/` |

常駐 agent（Claude Code、Codex）站在自己的工位；臨時的背景 job 會走進房間、做完離場。

### 監控範圍：背景 job，不是 session 內的 subagent

上面每個來源都是**會把狀態檔寫到磁碟的背景 job 或 session**。監控讀的是那些檔案 ——
所以它顯示的是「在磁碟上留下足跡」的東西：

- ✅ 會顯示：Claude Code session、`~/.claude/jobs/` 的 daemon job、`/codex:rescue --background`
  等 codex plugin job、原生 `codex` CLI 執行。
- ❌ 不會顯示：透過 Task/Agent tool 在 session 內部派出的 subagent
  （scout / executor / verifier 等）。它們跑在 Claude Code 行程**內部**，不會產生自己的
  狀態檔，所以任何 collector 都讀不到。

一句話：畫面上的臨時角色是**背景 job**，不是 session 內的 subagent。想讓一隻走進房間，
就開一個背景 job（例如 `/codex:rescue --background <問題>`）。

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
│  ├─ index.ts              HTTP：/api/state、/events (SSE)、靜態檔
│  ├─ store.ts              記憶體狀態 + diff 推播
│  └─ collectors/
│     ├─ index.ts           註冊表 — 加來源時唯一要動的檔
│     ├─ isAlive.ts         共用的 pid 存活檢查（戳破殭屍狀態）
│     ├─ claudeSessions.ts  Claude Code session（+ 任務）
│     ├─ claudeTasks.ts     每個 session 的任務檔 + 進度
│     ├─ claudeJobs.ts      Claude Code 背景 job + timeline
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

## 設定

`config.json` 調各 agent 的顯示名、配色與 fallback 對話台詞。泡泡優先顯示 agent 真實的
當前工作，沒有時才用這裡的台詞墊檔。
