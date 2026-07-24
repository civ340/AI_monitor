# Cute Agent Office（可愛 Agent 辦公室）

> English: [cute-agent-office.md](./cute-agent-office.md)
>
> （skill 的 frontmatter 定義在英文主檔，本檔為中文說明。）

把「我想監控我的 AI agent」變成一個有魅力的辦公室場景 —— 資料來自真實的 agent 狀態，
不是通用表格，也不是塞假資料的玩具。

先讀 `/mnt/skills/public/frontend-design/SKILL.md` 了解一般視覺設計流程（設計 token、克制、
一個招牌元素）；本 skill 在其之上疊加 agent 監控專屬的模式。

## 什麼時候用這個、什麼時候用普通儀表板

當使用者的用語透露出重視「個性」而非「密度」時採用：「可愛」「cute」「動畫」、agent
「走來走去」、對話泡泡、辦公室／房間／桌子的比喻，或想一次看好幾個 coding agent。
如果他們要的是原始 log、密集指標、或維運風格的狀態格線，就做一般儀表板 —— 不要把可愛的
比喻硬套到一個要求密度的需求上。

## 架構

場景是鉤子，collector 服務才是實質內容。兩者分開。

```
採集層  collectors/*.ts     讀各 agent 的狀態檔（格式不歸我們控制）
              ↓ normalize
契約    shared/types.ts     AgentState — 前後端唯一真相
              ↓
狀態層  server/store.ts     記憶體 store，diff 後只推有變的 agent
              ↓
傳輸層  Fastify @127.0.0.1  GET /api/state（首屏）、GET /events（SSE）
              ↓
展示層  React + Vite + Motion
```

為什麼要有 collector 這一層：每個 agent 寫出的格式都不一樣，而且會隨版本改變。把所有解析
關進「一個來源一個檔」，格式一變就只動那個檔 —— store 和 UI 完全不受影響。

## 契約

collector 之後的每一層都只認識這個：

```ts
type AgentState = {
  id: string;
  kind: "resident" | "transient";   // 固定工位 vs 臨時借調的 subagent
  parent?: string;                  // transient 的話，指向所屬 resident
  name: string;                     // 顯示名："Claude Code" / "codex-rescue"
  state: "working" | "idle" | "offline";
  detail?: string;                  // 一句話現況 → 泡泡台詞 + 工位狀態列
  tasks: { id: string; subject: string; status: string; progress: number }[];
  updatedAt: number;
};
```

`detail` 是最有價值的欄位 —— 它是從 agent 自己的 log 拉出來、給人看的真實狀態列。
phrase bank 只是 `detail` 為空時的**墊檔**。

## 真實資料來源（Windows 路徑）

| # | 路徑 | 提供 |
|---|---|---|
| 1 | `~/.claude/sessions/<pid>.json` | 每個執行中的 Claude Code session 一個檔：`pid, sessionId, cwd, name, status:"busy", kind, updatedAt`。常駐心跳。 |
| 2 | `~/.claude/tasks/<sessionId>/<n>.json` | `id, subject, status, activeForm`。任務面板 + 真實進度。`activeForm` 是現在進行式，適合當泡泡台詞。 |
| 3 | `~/.claude/jobs/<short>/state.json` | `state, detail, tempo, inFlight:{tasks,queued,kinds}, name, intent, tokens, children`。 |
| 4 | `~/.claude/jobs/<short>/timeline.jsonl` | append-only `{at, state, detail, text}`。只讀最後一行的 `detail`。 |
| 5 | `plugins/data/codex-openai-codex/state/<專案>-<hash>/state.json` | `jobs[]`：`id, kind, title, summary, status, phase, pid`。 |
| 6 | 同層 `jobs/<jobId>.json` / `.log` | 單筆詳細與輸出。 |
| 7 | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` + `~/.codex/session_index.jsonl` | 原生 codex CLI。`task_started`/`task_complete` 事件用 `turn_id` 配對判斷是否在跑；`user_message` 是目前工作。 |

省下一小時的提醒：

- **不要解析對話 `.jsonl` 記錄檔。** 需要的都在上面的結構化 JSON 裡。只有 #4 和 #7 是逐行
  格式，而且兩者都只讀檔尾。
- 狀態優先從顯式欄位推導（`status:"busy"`、`phase`、經作業系統確認存活的 `pid`），
  撐不住才退回 `updatedAt` 時間。
- 檔案宣稱 `running`/`busy` 可能在說謊 —— process 被強制中止時不會改寫終態。要向作業系統
  確認 `pid` 是否存活，而且連 `busy` 也要套時效窗。
- `inFlight.{tasks,queued}` 已經算好「有多少在飛」—— 別自己重算。
- append-only 的 log（`timeline.jsonl`、rollout 檔）**只讀檔尾**。它們會無限成長，每次變動
  都整包讀會造成記憶體／CPU 的 DoS。

## 常駐 vs 臨時角色

subagent 是借調來的同事，不是正職 —— 照這個語意建模：

| | 成員 | 生命週期 | 場景處理 |
|---|---|---|---|
| **常駐** | Claude Code session、Codex | 長命 | 固定工位 + 名牌，一直在房間裡 |
| **臨時** | scout / executor / verifier / reviewers / codex-rescue | 幾秒–幾分鐘 | 沒有工位；站在房間深處，做完淡出 |

要設人數上限，不然房間會塞成一團：約 2 個常駐 + 最多 4 個臨時上場，多出來的收進角落標籤
（「還有 N 位在加班」）。工位數量跟著即時資料走 —— 絕不寫死。

## 場景配方

1. **房間** — 圓角 `.stage`，牆/地板漸層、透視地板網格製造縱深、幾扇窗、1–2 個裝飾道具。
   房間是舞台，不是主角。
2. **工位** — 每個*常駐*一個，沿地板排：桌子 + 名牌 + 即時單行狀態。
3. **角色** — 每個 agent 一隻 chibi walker（純 CSS 畫：頭 + 天線 + 身體，不需圖片），
   用該 agent 的主色。這是招牌元素；其他地方別過度動畫。
4. **對話泡泡** — 在角色上方顯示 `detail`；為空時退回該 agent 的 phrase bank。
   **泡泡文字同時寫進工位的狀態列**，資訊不會隨泡泡淡出而消失。
5. **任務面板** — 點角色或桌子開啟，列出該 agent 的任務：主旨、負責者（常駐 vs 具名
   subagent）、狀態 pill、進度條。場景是鉤子，這裡才是實質內容 —— 別讓可愛那層變成唯一的
   資訊來源。
6. **主題切換** — 2–3 個具名主題，透過 `data-theme` 屬性切換 CSS 自訂變數。絕不為每個主題
   另建一套 DOM。

## 透視與縱深

平面正視會讓「站得比較後面」看起來像「飄在半空」。給地板一張往後收斂的透視網格
（`rotateX` + 往遠端淡出），讓畫面上比較高的角色讀起來是「站在房間深處」而非懸空。
角色的腳必須落在牆/地板分界線**下方** —— 腳在分界線上方會看起來貼在牆上。

## 動畫

React 會在 agent 一消失就 unmount 元件，退場動畫直接被殺掉 —— 所以動畫在這裡不是可有可無的
點綴，而是讓臨時角色「看得懂進出」的關鍵。

- walker 清單外包一層 `AnimatePresence`：延後 unmount 直到淡出播完。
- Motion 控制 walker 的 transform；同一元素上的 CSS `transform` 會被它蓋掉。若同時用 Motion
  做動畫，縮放請改用 `width` 而非 `transform`。
- idle 晃動維持純 CSS keyframe —— 一個 4px 的循環不值得動用 spring。

## 設計 token

- 每個 agent 一組主色 + 柔和淡色（暖珊瑚 / 薄荷 / 天藍 / 紫）。名牌、角色輪廓、進度條共用
  同一組，達成「這個顏色＝這個 agent」。
- 角色的臉給**獨立**的 token，不跟面板色走 —— 臉跟著面板進暗色模式的話，深色臉配淺色眼睛
  會變成瞪人的鬼。
- 標籤用圓體標題字（Baloo 2 / Fredoka）+ 圓體內文字（Nunito）。
- 柔和、*帶色*的陰影（用 ink token 染色，絕不用純黑）。

## 安全約束

這頁會顯示使用者跨所有專案的工作內容。三條都是強制的：

1. 服務只綁 `127.0.0.1` —— 絕不綁 `0.0.0.0`。
2. collector 走**欄位白名單**。`timeline.jsonl` 的 `text` 欄位（以及 codex rollout 檔的完整
   訊息內容）裝的是整段對話全文，通常很敏感；絕不能送到瀏覽器。來源表以外的東西一律不讀。
3. 任何用檔案自身欄位組成的路徑（例：`sessionId` → 目錄）都必須驗證：強制格式正確，並確認
   解析後的路徑仍在其根目錄底下。「這個檔是可信工具寫的」不能取代路徑邊界檢查。

## 技術棧與檔案佈局

前後端都是 TypeScript：上面的契約只有在編譯器強制執行時才守得住。

```
shared/types.ts          AgentState
server/
  index.ts               Fastify：/api/state、/events (SSE)、靜態檔
  store.ts               記憶體狀態 + diff 推播
  collectors/
    index.ts             註冊表 ← 加來源時唯一要動的檔
    isAlive.ts           共用的 pid 存活檢查
    claudeSessions.ts    資料源 1（+ 2 透過 claudeTasks）
    claudeTasks.ts       資料源 2
    claudeJobs.ts        資料源 3、4
    codexJobs.ts         資料源 5、6
    codexCli.ts          資料源 7
web/src/
  App.tsx Station.tsx Walker.tsx TaskPanel.tsx
  agentStyle.ts          id 前綴 → 顏色 / 名稱 / 台詞
  useAgentStream.ts      EventSource → Zustand
config.json              agent 名稱 / 配色 / fallback 台詞
```

Fastify（SSE + schema，有成長空間）、Zustand（單一串流灌進一個 store；Context 在這個更新
頻率下會整棵重繪）、chokidar（Windows `fs.watch` 會漏掉 jsonl 的 append）。

**加一個 agent 來源＝一個新的 `collectors/*.ts` + 註冊表一行。** server、store、UI 都不動，
因為它們只認識 `AgentState`。任何擴充都要保住這個性質。

## 產出

是一個能跑的專案，不是單一檔案。啟動 collector、開 Vite dev server，並在收工前**確認真實
agent 狀態真的有出現** —— 場景在空資料上照樣動得很順，跟正常運作看起來一模一樣，所以
collector 靜默失效是這個模式的預設失敗模式。
