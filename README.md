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
| Claude Code in-session sub-agents (Task/Agent tool) | `.data/subagents.jsonl` (via Claude Code hooks, see below) |
| Codex (Claude Code's codex plugin) | `~/.claude/plugins/data/codex-openai-codex/state/` |
| Codex CLI (run directly via `codex`) | `~/.codex/sessions/` |

Resident agents (Claude Code, Codex) stand at their own desks; transient background jobs and
in-session sub-agents walk in on spawn and leave when done.

### Scope: background jobs and in-session sub-agents

Every source above ends up as a state file or event log the monitor reads:

- ✅ Shown: Claude Code sessions, `~/.claude/jobs/` daemon jobs, `/codex:rescue --background`
  and other codex plugin jobs, native `codex` CLI runs, and — since sub-agents leave no state
  file of their own — Task/Agent tool sub-agents (scout / executor / verifier, etc.) captured
  via a Claude Code hook.

#### In-session sub-agents: how they're captured

Sub-agents run *inside* the parent Claude Code process and never write their own state file, so
no collector can read them off disk directly. Instead, a project-local hook
(`.claude/settings.local.json`) appends a small event to `.data/subagents.jsonl` on three hook
events (plus four session-level events, below), and `server/collectors/claudeSubagents.ts` reads that log incrementally:

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

`hooks/record.mjs` whitelists fields per event and never writes prompts, assistant messages, or
transcript paths — only `ts`, `session_id`, `agent_id`/`tool_use_id`, `subagent_type`/`agent_type`,
a truncated `description`, and `cwd`. This is currently a project-local hook registration (not
part of the app itself), so it only fires for sessions running against this repo.

The four extra events (`Notification`, `UserPromptSubmit`, `Stop`, `PostToolUse`) go to a separate
file, `.data/session-events.jsonl`, and drive the **waiting** ("waiting for you") state. Whitelist:
only `ts`, `ev`, `session_id`, plus a truncated `notification_type` for Notification — never the
notification message, prompt, `tool_input`, or `transcript_path`. Latest event per session wins:
a permission-type Notification → waiting/permission; `idle_prompt` Notification or `Stop` →
waiting/input; `UserPromptSubmit` / `PostToolUse` clear it. Offline sessions are never marked waiting.

**Important: waiting only works for projects that have registered the hook.** The hook events are
the only source of the waiting *reason* and of the "Claude replied, your turn" (input) state; a
session in a project without the hook never produces them. (Claude Code's own session-file status
`waiting` is also honoured as a fallback and shown as waiting/permission, but without the hook you
get no "input" state, and no way to tell a stale status from a fresh one.) Register the hook in
every project you want watched. If the session file goes back to `busy` after a waiting event
(you approved and a long tool is running), the waiting state is cleared without needing any extra hook.

**History stores no content text.** `.data/history.jsonl` only records state transitions
(timestamp, agent id/name/kind/cwd, from/to). It never stores `detail` (which can be the start of a
prompt or a sub-agent description); only transitions into `error` carry a short `error` summary
(≤120 chars). Today's events are cached in memory and the file is read asynchronously.

**`server-start` marker and the heartbeat file.** On every start the server appends a
`{"marker":"server-start","id":"server"}` event. On SIGINT / SIGTERM / SIGHUP (and SIGBREAK on Windows)
it first writes a leave event for every agent. **On Windows, `taskkill /F`, killing the process or
closing the console window usually fires none of these handlers**, so the normal case is "no leave
events". To cover that, the server writes `.data/heartbeat.json` (`{"ts": <epoch ms>}`, temp file +
rename, once a minute) and the next start copies it into the marker as `lastAliveAt`. When computing
the today summary and the frontend timeline, any segment still open at a marker is closed at
`lastAliveAt` (never later than the marker); without a heartbeat file it falls back to the last event
before the marker. So down time is never counted as working time, but real work up to the last
heartbeat (at most ~1 minute stale) is kept. The file holds a single timestamp, no content.
Sub-agents are counted once per id per day even if the server restarts mid-run.

On start, `/events` and `/api/state` hold the first snapshot until every collector has finished its
first scan (5 s cap), and the frontend treats the first snapshot after every (re)connect as a pure
sync: no notifications or chimes for state that merely changed while the server was restarting.

`SubagentStop` means "this turn ended", not "finished": a background sub-agent fires it every
time its turn ends, and being re-woken (e.g. via SendMessage) fires no new `SubagentStart`. So a
Stop only turns the character idle; it leaves after 20 s with no further Stop (each Stop restarts
the countdown). Stops for ids never seen starting (Claude Code's internal helpers) are ignored.

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
│  ├─ index.ts              HTTP: /api/state, /events (SSE), /api/open, static files
│  ├─ store.ts              in-memory state + diff-based push
│  ├─ openCwd.ts            POST /api/open: open an agent's cwd (validated, no shell)
│  └─ collectors/
│     ├─ index.ts           registry — the only file touched to add a source
│     ├─ isAlive.ts         shared pid-liveness check (defeats zombie state)
│     ├─ claudeSessions.ts  Claude Code sessions (+ tasks)
│     ├─ claudeTasks.ts     per-session task files + progress
│     ├─ claudeJobs.ts      Claude Code background jobs + timeline
│     ├─ claudeSubagents.ts Claude Code in-session sub-agents (hook event log)
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

### `POST /api/open` — open an agent's working directory

Clicking a character can open that agent's `cwd` in the file manager or VS Code. Because this lets
a browser trigger local program execution, the endpoint is deliberately narrow
(implementation: `server/openCwd.ts`):

- Body is `{ "id": string, "target": "folder" | "editor" }` (JSON schema, `id` ≤ 200 chars, no
  extra fields). **The path never comes from the client** — the server looks up the agent's `cwd`
  in its own store. Unknown id / no cwd → 404.
- The cwd must be a local absolute path (drive-letter path on Windows). UNC (`\\server\share`)
  and device paths (`\\?\`, `\\.\`) are rejected *before* touching the filesystem (resolving a
  UNC path would make Windows open an SMB connection). After `realpath` it must still be local and
  must be a directory — never a file, which explorer/open would execute.
- Programs are started with `spawn` + argument array, `shell: false`, `detached` + `unref`, using
  absolute executables: `%SystemRoot%\explorer.exe` on Windows, `/usr/bin/open` on macOS,
  `xdg-open` on Linux. For the editor, Windows resolves `Code.exe` directly (never `code.cmd`, which
  would require `cmd.exe`) and returns 501 if VS Code isn't found; elsewhere `code` is executed
  without a shell. Editor paths go after `--`. `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` are stripped
  from the child environment.
- CSRF / DNS rebinding: requires header `X-AI-Monitor: 1` (forces a CORS preflight, and the
  server sends no CORS headers), `Content-Type: application/json`, a `Host` of
  `127.0.0.1|localhost|[::1]:4321`, and — if present — an `Origin` on loopback with port 4321 (the server) or 5173 (the Vite dev server) only. The Vite
  dev proxy rewrites `Host` to `127.0.0.1:4321` but leaves `Origin` untouched.
- One request per agent id per second (429 otherwise). Errors are `{ "error": string }` with no
  system details.

## Configuration

`config.json` sets each agent's display name, colors, and fallback bubble phrases. Bubbles
prefer the agent's real current task and fall back to these phrases only when none is available.
