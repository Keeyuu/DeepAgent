# DeepAgent

Minimal agent delegation built on official Pi extension capabilities.

## V1 Scope

DeepAgent V1 uses official Pi extension capabilities only.

- Extension API from `@earendil-works/pi-coding-agent`
- Project-local agents in `.pi/agents/*.md`
- JSON event stream mode (`pi --mode json`)
- One tool: `subagent`
- One agent: `worker`
- One command: `/doctor`

Non-official repos under `C:\Code\pi-learn` are reference material only. No dependency on `pi-subagents`, `pi-intercom`, or any third-party agent runtime.

## Setup

```powershell
npm install
npm run check
```

`npm run check` runs TypeScript type checking and all unit tests.

## Project Structure

```text
.pi/
  settings.json          # Pi project settings
  agents/
    worker.md            # The only V1 child agent
  prompts/
    parent.md            # Parent session entry prompt
  skills/
    subagent/
      SKILL.md           # Subagent workflow skill
  extensions/
    subagent/
      index.ts           # Extension entrypoint (re-exports src/extension/tool.ts)
src/
  extension/
    types.ts             # Shared TypeScript interfaces
    agents.ts            # Agent loading from .pi/agents/*.md
    agents.test.ts
    json-events.ts       # JSONL event stream parser
    json-events.test.ts
    paths.ts             # Pi invocation and arg building
    paths.test.ts
    pi-runner.ts         # Child Pi process runner
    pi-runner.test.ts
    guards.ts            # Safety guards (blocked paths/commands, depth)
    guards.test.ts
    tool.ts              # Extension registration (subagent tool + /doctor)
```

## Usage

Start Pi from the project root:

```powershell
pi
```

Inside Pi:

```text
/reload          # Load the extension
/doctor          # Check extension status

# Delegate a task to the worker agent
Use subagent with agent "worker" to inspect the project and report entrypoints. Do not edit files.
```

## Tool Input

```json
{
  "agent": "worker",
  "task": "A bounded task description."
}
```

## Tool Output

The tool returns the child's final assistant text, which follows this shape:

```text
status: completed | failed | need_decision
agent: worker

summary:
- concrete result

evidence:
- file paths, command summaries, or "none"

changed_files:
- paths, or "none"

validation:
- command and result, or "not run: <reason>"

risks:
- remaining risk, or "none"
```

## Safety

The extension blocks:

- Access to `auth.json`, `.env`, `.env.*`
- Destructive git commands (`git reset --hard`, `git clean`, etc.)
- Recursive force delete commands
- Nested subagent delegation (when `SUBAGENT_CHILD=1`)

## Tests

```powershell
npm run test        # Run unit tests
npm run typecheck   # TypeScript type check
npm run check       # Both
```

## Future Work

Only after V1 smoke passes:

- Add `scout` as a second project agent
- Add read-only parallel review
- Add parent-controlled review loop
- Evaluate third-party runtimes as reference benchmarks only
