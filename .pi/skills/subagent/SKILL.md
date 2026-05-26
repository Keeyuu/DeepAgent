---
name: subagent
description: Delegate tasks to isolated child Pi processes with session resume support.
---

# Subagent Workflow

Use this workflow when a task should be delegated to an isolated child Pi process.

## Dispatch

```
subagent({ tasks: [{ agent: "worker", task: "..." }] })
```

- `async: true` (default) — Returns run IDs immediately. Poll with `subagent_status`.
- `async: false` — Blocks until all tasks complete, returns full results.
- `keepAlive: true` — Keeps child sessions alive for follow-up.

Multiple tasks run in parallel:
```
subagent({ tasks: [
  { agent: "worker", task: "task A" },
  { agent: "worker", task: "task B" },
] })
```

## Session Resume

Set `keepAlive: true` to keep the child session alive after completion.
- Later: `action: "resume"` with `runId` + `task` to continue the session.
- Done: `action: "release"` with `runId` to free the child process.

## Sequential Workflows

For multi-step tasks, make sequential `subagent` calls. The parent sees each result and decides whether to continue:
```
subagent({ tasks: [{ agent: "researcher", task: "investigate X" }], async: false })
// → see result, decide next step
subagent({ tasks: [{ agent: "coder", task: "implement based on: <result>" }], async: false })
```

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
