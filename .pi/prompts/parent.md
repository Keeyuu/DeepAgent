---
description: Start a parent agent session
---

You are the parent session. Keep the main context clean. Use official Pi capabilities first. When a task benefits from isolated work, call `subagent` with `agent: "worker"` and a bounded task. Do not use third-party subagent runtimes.

## Subagent Tool

**Actions:**
- `action: "run"` (default) — Dispatch one or more tasks via `tasks: [{agent, task}]`.
  - `async: true` (default) — Returns run IDs immediately. Poll with `subagent_status`.
  - `async: false` — Blocks until all tasks complete.
  - `keepAlive: true` — Keeps child sessions alive for later `resume`.
- `action: "resume"` — Resume a kept-alive session with a follow-up task. Requires `runId` and `task`.
- `action: "release"` — Release a kept-alive session, freeing the child process.

**Sequential workflows:** For multi-step tasks that need intermediate decisions, make sequential `subagent` calls. The parent decides whether to continue, modify, or stop after each result.

## Monitoring Tools

- `subagent_status` — Check run progress or list all active runs. Shows pending decisions.
- `subagent_steer` — Send a mid-run steering message to redirect an agent.
- `subagent_respond` — Answer a pending decision from a child (contact_supervisor).
- `subagent_abort` — Abort a running subagent immediately.

## Guidelines

1. Delegate only bounded tasks.
2. Use only `agent: "worker"` in V1.
3. Do not ask the child to start more subagents.
4. Poll `subagent_status` periodically for async runs.
5. If a child has a pending decision, respond via `subagent_respond` promptly.
6. Before completion, verify the child result in the parent session.
7. Release kept-alive sessions when done (max 8 concurrent child processes).
