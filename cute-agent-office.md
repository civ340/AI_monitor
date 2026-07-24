---
name: cute-agent-office
description: Design and build a cute "office" dashboard that visualizes the live status of AI coding agents (Claude Code, Codex, and their sub-agents) as chibi characters walking around a room, with speech bubbles for status and a click-to-open task panel. Backed by a local collector service that reads real agent state files and streams updates over SSE. Use this skill whenever the user wants to monitor, visualize, or check in on running AI agents in a playful way — even if they just say "監控頁面", "agent dashboard", "可愛風格", "辦公室", or describe characters/speech bubbles without naming this pattern. Always consult this before building an agent-monitoring UI from scratch.
---

# Cute Agent Office

A pattern for turning "I want to monitor my AI agents" into a charming office scene backed by
real agent state — not a generic table, and not a mock-data toy.

Read `/mnt/skills/public/frontend-design/SKILL.md` first for general visual-design process
(tokens, restraint, one signature element); this skill layers agent-monitoring specifics on top.

## When to use this vs. a plain dashboard

Use this when the user's language signals *personality* over density: "可愛", "cute", "動畫",
agents "走來走去", speech bubbles, an office/room/desk metaphor, or watching several coding
agents at once. If they want raw logs, dense metrics, or an ops-style status grid, build a
normal dashboard instead — don't force the cute metaphor onto a request for density.

## Architecture

The scene is the hook; the collector service is the substance. Keep them separate.

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

Why the collector layer exists: every agent writes a different shape, and those shapes change
between agent versions. Quarantine all parsing in one file per source, and a format change
touches exactly that file — the store and the UI never move.

## The contract

Everything downstream of the collectors knows only this:

```ts
type AgentState = {
  id: string;
  kind: "resident" | "transient";   // 常駐工位 vs 臨時借調的 subagent
  parent?: string;                  // transient 的話，指向所屬 resident
  name: string;                     // 顯示名："Claude Code" / "codex-rescue"
  state: "working" | "idle" | "offline";
  detail?: string;                  // 一句話現況 → 泡泡台詞 + 工位狀態列
  tasks: { id: string; subject: string; status: string; progress: number }[];
  updatedAt: number;
};
```

`detail` is the single most valuable field — it is a real, human-readable status line pulled
from the agent's own log. A phrase bank is only a **fallback** for when `detail` is empty.

## Real data sources (Windows paths)

| # | Path | Yields |
|---|---|---|
| 1 | `~/.claude/sessions/<pid>.json` | One file per live Claude Code session: `pid, sessionId, cwd, name, status:"busy", kind, updatedAt`. The resident heartbeat. |
| 2 | `~/.claude/tasks/<sessionId>/<n>.json` | `id, subject, description, status, blocks, blockedBy`. Task panel + real progress (completed/total). |
| 3 | `~/.claude/jobs/<short>/state.json` | `state:"working"\|"done", detail, tempo, inFlight:{tasks,queued,kinds}, name, intent, tokens, children`. |
| 4 | `~/.claude/jobs/<short>/timeline.jsonl` | Append-only `{at, state, detail, text}`. Read `detail` for bubbles. |
| 5 | `plugins/data/codex-openai-codex/state/<proj>-<hash>/state.json` | `jobs[]`: `id, kind, title, summary, status, phase, pid, logFile`. Non-null `pid` ⇒ still running. |
| 6 | Same dir, `jobs/<jobId>.json` / `.log` | Per-job detail and output. |

Notes that save an hour:

- **Do not parse the conversation `.jsonl` transcripts.** Everything needed is in the
  structured JSON above. Only #4 is line-oriented, and it is trivially shaped.
- Derive `state` from explicit fields first (`status:"busy"`, `phase`, non-null `pid`), and
  only fall back to `updatedAt` age (`<30s` working, `<10min` idle, else offline).
- `inFlight.{tasks,queued}` already answers "how much is in the air" — don't recompute it.
- `children` on #3 is where sub-agents should appear, but it is often `null`. Write the
  array branch plus a null fallback; don't block on capturing a live sample.

## Resident vs. transient characters

Sub-agents are borrowed colleagues, not staff — model them that way:

| | Members | Lifetime | Scene treatment |
|---|---|---|---|
| **Resident** | Claude Code session, Codex | long-lived | fixed desk + name badge, always in the room |
| **Transient** | scout / executor / verifier / reviewers / codex-rescue | seconds–minutes | no desk; walks in on spawn, fades out on completion |

Cap the population or the room becomes soup: ~2 residents + at most 4 transients on stage,
with any excess collapsed into a corner label ("還有 N 位在加班"). Station count follows live
data — never hardcode it.

## Scene recipe

1. **Room** — a rounded `.stage` with wall/floor gradient, a couple of windows, 1–2 decor props.
   The room is a stage, not the subject.
2. **Stations** — one per *resident*, along the floor: desk + name badge + live one-line status.
3. **Characters** — one chibi walker per agent (CSS-drawn: head + antenna + torso, no image
   assets) in that agent's accent color. This is the signature element; don't over-animate
   anything else.
4. **Speech bubbles** — show `detail` above a character; fall back to the per-agent phrase bank
   when it is empty. **Bubble text also writes into the station's status line**, so information
   survives the fade.
5. **Task panel** — clicking a character or desk opens a panel with that agent's tasks: subject,
   owner (resident vs. named sub-agent), status pill, progress bar. The scene is the hook, this
   is the payload — never let the cute layer be the only source of information.
6. **Theme switcher** — 2–3 named themes swapping CSS custom properties via a `data-theme`
   attribute. Never build separate DOM per theme.

## Animation

React unmounts a component the instant an agent disappears, which kills any exit animation —
so animation is not optional polish here, it is what makes transients readable.

- `AnimatePresence` around the walker list: defers unmount until the fade-out finishes.
- `layout` prop for wandering: let layout animation move characters instead of hand-written
  `transition: left`.
- Idle bob stays a plain CSS keyframe — don't pay for a spring on a 4px loop.

## Design tokens

- Each agent gets an accent color + soft tint pair (warm coral / mint / sky). Reuse that pair
  for badge, character outline, and progress fill so "this color = this agent" everywhere.
- Rounded display font for labels (Baloo 2 / Fredoka) + rounded body font (Nunito).
- Soft, *colored* shadows (tinted with the ink token, never pure black) — pure black breaks
  the cute register instantly.

## Security constraints

This page surfaces the user's work across every project. Both constraints are mandatory:

1. Bind the server to `127.0.0.1` only — never `0.0.0.0`.
2. Collectors emit a **field whitelist**. The `text` field in `timeline.jsonl` carries full
   conversation transcripts (thousands of words, often sensitive); it must never reach the
   browser. Auth files live in adjacent directories — read nothing outside the table above.

## Stack and layout

TypeScript on both ends: the contract above is only enforceable if the compiler enforces it.

```
shared/types.ts          AgentState
server/
  index.ts               Fastify: /api/state, /events (SSE), static
  store.ts               in-memory state + diff push
  collectors/
    index.ts             registry ← the only file touched when adding a source
    claudeSessions.ts    source 1
    claudeTasks.ts       source 2
    claudeJobs.ts        sources 3, 4
    codexJobs.ts         sources 5, 6
web/src/
  App.tsx Stage.tsx Station.tsx Walker.tsx TaskPanel.tsx
  useAgentStream.ts      EventSource → Zustand
config.json              agent names / colors / fallback phrase banks
```

Fastify (SSE + schema, room to grow), Zustand (single stream into one store; Context re-renders
the whole tree at this update rate), chokidar (Windows `fs.watch` misses jsonl appends).

**Adding an agent source = one new `collectors/*.ts` + one line in the registry.** Server,
store, and UI stay untouched because they only know `AgentState`. Preserve that property in
any extension.

## Output

A runnable project, not a single file. Start the collector, open the Vite dev server, and
confirm real agent state actually appears before calling it done — a scene animating over
empty data looks identical to a working one, which makes silent collector failures the
default failure mode of this pattern.
