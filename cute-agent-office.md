---
name: cute-agent-office
description: Design and build a cute "office" dashboard that visualizes the live status of AI coding agents (Claude Code, Codex, and their sub-agents) as chibi characters walking around a room, with speech bubbles for status and a click-to-open task panel. Backed by a local collector service that reads real agent state files and streams updates over SSE. Use this skill whenever the user wants to monitor, visualize, or check in on running AI agents in a playful way — even if they just say "監控頁面", "agent dashboard", "可愛風格", "辦公室", or describe characters/speech bubbles without naming this pattern. Always consult this before building an agent-monitoring UI from scratch.
---

# Cute Agent Office

> 中文版：[cute-agent-office.zh-TW.md](./cute-agent-office.zh-TW.md)

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
Collectors  collectors/*.ts     read each agent's state files (shapes we don't control)
                ↓ normalize
Contract    shared/types.ts     AgentState — the single source of truth for both ends
                ↓
State       server/store.ts     in-memory store, diffs and pushes only what changed
                ↓
Transport   Fastify @127.0.0.1  GET /api/state (first paint), GET /events (SSE)
                ↓
View        React + Vite + Motion
```

Why the collector layer exists: every agent writes a different shape, and those shapes change
between agent versions. Quarantine all parsing in one file per source, and a format change
touches exactly that file — the store and the UI never move.

## The contract

Everything downstream of the collectors knows only this:

```ts
type AgentState = {
  id: string;
  kind: "resident" | "transient";   // fixed desk vs. a borrowed sub-agent
  parent?: string;                  // for transient: points at its owning resident
  name: string;                     // display name: "Claude Code" / "codex-rescue"
  state: "working" | "idle" | "offline";
  detail?: string;                  // one-line status → bubble text + station status line
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
| 2 | `~/.claude/tasks/<sessionId>/<n>.json` | `id, subject, status, activeForm`. Task panel + real progress. `activeForm` is the present-tense line for bubbles. |
| 3 | `~/.claude/jobs/<short>/state.json` | `state, detail, tempo, inFlight:{tasks,queued,kinds}, name, intent, tokens, children`. |
| 4 | `~/.claude/jobs/<short>/timeline.jsonl` | Append-only `{at, state, detail, text}`. Read only the last line's `detail`. |
| 5 | `plugins/data/codex-openai-codex/state/<proj>-<hash>/state.json` | `jobs[]`: `id, kind, title, summary, status, phase, pid`. |
| 6 | Same dir, `jobs/<jobId>.json` / `.log` | Per-job detail and output. |
| 7 | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` + `~/.codex/session_index.jsonl` | Native codex CLI. `task_started`/`task_complete` events (pair by `turn_id`) decide running; `user_message` is the current task. |

Notes that save an hour:

- **Do not parse the conversation `.jsonl` transcripts.** Everything needed is in the
  structured JSON above. Only #4 and #7 are line-oriented, and both are read tail-only.
- Derive `state` from explicit fields first (`status:"busy"`, `phase`, a live `pid` verified
  against the OS), and only fall back to `updatedAt` age.
- A file claiming `running`/`busy` may be lying — a killed process never rewrites its terminal
  state. Verify a live `pid` against the OS, and apply a staleness window even to `busy`.
- `inFlight.{tasks,queued}` already answers "how much is in the air" — don't recompute it.
- Read append-only logs (`timeline.jsonl`, rollout files) **tail-only**. They grow unbounded;
  reading the whole file on every change is a memory/CPU DoS.

## Resident vs. transient characters

Sub-agents are borrowed colleagues, not staff — model them that way:

| | Members | Lifetime | Scene treatment |
|---|---|---|---|
| **Resident** | Claude Code session, Codex | long-lived | fixed desk + name badge, always in the room |
| **Transient** | scout / executor / verifier / reviewers / codex-rescue | seconds–minutes | no desk; stands further back on the floor, fades out on completion |

Cap the population or the room becomes soup: ~2 residents + at most 4 transients on stage,
with any excess collapsed into a corner label ("N more working overtime"). Station count
follows live data — never hardcode it.

## Scene recipe

1. **Room** — a rounded `.stage` with wall/floor gradient, a perspective floor grid for depth,
   a couple of windows, 1–2 decor props. The room is a stage, not the subject.
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

## Perspective and depth

A flat front-elevation makes "further back" read as "floating in mid-air." Give the floor a
receding perspective grid (`rotateX` + fade toward the far edge) so a character higher on
screen reads as standing *deeper in the room*, not levitating. A character's feet must land
**below** the wall/floor boundary — feet above it look pasted onto the wall.

## Animation

React unmounts a component the instant an agent disappears, which kills any exit animation —
so animation is not optional polish here, it is what makes transients readable.

- `AnimatePresence` around the walker list: defers unmount until the fade-out finishes.
- Motion controls the walker transform; a CSS `transform` on the same element loses to it.
  Scale via `width`, not `transform`, if you also animate with Motion.
- Idle bob stays a plain CSS keyframe — don't pay for a spring on a 4px loop.

## Design tokens

- Each agent gets an accent color + soft tint pair (warm coral / mint / sky / violet). Reuse
  that pair for badge, character outline, and progress fill so "this color = this agent."
- Give the character face its **own** token, independent of the panel color — if the face
  follows the panel into dark mode, a dark face with light eyes becomes a staring ghost.
- Rounded display font for labels (Baloo 2 / Fredoka) + rounded body font (Nunito).
- Soft, *colored* shadows (tinted with the ink token, never pure black).

## Security constraints

This page surfaces the user's work across every project. All three are mandatory:

1. Bind the server to `127.0.0.1` only — never `0.0.0.0`.
2. Collectors emit a **field whitelist**. The `text` field in `timeline.jsonl` (and the full
   message bodies in codex rollout files) carry entire conversation transcripts, often
   sensitive; they must never reach the browser. Read nothing outside the source table.
3. Any path built from a file's own field (e.g. `sessionId` → directory) must be validated:
   enforce the expected format and confirm the resolved path stays under its root. "The file
   is written by a trusted tool" is not a substitute for a path-boundary check.

## Stack and layout

TypeScript on both ends: the contract above is only enforceable if the compiler enforces it.

```
shared/types.ts          AgentState
server/
  index.ts               Fastify: /api/state, /events (SSE), static
  store.ts               in-memory state + diff push
  collectors/
    index.ts             registry ← the only file touched when adding a source
    isAlive.ts           shared pid liveness check
    claudeSessions.ts    source 1 (+ 2 via claudeTasks)
    claudeTasks.ts       source 2
    claudeJobs.ts        sources 3, 4
    codexJobs.ts         sources 5, 6
    codexCli.ts          source 7
web/src/
  App.tsx Station.tsx Walker.tsx TaskPanel.tsx
  agentStyle.ts          id-prefix → color / label / phrases
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
