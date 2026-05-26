# Session Resume: Subagent Idle Keep-Alive and Reuse

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a foreground subagent completes a task, let the parent agent choose whether to destroy the child process or keep it alive for follow-up tasks. This preserves accumulated context across multiple tasks without re-investigation.

**Architecture:** When `subagent` finishes a foreground task with `keepAlive: true`, instead of calling `session.stop()`, store the `RpcSession` in an in-process pool keyed by `runId`. Return the `runId` to the parent agent. The parent then decides: release (destroy) or resume (follow-up) — both via the `action` parameter on the `subagent` tool itself (no separate tools). The pool and async run-registry share a combined child process limit of 8.

**Transport:** Official RPC mode (`--mode rpc`) via `RpcSession`. No file system bridge, no run-store, no new transport.

---

## Motivation

Current behavior: every `subagent` call creates a new child process, runs one task, then destroys it.

```
parent → subagent({ agent: "worker", task: "调研项目结构" })
  → child 启动，读文件，理解代码
  → child 返回结果
  → child 进程销毁，上下文丢失

parent → subagent({ agent: "worker", task: "基于调研改 README" })
  → 全新的 child 启动，又要从头调研
  → 浪费 token，浪费时间，丢失之前的理解
```

Desired behavior: parent can keep the child alive and send follow-up tasks.

```
parent → subagent({ agent: "worker", task: "调研项目结构", keepAlive: true })
  → child 启动，读文件，理解代码
  → child 返回结果 + runId: "run_abc123"
  → child 进程保持 idle，上下文完整保留

parent → subagent({ action: "resume", runId: "run_abc123", task: "基于刚才的调研改 README" })
  → 同一个 child，上下文接力
  → child 直接改 README，不需要重新调研

parent → subagent({ action: "release", runId: "run_abc123" })
  → child 进程销毁
```

## Scope

### In Scope

- `keepAlive` option on `subagent` foreground calls
- `action` parameter on `subagent` tool: `run` (default), `resume`, `release`
- In-process `RpcSession` pool (`Map<runId, PooledSession>`)
- Shared child process limit: `activeRuns.size + pool.size < MAX_TOTAL_CHILDREN` (8)
- `RpcSession.isAlive()` for death detection
- `RpcSession.killSync()` for exit handler
- `runId` in foreground result when `keepAlive: true`
- Idle sessions exempt from `waitForIdle` timeout
- Pool cleanup on parent process exit via sync `killSync()`
- Resume events collected in local array, merged on success

### Out of Scope

- Auto-release timeout based on idle duration (V1: sessions stay idle indefinitely; `createdAt` field reserved for future use)
- Persisting sessions across parent restarts
- Session serialization / deserialization
- Resuming async (background) sessions — those already stay alive
- Multiple concurrent tasks on the same session

## Runtime Model

### Foreground with keepAlive

```json
// Request
{
  "agent": "worker",
  "task": "investigate project structure",
  "agentScope": "both",
  "keepAlive": true
}

// Response (adds runId)
{
  "content": [{ "type": "text", "text": "... investigation result ..." }],
  "details": { "mode": "single", "results": [...], "runId": "run_abc123" }
}
```

### Resume

```json
// Request
{
  "action": "resume",
  "runId": "run_abc123",
  "task": "based on the investigation, update README"
}

// Response
{
  "content": [{ "type": "text", "text": "... updated README ..." }],
  "details": { "mode": "single", "results": [...], "runId": "run_abc123" }
}
```

### Release

```json
// Request
{
  "action": "release",
  "runId": "run_abc123"
}

// Response
{
  "content": [{ "type": "text", "text": "Session run_abc123 released." }],
  "details": undefined
}
```

### Resource Limit: Shared Across Pool and Registry

Both the async run-registry (`activeRuns`) and the session pool (`pooledSessions`) spawn child processes. They share a combined limit:

```ts
// In session-pool.ts — check before adding
import { getActiveRunCount } from "./run-registry.ts";

const MAX_TOTAL_CHILDREN = 8;

function totalChildCount(): number {
  return pool.size + getActiveRunCount();
}

// When adding to pool:
if (totalChildCount() >= MAX_TOTAL_CHILDREN) {
  throw new Error(`Max concurrent child processes reached (${MAX_TOTAL_CHILDREN}). Release or abort existing runs first.`);
}
```

Similarly, `run-registry.ts` should check pool size:

```ts
// In run-registry.ts — updated check
import { getPoolSize } from "./session-pool.ts";

function totalChildCount(): number {
  return activeRuns.size + getPoolSize();
}

export function registerRun(info: AsyncRunInfo): string {
  if (totalChildCount() >= MAX_TOTAL_CHILDREN) { ... }
  ...
}
```

### Parent Exit Cleanup (Sync)

When the parent process exits, `process.on('exit')` fires. This hook **cannot** be async. We need a synchronous `killSync()` method on `RpcSession`:

```ts
// In rpc-session.ts
/** Synchronous kill — for use in process.on('exit'). No cleanup. */
killSync(): void {
  if (this.proc && !this.proc.killed) {
    try { this.proc.kill(); } catch { /* already dead */ }
  }
  this.cleanupTempFiles();
}
```

Pool exit handler:

```ts
registerExitHandlers(): void {
  process.on("exit", () => {
    for (const pooled of this.sessions.values()) {
      pooled.session.killSync();
    }
    this.sessions.clear();
  });
}
```

### Session Death Detection

Before resuming, check if the child is still alive:

```ts
// In rpc-session.ts
/** Check if the child process is still running */
isAlive(): boolean {
  return this.proc !== null && !this.proc.killed && this.exitCode === null;
}
```

In `pool.get()` — auto-remove dead sessions:

```ts
get(runId: string): PooledSession | undefined {
  const pooled = this.sessions.get(runId);
  if (!pooled) return undefined;

  // Auto-remove dead sessions
  if (!pooled.session.isAlive()) {
    this.sessions.delete(runId);
    return undefined;
  }

  return pooled;
}
```

## Implementation Plan

### Task 1: RpcSession — isAlive() + killSync()

**Files:**
- Modify: `C:\Code\DeepAgent\src\extension\rpc-session.ts`
- Modify: `C:\Code\DeepAgent\src\extension\rpc-session.test.ts` (if exists)

- [ ] **Step 1: Add isAlive() method**

```ts
// In rpc-session.ts, after getExitCode()
/** Check if the child process is still running */
isAlive(): boolean {
  return this.proc !== null && !this.proc.killed && this.exitCode === null;
}
```

- [ ] **Step 2: Add killSync() method**

```ts
// In rpc-session.ts, after isAlive()
/** Synchronous kill for process.on('exit'). No async cleanup. */
killSync(): void {
  if (this.proc && !this.proc.killed) {
    try { this.proc.kill(); } catch { /* already dead */ }
  }
  this.cleanupTempFiles();
}
```

- [ ] **Step 3: Verify**

Run: `npm run check`

### Task 2: Session Pool

**Files:**
- Create: `C:\Code\DeepAgent\src\extension\session-pool.ts`
- Create: `C:\Code\DeepAgent\src\extension\session-pool.test.ts`

- [ ] **Step 1: Create PooledSession interface and SessionPool class**

PooledSession is lean — only what's needed for V1:

```ts
// session-pool.ts
import type { RpcSession } from "./rpc-session.ts";
import type { AgentScope, RpcEvent, UsageStats } from "./types.ts";
import { getActiveRunCount } from "./run-registry.ts";

export interface PooledSession {
  runId: string;
  session: RpcSession;
  agent: string;
  agentScope: AgentScope;
  createdAt: number;
  lastActivityAt: number;
  usage: UsageStats;
}

const MAX_TOTAL_CHILDREN = 8;

const pool = new Map<string, PooledSession>();

function totalChildCount(): number {
  return pool.size + getActiveRunCount();
}

export function getPoolSize(): number {
  return pool.size;
}

export function addToPool(
  session: RpcSession,
  agent: string,
  agentScope: AgentScope,
  usage: UsageStats,
): string {
  if (totalChildCount() >= MAX_TOTAL_CHILDREN) {
    throw new Error(
      `Max concurrent child processes reached (${MAX_TOTAL_CHILDREN}). Release or abort existing runs first.`,
    );
  }
  const runId = `run_${crypto.randomUUID()}`;
  pool.set(runId, {
    runId,
    session,
    agent,
    agentScope,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    usage,
  });
  return runId;
}

export function getFromPool(runId: string): PooledSession | undefined {
  const pooled = pool.get(runId);
  if (!pooled) return undefined;
  // Auto-remove dead sessions
  if (!pooled.session.isAlive()) {
    pool.delete(runId);
    return undefined;
  }
  return pooled;
}

export function removeFromPool(runId: string): boolean {
  return pool.delete(runId);
}

export function getPoolRunIds(): string[] {
  return Array.from(pool.keys());
}

export function releaseAll(): void {
  for (const pooled of pool.values()) {
    pooled.session.killSync();
  }
  pool.clear();
}

export function registerExitHandlers(): void {
  process.on("exit", () => {
    releaseAll();
  });
}
```

- [ ] **Step 2: Update run-registry.ts to check pool size**

```ts
// run-registry.ts — add import and update registerRun
import { getPoolSize } from "./session-pool.ts";

const MAX_TOTAL_CHILDREN = 8;

function totalChildCount(): number {
  return activeRuns.size + getPoolSize();
}

export function registerRun(info: AsyncRunInfo): string {
  if (totalChildCount() >= MAX_TOTAL_CHILDREN) {
    throw new Error(
      `Max concurrent child processes reached (${MAX_TOTAL_CHILDREN}). Abort an existing run or release a session first.`,
    );
  }
  activeRuns.set(info.id, info);
  return info.id;
}
```

Remove the old `MAX_ACTIVE_RUNS = 8` constant — replaced by shared `MAX_TOTAL_CHILDREN`.

- [ ] **Step 3: Write session-pool.test.ts**

Test cases:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  addToPool, getFromPool, removeFromPool, getPoolRunIds,
  releaseAll, getPoolSize, registerExitHandlers,
} from "./session-pool.ts";
import type { RpcSession } from "./rpc-session.ts";

// Mock RpcSession
function mockSession(alive = true): RpcSession {
  return {
    isAlive: () => alive,
    killSync: vi.fn(),
    stop: vi.fn(() => Promise.resolve()),
  } as unknown as RpcSession;
}

describe("session-pool", () => {
  beforeEach(() => { releaseAll(); });

  it("add/get round-trip", () => {
    const s = mockSession();
    const id = addToPool(s, "worker", "both", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
    const pooled = getFromPool(id);
    expect(pooled).toBeDefined();
    expect(pooled!.runId).toBe(id);
    expect(pooled!.agent).toBe("worker");
  });

  it("get returns undefined for dead sessions (auto-removes)", () => {
    const s = mockSession(true);
    const id = addToPool(s, "worker", "both", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
    // Simulate death
    (s as any).isAlive = () => false;
    const pooled = getFromPool(id);
    expect(pooled).toBeUndefined();
    expect(getPoolSize()).toBe(0);
  });

  it("remove", () => {
    const s = mockSession();
    const id = addToPool(s, "worker", "both", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
    expect(removeFromPool(id)).toBe(true);
    expect(getFromPool(id)).toBeUndefined();
  });

  it("releaseAll kills all sessions", () => {
    const s1 = mockSession();
    const s2 = mockSession();
    addToPool(s1, "a", "both", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
    addToPool(s2, "b", "both", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
    releaseAll();
    expect(getPoolSize()).toBe(0);
    expect(s1.killSync).toHaveBeenCalled();
    expect(s2.killSync).toHaveBeenCalled();
  });

  it("enforces shared child process limit", () => {
    // Fill up to MAX_TOTAL_CHILDREN (8)
    for (let i = 0; i < 8; i++) {
      addToPool(mockSession(), `agent${i}`, "both", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
    }
    expect(() => addToPool(mockSession(), "overflow", "both", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 })).toThrow(/Max concurrent/);
  });

  it("getPoolRunIds returns all IDs", () => {
    const id1 = addToPool(mockSession(), "a", "both", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
    const id2 = addToPool(mockSession(), "b", "both", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
    const ids = getPoolRunIds();
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });
});
```

- [ ] **Step 4: Update run-registry.test.ts for shared limit**

Update existing tests to account for pool size being checked. Since the pool starts empty in tests, existing tests should still pass.

- [ ] **Step 5: Run tests**

Run: `npm run check`

### Task 3: action Parameter on Subagent Tool

**Files:**
- Modify: `C:\Code\DeepAgent\src\extension\tool.ts` (schema + execute handler)

- [ ] **Step 1: Add action parameter to SubagentParams**

Replace the current `SubagentParams` schema:

```ts
const ActionSchema = Type.Union([
  Type.Literal("run", { description: "Run a new subagent task (default)" }),
  Type.Literal("resume", { description: "Resume an idle session with a follow-up task" }),
  Type.Literal("release", { description: "Release (destroy) an idle session" }),
], { description: "Action to perform. Default: 'run'." });

const SubagentParams = Type.Object({
  action: Type.Optional(ActionSchema),
  runId: Type.Optional(Type.String({ description: "Session runId for resume/release actions" })),
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for run action)" })),
  task: Type.Optional(Type.String({ description: "Task description" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  agentScope: Type.Optional(AgentScopeSchema),
  keepAlive: Type.Optional(
    Type.Boolean({
      description: "Keep the child session alive after task completion for follow-up via action='resume'. Default: false.",
      default: false,
    }),
  ),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
  async: Type.Optional(Type.Boolean({ description: "Run in background. Returns run ID immediately. Only for single mode.", default: false })),
});
```

- [ ] **Step 2: Add keepAlive param to runSingleAgent signature**

Add `keepAlive: boolean = false` parameter to `runSingleAgent`:

```ts
async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  asyncMode: boolean = false,
  keepAlive: boolean = false,
): Promise<SingleResult & { runId?: string }> {
```

Return type changes to include optional `runId`.

- [ ] **Step 3: Implement keepAlive in runSingleAgent**

After the `await session.stop()` section (line ~503), replace:

```ts
// Old:
// Clean up
await session.stop();

// New:
// Clean up or keep alive
if (keepAlive && !wasAborted && currentResult.exitCode === 0) {
  // Keep session alive — add to pool
  const runId = addToPool(session, agentName, agent.agentScope ?? "both", currentResult.usage);
  return { ...currentResult, runId };
} else {
  await session.stop();
}
```

Note: `keepAlive` must also skip `session.stop()` for error cases — only keep alive on success.

- [ ] **Step 4: Wire action routing in execute handler**

In the `subagent` tool's `execute` method, add action routing before the existing logic:

```ts
async execute(_toolCallId, params, signal, onUpdate, ctx) {
  const action = params.action ?? "run";

  // ── RELEASE action ──
  if (action === "release") {
    if (!params.runId) return makeResult("runId is required for release action.", true);
    const pooled = getFromPool(params.runId);
    if (!pooled) return makeResult(`No active session with runId "${params.runId}". Available: ${getPoolRunIds().join(", ") || "none"}`, true);
    await pooled.session.stop();
    removeFromPool(params.runId);
    return makeResult(`Session ${params.runId} released.`);
  }

  // ── RESUME action ──
  if (action === "resume") {
    if (!params.runId) return makeResult("runId is required for resume action.", true);
    if (!params.task) return makeResult("task is required for resume action.", true);
    const pooled = getFromPool(params.runId);
    if (!pooled) return makeResult(`No active session with runId "${params.runId}". Available: ${getPoolRunIds().join(", ") || "none"}`, true);

    pooled.lastActivityAt = Date.now();

    // Collect resume events in a LOCAL array (don't clear pooled.events or any shared state)
    const resumeEvents: RpcEvent[] = [];

    const currentResult: SingleResult = {
      agent: pooled.agent,
      agentSource: "project", // pooled sessions are always from previous runs
      task: params.task,
      exitCode: 0,
      messages: [],
      stderr: "",
      usage: { ...pooled.usage },
      model: undefined,
    };

    const makeDetails = ...; // same as existing

    const emitUpdate = () => { ... };

    // Wire event listener into LOCAL array
    const unsubscribe = pooled.session.onEvent((event) => {
      resumeEvents.push(event);
      const partial = accumulateResultFromEvents(resumeEvents);
      currentResult.messages = partial.messages;
      currentResult.usage = partial.usage;
      currentResult.model = partial.model;
      currentResult.stopReason = partial.stopReason;
      currentResult.errorMessage = partial.errorMessage;
      emitUpdate();
    });

    // Handle UI requests (same auto-respond pattern)
    const uiUnsubscribe = pooled.session.onUIRequest(...);

    // Send follow-up
    pooled.session.followUp(`Task: ${params.task}`);

    // Wait for completion
    try {
      await pooled.session.waitForIdle(subagentConfig.idleTimeoutMs);
    } catch (err: any) {
      currentResult.exitCode = 1;
      currentResult.stderr = err.message;
    } finally {
      unsubscribe();
      uiUnsubscribe();
    }

    // Final accumulation from local events
    const final = accumulateResultFromEvents(resumeEvents);
    currentResult.messages = final.messages;
    currentResult.usage = final.usage;
    currentResult.model = final.model ?? currentResult.model;
    currentResult.stopReason = final.stopReason ?? currentResult.stopReason;
    currentResult.errorMessage = final.errorMessage ?? currentResult.errorMessage;

    // If keepAlive is still true (parent wants to keep it alive again), keep in pool
    if (params.keepAlive && currentResult.exitCode === 0) {
      pooled.lastActivityAt = Date.now();
      pooled.usage = currentResult.usage;
      return { ...currentResult, runId: pooled.runId };
    }

    // Otherwise, release the session
    await pooled.session.stop();
    removeFromPool(pooled.runId);
    return currentResult;
  }

  // ── RUN action (default) ──
  // ... existing run logic, but pass keepAlive to runSingleAgent ...
}
```

- [ ] **Step 5: Add runId to SubagentDetails**

```ts
// In types.ts
export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
  runId?: string; // present when keepAlive: true or action: "resume"
}
```

- [ ] **Step 6: Verify**

Run: `npm run check`

### Task 4: Rendering Updates

**Files:**
- Modify: `C:\Code\DeepAgent\src\extension\tool.ts` (renderCall + renderResult)

- [ ] **Step 1: Update renderResult for keepAlive sessions**

When `details.runId` is present, append to the status line:

```ts
// In renderResult, after the turns/usage line, add:
if (details.runId) {
  lines.push(`  run: ${details.runId} (idle)`);
}
```

- [ ] **Step 2: Update renderCall for action routing**

```ts
// In renderCall:
if (args.action === "resume") {
  return `subagent resume ${args.runId}\n  ${preview(args.task)}`;
}
if (args.action === "release") {
  return `subagent release ${args.runId}`;
}
// Default: existing rendering
```

- [ ] **Step 3: Verify**

Run: `npm run check`

### Task 5: /doctor Update

**Files:**
- Modify: `C:\Code\DeepAgent\src\extension\tool.ts`

- [ ] **Step 1: Add pool status to /doctor**

```ts
const activeAsyncRuns = getActiveRunCount();
const pooledSessions = getPoolRunIds();
const totalChildren = activeAsyncRuns + pooledSessions.length;

const lines = [
  "Subagent Extension",
  "extension: loaded",
  `agents: ${agentList}`,
  "transport: rpc (--mode rpc)",
  `child processes: ${totalChildren}/8 (async: ${activeAsyncRuns}, pooled: ${pooledSessions.length})`,
  `config: idleTimeoutMs=${subagentConfig.idleTimeoutMs}`,
];

if (pooledSessions.length > 0) {
  lines.push(`pooled sessions: ${pooledSessions.join(", ")}`);
}
```

- [ ] **Step 2: Verify**

Run: `npm run check`

### Task 6: Parent Prompt Update

**Files:**
- Modify: `C:\Code\DeepAgent\.pi\prompts\parent.md`
- Modify: `C:\Code\DeepAgent\.pi\skills\subagent\SKILL.md`

- [ ] **Step 1: Update parent prompt**

Add guidance:

```markdown
When a task benefits from context accumulation across multiple steps:
1. Use `subagent` with `keepAlive: true` for the first step
2. Use `subagent` with `action: "resume"` and the returned `runId` for follow-up steps
3. Use `subagent` with `action: "release"` and the `runId` when done to free resources

For simple one-off tasks, omit `keepAlive` (default behavior: session destroyed after completion).

When resuming, you can pass `keepAlive: true` again to keep the session alive for further follow-ups.
```

- [ ] **Step 2: Update skill**

Add resume/release workflow to the subagent skill.

### Task 7: Verification

- [ ] **Step 1: Unit tests**

```powershell
npm run check
```

Expected: all tests pass, 0 tsc errors.

- [ ] **Step 2: Foreground single with keepAlive**

```text
Use subagent with agent "worker", agentScope "both", keepAlive true, to inspect the project entrypoints.
```

Expected:
- result contains `runId`
- `/doctor` shows pooled session

- [ ] **Step 3: Resume follow-up**

```text
Use subagent with action "resume", runId "<returned-id>", task "based on the inspection, list all exported functions".
```

Expected:
- child uses prior context, does not re-investigate
- result reflects accumulated understanding

- [ ] **Step 4: Release**

```text
Use subagent with action "release", runId "<returned-id>".
```

Expected:
- session destroyed
- `/doctor` shows 0 pooled sessions
- subsequent `resume` with same runId returns error

## Completion Criteria

- `subagent` with `keepAlive: true` returns `runId` and keeps session alive
- `subagent` with `action: "resume"` sends follow-up task to idle session
- `subagent` with `action: "release"` destroys idle session
- Pool and registry share total child process limit of 8
- `RpcSession.isAlive()` detects dead child processes
- `RpcSession.killSync()` used in exit handler (sync)
- Resume events collected in local array, not by clearing pooled state
- Parent exit cleans up all sessions via sync `killSync()`
- `/doctor` reports child process count with breakdown
- `npm run check` passes
- Real Pi smoke confirms keepAlive → resume → release lifecycle
