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

常駐 agent（Claude Code、Codex）站在自己的工位；被派出的臨時 subagent／背景 job
會走進房間、做完離場。

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

## 開發

```bash
npm install
npm run dev:server   # collector 服務，127.0.0.1:4321
npm run dev:web      # Vite dev server，5173（proxy 轉 /api、/events）
```

開 http://localhost:5173 。右上角顯示「已連線」代表 SSE 通了；沒有 agent 時是空辦公室，
不是連線失敗。

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
