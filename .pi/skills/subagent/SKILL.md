---
name: subagent
description: Delegate tasks to isolated child Pi processes with session resume support.
---

# Subagent Workflow

Use this workflow when a task should be delegated to an isolated child Pi process.

## Available Agents

| Agent | Name | Role | Access |
|-------|------|------|--------|
| `orchestrator` | 主脑 | Coordinates tasks, delegates, makes decisions | read, bash |
| `explorer` | 探索者 | Fast codebase search, read-only investigation | read, grep, glob, ast_grep_search |
| `worker` | 工作者 | Execution — read/write files, run commands | read, write, edit, bash, glob, ast_grep_* |
| `architect` | 架构师 | Architecture review, design decisions, code review | read, grep, glob, ast_grep_search |

### When to Use Which Agent

- **`explorer`** — Find files, search patterns, understand structure, answer "where is X?" questions
- **`worker`** — Implement changes, edit files, run commands, bounded execution tasks
- **`architect`** — Review code, analyze design, trade-off analysis, security/scalability assessment
- **`orchestrator`** — Multi-step coordination requiring planning and synthesis across multiple agents

## Dispatch

```
subagent({ tasks: [{ agent: "orchestrator", task: "..." }] })
```

- `async: true` (default) — Returns run IDs immediately. Poll with `subagent_status`.
- `async: false` — Blocks until all tasks complete, returns full results.
- `keepAlive: true` — Keeps child sessions alive for follow-up.

Multiple tasks run in parallel (use different agents for different concerns):
```
subagent({ tasks: [
  { agent: "explorer", task: "find all files related to auth" },
  { agent: "explorer", task: "search for database migration patterns" },
] })
```

Sequential workflow (investigate then implement):
```
subagent({ tasks: [{ agent: "explorer", task: "investigate X" }], async: false })
// → see result, decide next step
subagent({ tasks: [{ agent: "worker", task: "implement based on: <result>" }], async: false })
// → verify, optionally review
subagent({ tasks: [{ agent: "architect", task: "review the changes for quality" }], async: false })
```

## Session Resume

Set `keepAlive: true` to keep the child session alive after completion.
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
3. Choose the right agent for the task type (see table above).
4. Do not ask children to start more subagents.
5. Treat pending decisions as high priority — respond via `subagent_respond` promptly.
6. Before completion, verify the child result in the parent session.
7. Release kept-alive sessions when done to free child process slots (max 8 concurrent).
