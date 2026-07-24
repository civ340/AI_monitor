# AI Agent Office

> 中文版：[README.zh-TW.md](./README.zh-TW.md)

Turns "monitor my AI coding agents" into a cute office scene: each agent is a character walking
around a room, with a speech bubble showing what it's doing right now and a click-to-open panel
listing its tasks. Everything comes from the state files each agent writes locally, updated live.

## What it monitors

| Station | Data source |
|---|---|
| Claude Code (one per session) | `~/.claude/sessions/`, `~/.claude/tasks/` |
| Claude Code background jobs | `~/.claude/jobs/` |
| Codex (Claude Code's codex plugin) | `~/.claude/plugins/data/codex-openai-codex/state/` |
| Codex CLI (run directly via `codex`) | `~/.codex/sessions/` |

Resident agents (Claude Code, Codex) stand at their own desks; transient background jobs
walk in on spawn and leave when done.

### Scope: background jobs, not in-session sub-agents

Every source above is a **background job or session** that writes a state file to disk. The
monitor reads those files — so it shows what has an on-disk footprint:

- ✅ Shown: Claude Code sessions, `~/.claude/jobs/` daemon jobs, `/codex:rescue --background`
  and other codex plugin jobs, native `codex` CLI runs.
- ❌ Not shown: sub-agents spawned inside a session via the Task/Agent tool
  (scout / executor / verifier, etc.). They run *inside* the Claude Code process and never
  get their own state file, so no collector can see them.

In short: the transient characters are **background jobs**, not in-session sub-agents. To make
one walk in, launch a background job (e.g. `/codex:rescue --background <question>`).

## Architecture

```
collectors/*.ts   read each agent's state files (shapes we don't control)
      ↓ normalize into AgentState (shared/types.ts)
store.ts          in-memory state, diffs and pushes only what changed
      ↓
Fastify @127.0.0.1:4321   GET /api/state (first paint), GET /events (SSE)
      ↓
React + Vite      perspective-view room scene
```

Adding a new agent source = one `collectors/*.ts` + one line in `collectors/index.ts`. The
server and frontend stay untouched because they only know `AgentState`.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (both ends) | The `AgentState` contract is only enforceable if the compiler enforces it |
| Backend | Fastify (Node built-in `http` under it) | SSE + schema, room to grow; only ~3 endpoints |
| Realtime | Server-Sent Events | One-way push; auto-reconnect and plain-text, easier to debug than WebSocket |
| File watching | chokidar | Windows `fs.watch` misses jsonl appends |
| Frontend | React 19 + Vite | Transients entering/leaving is a list-diff problem — React's strength |
| Animation | Motion (framer-motion) | `AnimatePresence` keeps exit animations alive after unmount |
| State | Zustand | Single SSE stream into one store; Context would re-render the whole tree |
| Tests | Vitest | Reuses the Vite pipeline; aliases just work |
| CI | GitHub Actions | Runs typecheck + build + test on every push |

No runtime npm dependencies beyond Fastify + chokidar — the collector layer stays lean on purpose.

## Project structure

```
AI_monitor/
├─ shared/
│  └─ types.ts              AgentState — the contract both ends share
├─ server/                  collector service (Fastify + SSE, binds 127.0.0.1)
│  ├─ index.ts              HTTP: /api/state, /events (SSE), static files
│  ├─ store.ts              in-memory state + diff-based push
│  └─ collectors/
│     ├─ index.ts           registry — the only file touched to add a source
│     ├─ isAlive.ts         shared pid-liveness check (defeats zombie state)
│     ├─ claudeSessions.ts  Claude Code sessions (+ tasks)
│     ├─ claudeTasks.ts     per-session task files + progress
│     ├─ claudeJobs.ts      Claude Code background jobs + timeline
│     ├─ codexJobs.ts       Codex plugin jobs
│     └─ codexCli.ts        native codex CLI (~/.codex/)
├─ web/                     frontend (Vite root)
│  ├─ index.html
│  └─ src/
│     ├─ main.tsx           entry
│     ├─ App.tsx            room scene: stage, stations, walkers, panel
│     ├─ Station.tsx        a resident's desk + status
│     ├─ Walker.tsx         one CSS-drawn chibi character
│     ├─ TaskPanel.tsx      click-to-open task detail
│     ├─ agentStyle.ts      id-prefix → color / label / phrases
│     ├─ useAgentStream.ts  EventSource → Zustand store
│     └─ styles.css         tokens, themes, perspective floor
├─ tests/                   Vitest unit tests (one per collector)
├─ config.json             agent names / colors / fallback phrases
├─ vite.config.ts          frontend build + dev proxy
├─ vitest.config.ts        test runner (root differs from the app)
├─ tsconfig.json
└─ .github/workflows/ci.yml   typecheck + build + test on push
```

## Development

```bash
npm install
npm run dev:server   # collector service, 127.0.0.1:4321
npm run dev:web      # Vite dev server, 5173 (proxies /api and /events)
```

Open http://localhost:5173 . "Connected" in the top-right means SSE is live; an empty office
when no agents are running is expected — it is not a connection failure.

```bash
npm run typecheck    # tsc --noEmit
npm test             # Vitest unit tests (collectors)
```

## Production

```bash
npm run build        # emits server/public/
npm start            # server only, open http://127.0.0.1:4321
```

## Security

- The server binds to `127.0.0.1` only — this page surfaces your work across every project, so
  it is never exposed externally.
- Collectors emit a field whitelist. The `text` field in `timeline.jsonl` holds full
  conversation transcripts and never reaches the frontend.

## Configuration

`config.json` sets each agent's display name, colors, and fallback bubble phrases. Bubbles
prefer the agent's real current task and fall back to these phrases only when none is available.
