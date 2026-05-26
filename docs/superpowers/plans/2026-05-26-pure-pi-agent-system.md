# Pure Pi Minimal Subagent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the smallest DeepAgent V1 on top of official Pi extension capabilities: one project-local child-agent runner, one project agent, one safety gate, and project prompt/skill entrypoints.

**Architecture:** DeepAgent V1 is a thin Pi project extension, not a third-party orchestration runtime. The parent Pi session registers a `subagent` tool, starts one child `pi --mode json` process for one project agent, parses JSONL events, and returns the final assistant output. Third-party agent systems are reference material only.

**Tech Stack:** TypeScript, Node.js, official `@earendil-works/pi-coding-agent` extension API, TypeBox schemas, official Pi JSON event stream mode, project-local `.pi/settings.json`, `.pi/extensions/`, `.pi/agents/`, `.pi/prompts/`, `.pi/skills/`, Windows PowerShell.

---

## Decision Reset

This plan replaces the earlier mixed design. The prior plan incorrectly treated `pi-subagents` and `pi-intercom` as official runtime dependencies. They are not official Pi runtime capabilities. They are third-party packages and are only reference material for implementation ideas.

V1 uses only official Pi capabilities:

- official Pi docs and source from `earendil-works/pi`
- official extension API
- official project settings, prompt templates, skills, and extension discovery
- official JSON event stream mode
- official `packages/coding-agent/examples/extensions/subagent` as implementation reference

V1 does not install or depend on:

- `pi-subagents`
- `pi-intercom`
- `pi-agents`
- `pi-crew`
- `pi-multiagent`
- `pi-sub-agent`
- MCP adapters or web-access packages
- SDK/RPC custom host routes

## Reference Policy

### Naming Rule

Use the shortest semantic name for every user-facing and repo-local surface. Do not add `deepagent`, `deepagent_`, `deepagent-`, or `DeepAgent` as a prefix unless the named object is the project/package itself.

Examples:

- tool: `subagent`
- extension directory: `.pi/extensions/subagent/`
- skill directory: `.pi/skills/subagent/`
- parent prompt: `.pi/prompts/parent.md`
- diagnostic command: `/doctor`
- environment variables: `SUBAGENT_CHILD`, `SUBAGENT_DEPTH`

The rule is: name the thing by what it is.

### Official Implementation Baseline

- Pi docs latest: <https://pi.dev/docs/latest>
- Extensions: <https://pi.dev/docs/latest/extensions>
- Settings: <https://pi.dev/docs/latest/settings>
- Prompt templates: <https://pi.dev/docs/latest/prompt-templates>
- Skills: <https://pi.dev/docs/latest/skills>
- JSON event stream: <https://pi.dev/docs/latest/json>
- Official repo: <https://github.com/earendil-works/pi>
- Local official clone: `C:\Code\pi-learn\pi`
- Official subagent example: `C:\Code\pi-learn\pi\packages\coding-agent\examples\extensions\subagent`

Local official clone checked during planning:

```text
repo: https://github.com/earendil-works/pi.git
branch: main
commit: 7c2775f
subagent example: packages/coding-agent/examples/extensions/subagent
```

### Non-Official Reference Only

These repos are useful for reading design ideas, but no V1 dependency may be added from them:

- `C:\Code\pi-learn\pi-subagents`
- `C:\Code\pi-learn\oh-my-pi`
- `C:\Code\pi-learn\oh-my-opencode-slim`
- `C:\Code\pi-learn\opencode-dynamic-context-pruning`

Allowed reference extraction:

- child Pi process launch shape
- JSONL output parsing ideas
- role names and output contracts
- depth guard concepts
- safety wording

Not allowed in V1:

- copy a third-party runtime
- install a third-party package
- bring in chain, parallel, async, worktree, resume/status, intercom, or agent catalog

## V1 Scope

V1 provides exactly one runtime path:

```text
parent Pi session
  -> project extension
  -> subagent tool
  -> one child pi process
  -> one project agent
  -> final Markdown result
```

V1 includes:

- `.pi/settings.json` to load project resources
- `.pi/prompts/parent.md` as the project entry prompt
- `.pi/skills/subagent/SKILL.md` as progressive workflow guidance
- `.pi/agents/worker.md` as the only V1 project child agent
- `.pi/extensions/subagent/index.ts` as the project extension entrypoint wrapper
- focused source modules under `src/extension/`
- unit tests for agent loading, command building, JSONL parsing, depth guard, and safety guard
- README instructions and manual smoke tests

V1 explicitly excludes:

- multiple built-in agents
- child-to-parent realtime communication
- chain or parallel orchestration
- background runs
- worktree isolation
- review loops
- saved workflows
- agent create/update/delete management
- model routing or model backup chains
- MCP and web research tools
- custom provider implementation

When the child needs a decision, it returns:

```text
status: need_decision
question: <specific decision needed>
reason: <why the child cannot safely continue>
```

The parent asks the user or decides, then may run a new child task. V1 does not keep a live child coordination channel open.

## What V1 Gives Us

After V1 lands, the project gets a minimal agent delegation primitive:

- parent context stays cleaner because a child Pi process handles a bounded task
- the child has an isolated context window and a project-specific system prompt
- the parent receives a compact structured Markdown result
- the project has one clear route for future growth

V1 does not yet provide a slim-style full orchestration system. It provides the smallest official-Pi-compatible building block from which such a system can grow.

## Repository Shape

```text
C:\Code\DeepAgent
  AGENTS.md
  README.md
  package.json
  tsconfig.json
  vitest.config.ts
  .pi\
    settings.json
    agents\
      worker.md
    prompts\
      parent.md
    skills\
      subagent\
        SKILL.md
    extensions\
      subagent\
        index.ts
  src\
    extension\
      agents.ts
      guards.ts
      json-events.ts
      paths.ts
      pi-runner.ts
      tool.ts
      types.ts
      agents.test.ts
      guards.test.ts
      json-events.test.ts
      paths.test.ts
      pi-runner.test.ts
```

## Runtime Contract

### Tool Name

The V1 tool is named `subagent`.

Reason: the user-facing API should match the concept directly. Runtime ownership is controlled by the project-local `.pi/extensions/subagent/index.ts`; V1 still does not install third-party subagent runtimes.

### Tool Input

```json
{
  "agent": "worker",
  "task": "Inspect C:\\Code\\DeepAgent and report the project entrypoints. Do not edit files."
}
```

Only `agent` and `task` are accepted in V1.

### Tool Output

The tool returns the final assistant text from the child. The child prompt requires this shape:

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

### Child Process

The extension starts a child Pi process with:

```text
pi --mode json -p --no-session --system-prompt <temp-agent-prompt.md> --tools <agent-tools> "Task: <task>"
```

On Windows, the runner should prefer the current Pi CLI script when available, as the official example does, then use `pi` from PATH only when no script path is discoverable.

### Safety

The extension must block:

- `C:\Users\Goni\.pi\agent\auth.json`
- `.env`
- `.env.*`
- destructive git cleanup or reset commands
- recursive force delete commands

The child process gets:

```text
SUBAGENT_CHILD=1
SUBAGENT_DEPTH=<parent depth + 1>
```

If `SUBAGENT_CHILD=1`, the extension must not register `subagent` again. This prevents nested child delegation in V1.

## File Responsibilities

- `AGENTS.md`: project-level rules and reference policy.
- `.pi/settings.json`: loads the project prompt, skill, extension, and project agent through official Pi resource settings.
- `.pi/prompts/parent.md`: slash prompt entry for starting a parent-guided session.
- `.pi/skills/subagent/SKILL.md`: lightweight subagent workflow guidance loaded on demand.
- `.pi/agents/worker.md`: one project child-agent prompt.
- `.pi/extensions/subagent/index.ts`: Pi extension entry loaded by Pi; re-exports `src/extension/tool.ts`.
- `src/extension/types.ts`: shared TypeScript types.
- `src/extension/agents.ts`: load and validate `.pi/agents/*.md`.
- `src/extension/paths.ts`: path resolution and Pi CLI invocation helpers.
- `src/extension/json-events.ts`: parse Pi JSONL events and extract final assistant text.
- `src/extension/pi-runner.ts`: spawn child Pi and collect output.
- `src/extension/guards.ts`: safety checks for tool calls and paths.
- `src/extension/tool.ts`: register `subagent`.
- `README.md`: install, run, and smoke test instructions.

## Implementation Plan

### Task 1: Reset Project Documentation

**Files:**

- Modify: `C:\Code\DeepAgent\AGENTS.md`
- Modify: `C:\Code\DeepAgent\docs\superpowers\plans\2026-05-26-pure-pi-agent-system.md`

- [ ] **Step 1: Ensure reference policy is explicit**

`AGENTS.md` must say:

```text
V1 depends only on official earendil-works/pi capabilities.
Non-official repos under C:\Code\pi-learn are reference only.
No V1 dependency on pi-subagents, pi-intercom, pi-agents, pi-crew, pi-multiagent, or pi-sub-agent.
```

- [ ] **Step 2: Remove stale third-party runtime claims**

Run:

```powershell
rg -n "V1 必选官方包|官方 `pi-subagents`|官方 `pi-intercom`|pi-intercom.*必选|pi-subagents.*必选" AGENTS.md README.md .pi src
```

Expected:

```text
no matches
```

### Task 2: Project Resource Skeleton

**Files:**

- Create: `C:\Code\DeepAgent\package.json`
- Create: `C:\Code\DeepAgent\tsconfig.json`
- Create: `C:\Code\DeepAgent\vitest.config.ts`
- Create: `C:\Code\DeepAgent\.pi\settings.json`
- Create: `C:\Code\DeepAgent\.pi\extensions\subagent\index.ts`
- Create: `C:\Code\DeepAgent\.pi\prompts\parent.md`
- Create: `C:\Code\DeepAgent\.pi\skills\subagent\SKILL.md`
- Create: `C:\Code\DeepAgent\.pi\agents\worker.md`

- [ ] **Step 1: Create package metadata**

```json
{
  "name": "deepagent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "check": "npm run typecheck && npm run test"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  },
  "dependencies": {
    "typebox": "^1.1.24"
  }
}
```

- [ ] **Step 2: Create TypeScript config**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", ".pi/extensions/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create Pi project settings**

```json
{
  "extensions": ["extensions/subagent/index.ts"],
  "prompts": ["prompts/parent.md"],
  "skills": ["skills/subagent"],
  "enableSkillCommands": true
}
```

Paths are relative to `.pi/settings.json`.

- [ ] **Step 4: Create Pi extension wrapper**

`.pi/extensions/subagent/index.ts`:

```ts
export { default } from "../../../src/extension/tool.ts";
```

- [ ] **Step 5: Create project prompt**

```markdown
---
description: Start a parent agent session
---

You are the parent session. Keep the main context clean. Use official Pi capabilities first. When a task benefits from isolated work, call `subagent` with `agent: "worker"` and a bounded task. Do not use third-party subagent runtimes. If the child returns `status: need_decision`, resolve the decision in the parent session before launching another child.
```

- [ ] **Step 6: Create project skill**

```markdown
---
name: subagent
description: Official-Pi-only child delegation workflow.
---

# Subagent Workflow

Use this workflow when a task should be delegated to an isolated child Pi process.

1. Keep the parent session responsible for user communication, decisions, and final verification.
2. Delegate only bounded tasks to `subagent`.
3. Use only `agent: "worker"` in V1.
4. Do not ask the child to start more subagents.
5. Treat `status: need_decision` as a stop condition.
6. Before completion, verify the child result from the parent session.
```

- [ ] **Step 7: Create the only V1 agent**

```markdown
---
name: worker
description: Minimal child worker for bounded isolated tasks.
tools: read, grep, find, ls, bash, edit, write
---

You are the V1 child worker. Execute exactly the delegated task.

Rules:
- Stay inside the assigned task.
- Preserve unrelated changes.
- Use existing project patterns.
- Do not start subagents.
- Do not read, print, or modify `C:\Users\Goni\.pi\agent\auth.json`.
- If a decision is required before continuing, stop and return `status: need_decision`.

Return:

status: completed | failed | need_decision
agent: worker

summary:
- ...

evidence:
- ...

changed_files:
- ...

validation:
- ...

risks:
- ...
```

### Task 3: Agent Loader

**Files:**

- Create: `C:\Code\DeepAgent\src\extension\types.ts`
- Create: `C:\Code\DeepAgent\src\extension\agents.ts`
- Create: `C:\Code\DeepAgent\src\extension\agents.test.ts`

- [ ] **Step 1: Define V1 types**

```ts
export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  systemPrompt: string;
  filePath: string;
}

export interface DeepagentSubagentInput {
  agent: "worker";
  task: string;
}

export interface ChildRunResult {
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  stderr: string;
}
```

- [ ] **Step 2: Implement project-only agent discovery**

Load only `C:\Code\DeepAgent\.pi\agents\*.md`. Do not load user-level agents in V1.

Parsing rules:

- frontmatter starts and ends with `---`
- required fields: `name`, `description`
- optional field: `tools`, comma-separated
- body is `systemPrompt`
- only `worker` is accepted

- [ ] **Step 3: Test agent loading**

Test cases:

- loads `.pi/agents/worker.md`
- rejects missing `name`
- rejects unknown agent names
- parses tools into string array

Run:

```powershell
npm run test -- src/extension/agents.test.ts
```

Expected:

```text
PASS
```

### Task 4: JSON Event Parser

**Files:**

- Create: `C:\Code\DeepAgent\src\extension\json-events.ts`
- Create: `C:\Code\DeepAgent\src\extension\json-events.test.ts`

- [ ] **Step 1: Extract assistant text from JSONL**

Read stdout line by line. Ignore non-JSON lines. For parsed events:

- collect `message_end` events where `message.role === "assistant"`
- for each assistant message, collect text parts from `message.content`
- return the last assistant text

- [ ] **Step 2: Preserve diagnostics**

Return:

```ts
{
  finalText: string;
  assistantMessages: number;
  parseErrors: number;
}
```

- [ ] **Step 3: Test parser behavior**

Test cases:

- returns last assistant text
- ignores non-JSON lines
- returns empty string when no assistant message exists
- counts parse errors

Run:

```powershell
npm run test -- src/extension/json-events.test.ts
```

Expected:

```text
PASS
```

### Task 5: Child Pi Runner

**Files:**

- Create: `C:\Code\DeepAgent\src\extension\paths.ts`
- Create: `C:\Code\DeepAgent\src\extension\pi-runner.ts`
- Create: `C:\Code\DeepAgent\src\extension\paths.test.ts`
- Create: `C:\Code\DeepAgent\src\extension\pi-runner.test.ts`

- [ ] **Step 1: Resolve Pi invocation**

Use the official example pattern:

- if `process.argv[1]` points to a real script, run `process.execPath <current-pi-script> ...args`
- otherwise run `pi ...args`

This is required for Windows compatibility.

- [ ] **Step 2: Build child args**

For V1, args are:

```ts
[
  "--mode", "json",
  "-p",
  "--no-session",
  "--system-prompt", promptFile,
  "--tools", agent.tools.join(","),
  `Task: ${task}`
]
```

If `task.length > 8000`, write a temp `task.md` and pass `@<taskFile>` instead of inline task.

- [ ] **Step 3: Spawn child process**

Use:

```ts
spawn(command, args, {
  cwd,
  env: {
    ...process.env,
    SUBAGENT_CHILD: "1",
    SUBAGENT_DEPTH: String(depth + 1)
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
})
```

- [ ] **Step 4: Test without launching real Pi**

Unit tests mock the spawn function and verify:

- command and args are built correctly
- temp prompt file is written with mode `0o600` where supported
- `SUBAGENT_CHILD=1` is passed
- stderr is returned on non-zero exit

Run:

```powershell
npm run test -- src/extension/paths.test.ts src/extension/pi-runner.test.ts
```

Expected:

```text
PASS
```

### Task 6: Safety Guard

**Files:**

- Create: `C:\Code\DeepAgent\src\extension\guards.ts`
- Create: `C:\Code\DeepAgent\src\extension\guards.test.ts`

- [ ] **Step 1: Implement path and command checks**

Block:

```ts
[
  "C:\\Users\\Goni\\.pi\\agent\\auth.json",
  ".env",
  ".env.local",
  ".env.production"
]
```

Block command substrings:

```ts
[
  "git reset --hard",
  "git checkout --",
  "git clean",
  "Remove-Item -Recurse -Force",
  "rm -rf"
]
```

- [ ] **Step 2: Test guard**

Test cases:

- blocks exact auth path
- blocks `.env` and `.env.*`
- blocks destructive git command
- allows harmless `git status --short`

Run:

```powershell
npm run test -- src/extension/guards.test.ts
```

Expected:

```text
PASS
```

### Task 7: Extension Tool Registration

**Files:**

- Create: `C:\Code\DeepAgent\src\extension\tool.ts`
- Modify: `C:\Code\DeepAgent\.pi\settings.json`

- [ ] **Step 1: Register safety hook**

Use Pi `tool_call` event to block protected reads/writes/bash commands before execution.

- [ ] **Step 2: Register `subagent`**

Schema:

```ts
import { Type } from "typebox";

const Params = Type.Object({
  agent: Type.String({ enum: ["worker"] }),
  task: Type.String({ minLength: 1 })
});
```

Execution:

- reject when `SUBAGENT_CHILD=1`
- reject when `SUBAGENT_DEPTH >= 1`
- load project agent
- run child Pi
- return final child output

- [ ] **Step 3: Register a short command**

Add `/doctor` to print:

```text
DeepAgent V1
extension: loaded
agent: worker found|missing
third-party runtimes: not used
```

### Task 8: README and Smoke Tests

**Files:**

- Create: `C:\Code\DeepAgent\README.md`

- [ ] **Step 1: Document V1 boundaries**

README must state:

```text
DeepAgent V1 uses official Pi extension capabilities only.
Non-official repos under C:\Code\pi-learn are reference material only.
No dependency on pi-subagents or pi-intercom.
```

- [ ] **Step 2: Run unit checks**

```powershell
npm install
npm run check
```

Expected:

```text
typecheck exits 0
vitest exits 0
```

- [ ] **Step 3: Run Pi smoke test**

From `C:\Code\DeepAgent`:

```powershell
pi
```

Then inside Pi:

```text
/reload
/doctor
Use subagent with agent worker to inspect C:\Code\DeepAgent and return the files that define DeepAgent V1. Do not edit files.
```

Expected:

```text
doctor reports extension loaded and worker found
child Pi process runs
result contains status: completed
changed_files: none
```

- [ ] **Step 4: Run safety smoke**

Inside Pi:

```text
Read C:\Users\Goni\.pi\agent\auth.json
```

Expected:

```text
DeepAgent guard blocks the request before tool execution.
```

## Future Work

Only after V1 smoke passes, evaluate these separately:

- add `scout` as a second project agent
- add read-only parallel review
- add parent-controlled review loop
- add child decision resume flow
- evaluate third-party `pi-subagents` only as a reference benchmark
- evaluate real-time coordination only after a concrete need appears

No future work is part of V1.

## Appendix A: Reference Findings

Official Pi docs confirm:

- Pi core is small and extended through TypeScript extensions, skills, prompt templates, themes, and packages.
- Extensions can register tools, commands, event handlers, custom UI, message renderers, providers, and state entries.
- Project settings live at `.pi/settings.json` and override global settings.
- Resource paths in `.pi/settings.json` resolve relative to `.pi`.
- JSON event stream mode is available through `pi --mode json` and emits one JSON object per line.

Official subagent example confirms:

- child agents can be modeled as Markdown files with frontmatter
- a project agent path can be `.pi/agents/*.md`
- a child Pi process can be launched with `--mode json -p --no-session`
- the parent can parse `message_end` events to collect assistant output
- single/parallel/chain are possible, but DeepAgent V1 intentionally implements only single

Third-party `pi-subagents` confirms useful ideas but remains reference only:

- mature packages add significant surface area: async, status, resume, worktree, intercom, nested fanout, artifacts, model routing, and agent management
- the minimal useful core is still `registerTool -> load agent prompt -> spawn child pi --mode json -> parse final assistant output`
- DeepAgent V1 should implement that minimal core directly using official Pi APIs
