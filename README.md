# DeepAgent

Agent delegation built on official Pi extension capabilities, with RPC transport and parent-child communication.

## What It Does

DeepAgent gives your Pi session the ability to delegate tasks to isolated child agents:

```
parent Pi session
  → subagent tool (single / parallel / chain)
  → child pi --mode rpc
  → worker agent
  → structured result
```

The parent stays clean. Each child has its own context window, project-specific prompt, and bidirectional communication via RPC.

## Quick Start

```powershell
npm install
npm run check        # TypeScript + 50 unit tests
pi                   # start Pi from project root
```

Inside Pi:

```
/doctor              # check extension status, list available agents

# Single task
Use subagent with agent "worker" to list project files. Do not edit anything.

# Parallel tasks
Use subagent with tasks [{"agent":"worker","task":"Check tests"},{"agent":"worker","task":"Check types"}]

# Chain (sequential with {previous} substitution)
Use subagent with chain [{"agent":"worker","task":"Find all test files"},{"agent":"worker","task":"Review {previous} for coverage gaps"}]
```

## Architecture

Built on official Pi capabilities:

- Extension API from `@earendil-works/pi-coding-agent`
- `--mode rpc` for bidirectional JSONL communication (stdin/stdout)
- Project-local agents in `.pi/agents/*.md`
- User-level agents from `~/.pi/agent/agents/*.md`
- `AgentToolResult`, renderCall/renderResult from official subagent demo

Key additions over the official demo:
- **RPC transport**: replaces `--mode json` fire-and-forget spawn with `--mode rpc` session (allows steer/followUp/abort)
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
    guards.ts              # Safety guards (blocked paths/commands)
    tool.ts                # Extension registration (subagent tool + contact_supervisor + /doctor)
    *.test.ts              # Unit tests
scripts/
  smoke-rpc.ts             # Integration smoke test
```

## Modes

### Single

```json
{ "agent": "worker", "task": "List all TypeScript files in src/" }
```

### Parallel

Up to 8 tasks, 4 concurrent. Each capped at 50KB output.

```json
{
  "tasks": [
    { "agent": "worker", "task": "Check test coverage" },
    { "agent": "worker", "task": "Find TODO comments" }
  ]
}
```

### Chain

Sequential execution. `{previous}` substituted with prior step output.

```json
{
  "chain": [
    { "agent": "worker", "task": "Find all test files" },
    { "agent": "worker", "task": "Review {previous} for gaps" }
  ]
}
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

## Safety

The extension blocks:

- Access to `auth.json`, `.env`, `.env.*`
- Destructive git commands (`git reset --hard`, `git clean`, etc.)
- Recursive force delete commands
- Nested subagent delegation (when `SUBAGENT_CHILD=1`)

When `SUBAGENT_CHILD=1`, the extension registers `contact_supervisor` instead of `subagent`.

## Tests

```powershell
npm run test        # 50 unit tests
npm run typecheck   # TypeScript type check
npm run check       # Both
npx tsx scripts/smoke-rpc.ts   # Integration smoke test (requires Pi + model access)
```

## Validation Record

2026-05-26 Phase 2 smoke tests:

| # | Test | Result |
|---|------|--------|
| 1 | Unit tests | Passed: 50 tests |
| 2 | TypeScript check | Passed: 0 errors |
| 3 | Agent discovery | Passed: worker agent found (project scope) |
| 4 | RPC session startup | Passed: session started, handshake completed |
| 5 | Single task (list files) | Passed: child used ls tool, returned structured output |
| 6 | Event accumulation | Passed: 363 events, 6 messages, usage tracked |
| 7 | Process cleanup | Passed: exit code 0, no stderr |

## Future Work

- Async mode: `subagent_async` + `subagent_status` + `subagent_abort` tools
- Steer/followUp from parent agent
- `scout` agent for read-only exploration
- Review loops
