# DeepAgent

Agent delegation built on official Pi extension capabilities, with RPC transport and parent-child communication.

## What It Does

DeepAgent gives your Pi session the ability to delegate tasks to isolated child agents:

```
parent Pi session
  → subagent tool (tasks[])
  → child pi --mode rpc
  → worker agent
  → structured result
```

The parent stays clean. Each child has its own context window, project-specific prompt, and bidirectional communication via RPC.

## Quick Start

```powershell
npm install
npm run check        # TypeScript + 76 unit tests
pi                   # start Pi from project root
```

Inside Pi:

```
/doctor              # check extension status, list available agents

# Single task (async by default)
Use subagent with tasks [{"agent":"worker","task":"List project files. Do not edit anything."}]

# Parallel tasks
Use subagent with tasks [{"agent":"worker","task":"Check tests"},{"agent":"worker","task":"Check types"}]

# Sync (blocking)
Use subagent with tasks [{"agent":"worker","task":"Find all test files"}] async false

# Sequential workflow (parent decides next step after each result)
Use subagent with tasks [{"agent":"worker","task":"Analyze coverage"}] async false
# → see result, then:
Use subagent with tasks [{"agent":"worker","task":"Fix uncovered areas based on: <result>"}] async false
```

## Architecture

Built on official Pi capabilities:

- Extension API from `@earendil-works/pi-coding-agent`
- `--mode rpc` for bidirectional JSONL communication (stdin/stdout)
- Project-local agents in `.pi/agents/*.md`
- User-level agents from `~/.pi/agent/agents/*.md`
- `AgentToolResult`, renderCall/renderResult from official subagent demo

Key additions over the official demo:
- **Unified dispatch**: single `tasks[]` array with `async` boolean — no separate single/parallel/chain modes
- **Session resume**: `keepAlive` keeps child alive for follow-up via `action: "resume"`
- **contact_supervisor tool**: child can send progress updates and decision requests to parent via `ctx.ui.confirm/input/notify`
- **Windows compatibility**: resolves `pi` CLI path for `shell:false` spawn

### Reference Policy

Only official `earendil-works/pi` dependencies. No third-party runtimes.

- Pi docs: <https://pi.dev/docs/latest>
- Official repo: <https://github.com/earendil-works/pi>
- Local clone: `C:\Code\pi-learn\pi`
- Official subagent example: `packages/coding-agent/examples/extensions/subagent`

## Project Structure

```
.pi/
  settings.json            # Extension, prompts, skills registration
  agents/
    worker.md              # Child agent: bounded task execution
  prompts/
    parent.md              # Parent session entry prompt
  skills/
    subagent/
      SKILL.md             # Subagent workflow skill
  extensions/
    subagent/
      index.ts             # Extension entrypoint (re-exports src/extension/tool.ts)
src/
  extension/
    types.ts               # Shared interfaces (UsageStats, SingleResult, etc.)
    agents.ts              # Agent discovery (user + project scope)
    event-accumulator.ts   # Pure functions for RPC event accumulation
    rpc-session.ts         # RPC session manager (--mode rpc spawn)
    run-registry.ts        # Active run tracking and status queries
    session-pool.ts        # Idle session pool for keepAlive/resume
    guards.ts              # Safety guards (blocked paths/commands)
    tool.ts                # Extension registration (subagent tool + monitoring tools + /doctor)
    *.test.ts              # Unit tests
scripts/
  smoke-rpc.ts             # Integration smoke test
  smoke-async.ts           # Async mode smoke test
  smoke-resume.ts          # Session resume smoke test
```

## Dispatch Model

All tasks use a unified `tasks[]` array. No separate modes.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tasks` | `Array<{agent, task, cwd?}>` | — | Tasks to dispatch (action=run) |
| `async` | `boolean` | `true` | Return run IDs immediately (true) or block until complete (false) |
| `keepAlive` | `boolean` | `false` | Keep child sessions alive for later resume |
| `action` | `"run"\|"resume"\|"release"` | `"run"` | Run new tasks, resume a session, or release it |
| `runId` | `string` | — | Session ID for resume/release |
| `agentScope` | `"user"\|"project"\|"both"` | `"user"` | Which agent directories to search |

### Async Mode (default)

Returns immediately with run IDs. Poll with `subagent_status`.

```json
{
  "tasks": [{"agent": "worker", "task": "Check test coverage"}]
}
```

### Sync Mode

Blocks until all tasks complete. Parent sees full results.

```json
{
  "tasks": [{"agent": "worker", "task": "Check test coverage"}],
  "async": false
}
```

### Session Resume

```json
// Launch with keepAlive
{ "tasks": [{"agent": "worker", "task": "Analyze codebase"}], "keepAlive": true }

// Resume later
{ "action": "resume", "runId": "...", "task": "Now fix the issues you found" }

// Release when done
{ "action": "release", "runId": "..." }
```

## Agent Scope

- `"user"` (default): agents from `~/.pi/agent/agents/*.md`
- `"project"`: agents from `.pi/agents/*.md` (walks up directories)
- `"both"`: project agents override user agents by name

## Runtime Contract

### Child Process

```
pi --mode rpc --no-session -p --tools <tools> --append-system-prompt <prompt.md> "Task: <task>"
```

Environment: `SUBAGENT_CHILD=1`, `SUBAGENT_DEPTH=<parent+1>`

### Parent → Child (via RPC session)

- `prompt(message)` — send initial task
- `steer(message)` — modify agent behavior mid-run
- `followUp(message)` — continue after agent_end
- `abort()` — graceful stop

### Child → Parent (via contact_supervisor tool)

- `type: "progress"` — fire-and-forget notification (`ctx.ui.notify`)
- `type: "decision"` — blocking request (`ctx.ui.confirm` or `ctx.ui.input`)

### Extension UI Protocol

Child extensions that call `ctx.ui.confirm/input/select` emit `extension_ui_request` on stdout. The parent auto-responds (confirm=true, input="", select=first option). Fire-and-forget methods (notify, setStatus, setTitle) require no response.

## Monitoring Tools

- **subagent_status** — Check run progress or list all active runs. Shows pending decisions.
- **subagent_steer** — Send a mid-run steering message to redirect an agent.
- **subagent_respond** — Answer a pending decision from a child (contact_supervisor).
- **subagent_abort** — Abort a running subagent immediately.

## Safety

The extension blocks:

- Access to `auth.json`, `.env`, `.env.*`
- Destructive git commands (`git reset --hard`, `git clean`, etc.)
- Recursive force delete commands
- Nested subagent delegation (when `SUBAGENT_CHILD=1`)

When `SUBAGENT_CHILD=1`, the extension registers `contact_supervisor` instead of `subagent`.

## Tests

```powershell
npm run test        # 76 unit tests
npm run typecheck   # TypeScript type check
npm run check       # Both
npx tsx scripts/smoke-rpc.ts      # Integration smoke test (requires Pi + model access)
npx tsx scripts/smoke-async.ts    # Async mode smoke test
npx tsx scripts/smoke-resume.ts   # Session resume smoke test
```

## Validation Record

2026-05-27 Unified dispatch:

| # | Test | Result |
|---|------|--------|
| 1 | Unit tests | Passed: 76 tests |
| 2 | TypeScript check | Passed: 0 errors |
| 3 | Agent discovery | Passed: worker agent found (project scope) |
| 4 | RPC session startup | Passed: session started, handshake completed |
| 5 | Unified tasks[] dispatch | Passed: async/sync paths, parallel tasks |
| 6 | Session resume | Passed: keepAlive + resume + release |
| 7 | Event accumulation | Passed: usage tracked, messages captured |
| 8 | Process cleanup | Passed: exit code 0, no stderr |

## Future Work

- `scout` agent for read-only exploration
- Review loops (auto-resume for iterative refinement)
- Capacity-aware scheduling across multiple agent types
