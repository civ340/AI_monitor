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

Resident agents (Claude Code, Codex) stand at their own desks; transient sub-agents and
background jobs walk in on spawn and leave when done.

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

## Development

```bash
npm install
npm run dev:server   # collector service, 127.0.0.1:4321
npm run dev:web      # Vite dev server, 5173 (proxies /api and /events)
```

Open http://localhost:5173 . "Connected" in the top-right means SSE is live; an empty office
when no agents are running is expected — it is not a connection failure.

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
