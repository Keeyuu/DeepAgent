---
name: subagent
description: Official-Pi-only child delegation workflow with session resume.
---

# Subagent Workflow

Use this workflow when a task should be delegated to an isolated child Pi process.

## Modes

1. **Single** (`agent` + `task`) — Fire-and-forget: returns run ID immediately. Poll with `subagent_status`.
2. **Parallel** (`tasks` array) — Runs tasks concurrently, waits for all to complete.
3. **Chain** (`chain` array) — Runs steps sequentially, `{previous}` placeholder for prior output.

## Session Resume (chain only)

Set `keepAlive: true` on chain mode to keep the child session alive after completion.
- Later: `action: "resume"` with `runId` + `task` to continue the session.
- Done: `action: "release"` with `runId` to free the child process.

## Monitoring

- `subagent_status` — Check progress, list active runs, see pending decisions.
- `subagent_steer` — Redirect a running agent mid-turn.
- `subagent_respond` — Answer a child's decision request (via contact_supervisor).
- `subagent_abort` — Kill a running subagent immediately.

## Guidelines

1. Keep the parent session responsible for user communication, decisions, and final verification.
2. Delegate only bounded tasks to `subagent`.
3. Use only `agent: "worker"` in V1.
4. Do not ask the child to start more subagents.
5. Treat pending decisions as high priority — respond via `subagent_respond` promptly.
6. Before completion, verify the child result in the parent session.
7. Release kept-alive sessions when done to free child process slots (max 8 concurrent).
