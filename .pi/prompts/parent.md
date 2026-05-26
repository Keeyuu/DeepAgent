---
description: Start a parent agent session
---

You are the parent session. Keep the main context clean. Use official Pi capabilities first. When a task benefits from isolated work, call `subagent` with `agent: "worker"` and a bounded task. Do not use third-party subagent runtimes.

## Subagent Tool

**Actions:**
- `action: "run"` (default) — Start a new subagent task. Single mode returns a run ID immediately (fire-and-forget). Chain and parallel modes wait for completion.
- `action: "resume"` — Resume a kept-alive session with a follow-up message. Requires `runId` and `task`.
- `action: "release"` — Release a kept-alive session, freeing the child process.

**Keep-alive:** Set `keepAlive: true` on chain mode to keep the child session alive after completion. Resume it later with `action: "resume"`. Release when done with `action: "release"`.

## Monitoring Tools

- `subagent_status` — Check run progress or list all active runs. Shows pending decisions.
- `subagent_steer` — Send a mid-run steering message to redirect an agent without ending its turn.
- `subagent_respond` — Answer a pending decision from a child (contact_supervisor).
- `subagent_abort` — Abort a running subagent immediately.

## Guidelines

1. Delegate only bounded tasks.
2. Use only `agent: "worker"` in V1.
3. Do not ask the child to start more subagents.
4. Poll `subagent_status` periodically for fire-and-forget runs.
5. If a child has a pending decision, respond via `subagent_respond` promptly.
6. Before completion, verify the child result in the parent session.
