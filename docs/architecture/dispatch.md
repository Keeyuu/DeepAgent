# Unified Subagent Dispatch

## Overview

All subagent tasks use a single `tasks[]` array. No separate single/parallel/chain modes.

- **`tasks[]`** — Array of `{agent, task, cwd?}` items
- **`async`** (default `true`) — Return run IDs immediately, or block until all complete
- **`keepAlive`** (default `false`) — Keep child sessions alive for `resume`

## Dispatch Paths

### Async (default)

```
parent calls subagent({ tasks: [...] })
  → launchAgent() per task (fire-and-forget)
  → returns run IDs immediately
  → parent polls subagent_status
  → on completion: result stored in run-registry
```

### Sync

```
parent calls subagent({ tasks: [...], async: false })
  → runAgent() per task (blocking)
  → awaits waitForIdle()
  → returns full results (messages, usage, output)
```

## Session Lifecycle

```
run
  → launchAgent() → session.start() → session.prompt()
  → [async] returns runId
  → [sync]  awaits completion

keepAlive
  → on agent_end: session → session-pool (idle)
  → resume: session.prompt(newTask) → running again
  → release: session.close() → freed

no keepAlive
  → on agent_end: 60s auto-cleanup
```

## Capacity

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_PARALLEL_TASKS` | 8 | Max tasks per dispatch call |
| `MAX_CONCURRENCY` | 4 | Max simultaneous launches |
| `MAX_TOTAL_CHILDREN` | 8 | Max active + pooled sessions |

## Monitoring Tools

| Tool | Purpose |
|------|---------|
| `subagent_status` | Check run progress, list active runs, see pending decisions |
| `subagent_steer` | Mid-run steering message |
| `subagent_respond` | Answer child's decision request (contact_supervisor) |
| `subagent_abort` | Kill running subagent |

## Child → Parent Communication

Child uses `contact_supervisor` tool:

- `type: "progress"` → `ctx.ui.notify` (fire-and-forget)
- `type: "decision"` → `ctx.ui.confirm` or `ctx.ui.input` (blocking, parent responds via `subagent_respond`)

## Key Implementation Files

| File | Role |
|------|------|
| `src/extension/tool.ts` | Extension registration, dispatch logic, renderCall/renderResult |
| `src/extension/types.ts` | Shared types: `SingleResult`, `SubagentDetails`, `AsyncRunInfo`, `UsageStats` |
| `src/extension/rpc-session.ts` | RPC session lifecycle (start, prompt, steer, abort) |
| `src/extension/run-registry.ts` | Active run tracking and status queries |
| `src/extension/session-pool.ts` | Idle session pool for keepAlive/resume |
| `src/extension/event-accumulator.ts` | Pure functions for RPC event → result accumulation |
| `src/extension/agents.ts` | Agent discovery (user + project scope) |
| `src/extension/guards.ts` | Safety guards (blocked paths/commands) |

## Sequential Workflows

Chains are emulated by the parent making sequential calls:

```
1. subagent({ tasks: [{agent: "worker", task: "analyze"}], async: false })
   → parent sees result, decides next step
2. subagent({ tasks: [{agent: "worker", task: "fix based on: <result>"}], async: false })
   → parent verifies, done
```

This is more flexible than automatic chains because the parent can:
- Modify the next task based on intermediate results
- Skip steps
- Change agent or parameters
- Abort early
