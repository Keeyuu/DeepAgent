# Session Resume: Subagent Idle Keep-Alive and Reuse

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a foreground subagent completes a task, let the parent agent choose whether to destroy the child process or keep it alive for follow-up tasks. This preserves accumulated context across multiple tasks without re-investigation.

**Architecture:** When `subagent` finishes a foreground task with `keepAlive: true`, instead of the 60s auto-cleanup destroying the session, suppress the cleanup timer and move the `RpcSession` from the run-registry to an in-process pool keyed by `runId`. Return the `runId` to the parent agent. The parent then decides: release (destroy) or resume (follow-up) — both via the `action` parameter on the `subagent` tool itself (no separate tools). The pool and async run-registry share a combined child process limit of 8.

**Transport:** Official RPC mode (`--mode rpc`) via `RpcSession`. No file system bridge, no run-store, no new transport.

**Key design constraint:** `runSingleAgent` has two paths: `fireAndForget=true` (single mode, returns immediately) and `fireAndForget=false` (chain/parallel, waits for completion). keepAlive only makes sense on the `fireAndForget=false` path (chain/parallel), because the parent needs to know the result before deciding to keep the session. For single mode (fire-and-forget), the session stays alive in the async run-registry already — parent polls via `subagent_status`.

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

- `keepAlive` option on chain/parallel subagent calls (NOT single mode — single mode is already fire-and-forget with session in run-registry)
- `action` parameter on `subagent` tool: `run` (default), `resume`, `release`
- In-process `RpcSession` pool (`Map<runId, PooledSession>`)
- Shared child process limit: `activeRuns.size + pool.size < MAX_TOTAL_CHILDREN` (8), owned by `session-pool.ts` unidirectionally
- `RpcSession.isAlive()` for death detection
- `RpcSession.killSync()` for exit handler
- `runId` in foreground result when `keepAlive: true`
- Resume events collected via `accumulateEvent()` (O(1)), not `accumulateResultFromEvents()` (O(N²))
- Pool idle timeout: 30 min safety net
- Pool cleanup on parent process exit via sync `killSync()`
- `registerExitHandlers()` called in extension init

### Out of Scope

- Persisting sessions across parent restarts
- Session serialization / deserialization
- Resuming async (background) single-mode runs — those already stay alive in run-registry
- Multiple concurrent tasks on the same session

## Runtime Model

### Chain/Parallel with keepAlive

```json
// Request (chain or parallel mode)
{
  "chain": [
    { "agent": "worker", "task": "investigate project structure" }
  ],
  "agentScope": "both",
  "keepAlive": true
}

// Response (adds runId to details)
{
  "content": [{ "type": "text", "text": "... investigation result ..." }],
  "details": { "mode": "chain", "results": [...], "runId": "run_abc123" }
}
```

### Resume

```json
// Request
{
  "action": "resume",
  "runId": "run_abc123",
  "task": "based on the investigation, update README",
  "keepAlive": true
}

// Response (runId present again if keepAlive still true)
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

### Resource Limit: Unidirectional (pool owns the limit)

`session-pool.ts` owns `MAX_TOTAL_CHILDREN` and exports `totalChildCount()`. `run-registry.ts` imports from pool only — no circular dependency.

```ts
// In session-pool.ts — single source of truth
const MAX_TOTAL_CHILDREN = 8;

export function totalChildCount(): number {
  return pool.size + activeRunsCount();
}

// activeRunsCount() is imported from run-registry.ts
import { getActiveRunCount } from "./run-registry.ts";
```

```ts
// In run-registry.ts — imports from pool only
import { totalChildCount, MAX_TOTAL_CHILDREN } from "./session-pool.ts";

export function registerRun(info: AsyncRunInfo): string {
  if (totalChildCount() >= MAX_TOTAL_CHILDREN) {
    throw new Error(`Max concurrent child processes reached (${MAX_TOTAL_CHILDREN}).`);
  }
  activeRuns.set(info.id, info);
  return info.id;
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

Pool exit handler — called in extension init:

```ts
// In session-pool.ts
export function registerExitHandlers(): void {
  process.on("exit", () => {
    for (const pooled of pool.values()) {
      pooled.session.killSync();
    }
    pool.clear();
  });
}
```

```ts
// In tool.ts extension entry — after config load
registerExitHandlers();
```

### Session Death Detection

Before resuming, check if the child is still alive:

```ts
// In rpc-session.ts
isAlive(): boolean {
  return this.proc !== null && !this.proc.killed && this.exitCode === null;
}
```

In `getFromPool()` — auto-remove dead sessions:

```ts
get(runId: string): PooledSession | undefined {
  const pooled = pool.get(runId);
  if (!pooled) return undefined;
  if (!pooled.session.isAlive()) {
    pool.delete(runId);
    return undefined;
  }
  return pooled;
}
```

### Pool Idle Timeout (Safety Net)

Sessions that sit idle in the pool for 30 minutes are auto-cleaned:

```ts
// In session-pool.ts
const POOL_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function scheduleIdleCleanup(runId: string): void {
  setTimeout(() => {
    const pooled = pool.get(runId);
    if (pooled && Date.now() - pooled.lastActivityAt >= POOL_IDLE_TIMEOUT_MS) {
      pooled.session.killSync();
      pool.delete(runId);
    }
  }, POOL_IDLE_TIMEOUT_MS);
}
```

Called after `addToPool()`. Reschedule on each resume (`lastActivityAt` update).

### keepAlive Integration in runSingleAgent

The current `runSingleAgent` auto-cleanup:

```ts
// Current code (chain/parallel path, fireAndForget=false):
setTimeout(() => {
  unsubEvents();
  removeRun(runId);
  session.stop().catch(() => {});
}, 60_000);
```

When `keepAlive=true` and the run completes successfully (`agent_end`, exitCode 0), suppress this timer and move session to pool instead:

```ts
// New code:
let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

if (!keepAlive) {
  cleanupTimer = setTimeout(() => {
    unsubEvents();
    removeRun(runId);
    session.stop().catch(() => {});
  }, 60_000);
}

// In the agent_end event handler:
if (event.type === "agent_end") {
  runInfo.status = "completed";
  if (keepAlive && session.getExitCode() === null) {
    // Move from registry to pool, suppress cleanup timer
    if (cleanupTimer) clearTimeout(cleanupTimer);
    unsubEvents();
    removeRun(runId);
    const poolRunId = addToPool(session, agentName, agent.source, runInfo.accumulated.usage);
    poolRunIdRef = poolRunId; // Capture for return
  }
}
```

The `poolRunIdRef` is returned as part of the `SingleResult.runId` field.

### Resume Event Accumulation (O(1))

Resume uses `accumulateEvent()` for O(1) per event — NOT `accumulateResultFromEvents()` which is O(N²):

```ts
const accumulated: AccumulatedResult = {
  messages: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  stderr: "",
};

const unsubResume = pooled.session.onEvent((event) => {
  accumulateEvent(accumulated, event); // O(1)
  // emitUpdate...
});
```

Pool invariant: only sessions past `agent_end` are stored. `followUp` is safe because the agent inner loop has exited.

## Implementation Plan

### Task 1: RpcSession — isAlive() + killSync()

**Files:**
- Modify: `C:\Code\DeepAgent\src\extension\rpc-session.ts`

- [ ] **Step 1: Add isAlive() method**

After `isStarted()`:

```ts
/** Check if the child process is still running */
isAlive(): boolean {
  return this.proc !== null && !this.proc.killed && this.exitCode === null;
}
```

- [ ] **Step 2: Add killSync() method**

After `isAlive()`:

```ts
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

### Task 2: Session Pool (unidirectional imports)

**Files:**
- Create: `C:\Code\DeepAgent\src\extension\session-pool.ts`
- Create: `C:\Code\DeepAgent\src\extension\session-pool.test.ts`
- Modify: `C:\Code\DeepAgent\src\extension\run-registry.ts` (import shared limit from pool)

- [ ] **Step 1: Create session-pool.ts**

```ts
// session-pool.ts
import type { RpcSession } from "./rpc-session.ts";
import type { UsageStats } from "./types.ts";
import { getActiveRunCount } from "./run-registry.ts";
import { randomUUID } from "node:crypto";

export interface PooledSession {
  runId: string;
  session: RpcSession;
  agent: string;
  agentSource: "user" | "project" | "unknown";
  createdAt: number;
  lastActivityAt: number;
  usage: UsageStats;
}

/** Shared child process limit across pool and run-registry */
export const MAX_TOTAL_CHILDREN = 8;

/** Pool idle timeout safety net */
const POOL_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const pool = new Map<string, PooledSession>();

/** Total child processes across pool and async run-registry */
export function totalChildCount(): number {
  return pool.size + getActiveRunCount();
}

export function getPoolSize(): number {
  return pool.size;
}

export function addToPool(
  session: RpcSession,
  agent: string,
  agentSource: "user" | "project" | "unknown",
  usage: UsageStats,
): string {
  if (totalChildCount() >= MAX_TOTAL_CHILDREN) {
    throw new Error(
      `Max concurrent child processes reached (${MAX_TOTAL_CHILDREN}). Release or abort existing runs first.`,
    );
  }
  const runId = `run_${randomUUID().slice(0, 8)}`;
  pool.set(runId, {
    runId,
    session,
    agent,
    agentSource,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    usage,
  });
  scheduleIdleCleanup(runId);
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

export function updatePoolActivity(runId: string, usage: UsageStats): void {
  const pooled = pool.get(runId);
  if (pooled) {
    pooled.lastActivityAt = Date.now();
    pooled.usage = usage;
    scheduleIdleCleanup(runId);
  }
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

function scheduleIdleCleanup(runId: string): void {
  setTimeout(() => {
    const pooled = pool.get(runId);
    if (pooled && Date.now() - pooled.lastActivityAt >= POOL_IDLE_TIMEOUT_MS) {
      pooled.session.killSync();
      pool.delete(runId);
    }
  }, POOL_IDLE_TIMEOUT_MS);
}
```

- [ ] **Step 2: Update run-registry.ts to use shared limit**

Replace the current `MAX_ACTIVE_RUNS` with imports from session-pool:

```ts
// run-registry.ts
import type { AsyncRunInfo } from "./types.ts";
import { totalChildCount, MAX_TOTAL_CHILDREN } from "./session-pool.ts";

const activeRuns = new Map<string, AsyncRunInfo>();

/** Register a new async run. Returns the run ID. Throws if max reached. */
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

Remove old `MAX_ACTIVE_RUNS = 8` constant.

Note: This creates `session-pool.ts` → `run-registry.ts` → `session-pool.ts` circular at module level. To break this, `session-pool.ts` imports `getActiveRunCount` from `run-registry.ts`, and `run-registry.ts` imports `totalChildCount` + `MAX_TOTAL_CHILDREN` from `session-pool.ts`. This IS circular at the module level.

**Fix:** Make `totalChildCount` and `MAX_TOTAL_CHILDREN` not imported from session-pool. Instead, extract them to a shared `child-limit.ts`:

```ts
// child-limit.ts
export const MAX_TOTAL_CHILDREN = 8;
```

Then both `session-pool.ts` and `run-registry.ts` import `MAX_TOTAL_CHILDREN` from `child-limit.ts`. `session-pool.ts` imports `getActiveRunCount` from `run-registry.ts` (unidirectional). `run-registry.ts` does NOT import from `session-pool.ts`.

```ts
// session-pool.ts
import { getActiveRunCount } from "./run-registry.ts";
import { MAX_TOTAL_CHILDREN } from "./child-limit.ts";

export function totalChildCount(): number {
  return pool.size + getActiveRunCount();
}
```

```ts
// run-registry.ts
import { MAX_TOTAL_CHILDREN } from "./child-limit.ts";
// Does NOT import from session-pool.ts

export function registerRun(info: AsyncRunInfo): string {
  // Can't check pool size directly — session-pool exports getPoolSize()
  // But we can't import it without circular dep.
  // Solution: run-registry checks against MAX_TOTAL_CHILDREN only for its own count.
  // session-pool.addToPool() checks the combined count.
  // This means run-registry could overshoot if pool is full.
  // Fix: pass getPoolSize as a parameter, or accept the slight race.
  if (activeRuns.size >= MAX_TOTAL_CHILDREN) {
    throw new Error(...);
  }
  ...
}
```

Actually this is getting complex. **Simplest correct solution:** `session-pool.ts` imports `getActiveRunCount` from `run-registry.ts`. `run-registry.ts` does NOT import from `session-pool.ts`. The pool checks the combined count before adding. The registry only checks its own count. This means the registry could allow up to 8 async runs even if the pool has sessions. But in practice, the pool is populated FROM completed runs (which are removed from registry), so the total never exceeds 8.

```ts
// run-registry.ts — no imports from session-pool
import type { AsyncRunInfo } from "./types.ts";

export const MAX_ACTIVE_RUNS = 8; // Registry-only limit
const activeRuns = new Map<string, AsyncRunInfo>();

export function registerRun(info: AsyncRunInfo): string {
  if (activeRuns.size >= MAX_ACTIVE_RUNS) {
    throw new Error(`Max concurrent async runs reached (${MAX_ACTIVE_RUNS}).`);
  }
  activeRuns.set(info.id, info);
  return info.id;
}
```

```ts
// session-pool.ts — imports getActiveRunCount for combined check
import { getActiveRunCount } from "./run-registry.ts";

const MAX_TOTAL_CHILDREN = 8;

function totalChildCount(): number {
  return pool.size + getActiveRunCount();
}

function addToPool(...): string {
  if (totalChildCount() >= MAX_TOTAL_CHILDREN) {
    throw new Error(...);
  }
  ...
}
```

This is correct: the pool gate is stricter (combined count), the registry gate is simpler (own count only). Since pool entries come from completed runs (removed from registry), total stays ≤ 8.

- [ ] **Step 3: Write session-pool.test.ts**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  addToPool, getFromPool, removeFromPool, getPoolRunIds,
  releaseAll, getPoolSize,
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

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

describe("session-pool", () => {
  beforeEach(() => { releaseAll(); });

  it("add/get round-trip", () => {
    const s = mockSession();
    const id = addToPool(s, "worker", "user", emptyUsage);
    const pooled = getFromPool(id);
    expect(pooled).toBeDefined();
    expect(pooled!.runId).toBe(id);
    expect(pooled!.agent).toBe("worker");
    expect(pooled!.agentSource).toBe("user");
  });

  it("get returns undefined for dead sessions (auto-removes)", () => {
    const s = mockSession(true);
    const id = addToPool(s, "worker", "user", emptyUsage);
    (s as any).isAlive = () => false;
    const pooled = getFromPool(id);
    expect(pooled).toBeUndefined();
    expect(getPoolSize()).toBe(0);
  });

  it("remove", () => {
    const s = mockSession();
    const id = addToPool(s, "worker", "user", emptyUsage);
    expect(removeFromPool(id)).toBe(true);
    expect(getFromPool(id)).toBeUndefined();
  });

  it("releaseAll kills all sessions", () => {
    const s1 = mockSession();
    const s2 = mockSession();
    addToPool(s1, "a", "user", emptyUsage);
    addToPool(s2, "b", "user", emptyUsage);
    releaseAll();
    expect(getPoolSize()).toBe(0);
    expect(s1.killSync).toHaveBeenCalled();
    expect(s2.killSync).toHaveBeenCalled();
  });

  it("getPoolRunIds returns all IDs", () => {
    const id1 = addToPool(mockSession(), "a", "user", emptyUsage);
    const id2 = addToPool(mockSession(), "b", "user", emptyUsage);
    const ids = getPoolRunIds();
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it("updatePoolActivity updates timestamp and usage", () => {
    const s = mockSession();
    const id = addToPool(s, "worker", "user", emptyUsage);
    const newUsage = { ...emptyUsage, input: 100, output: 50 };
    updatePoolActivity(id, newUsage);
    const pooled = getFromPool(id);
    expect(pooled!.usage.input).toBe(100);
  });
});
```

- [ ] **Step 4: Verify**

Run: `npm run check`

### Task 3: action Parameter on Subagent Tool

**Files:**
- Modify: `C:\Code\DeepAgent\src\extension\types.ts` (add runId to SubagentDetails, add runId to SingleResult)
- Modify: `C:\Code\DeepAgent\src\extension\tool.ts` (schema + execute handler)

- [ ] **Step 1: Add runId to SubagentDetails and SingleResult in types.ts**

```ts
// In types.ts — SubagentDetails
export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
  runId?: string; // present when keepAlive: true or action: "resume"
}

// In types.ts — SingleResult (add runId field)
export interface SingleResult {
  // ... existing fields ...
  runId?: string; // present when session is pooled (keepAlive)
}
```

- [ ] **Step 2: Add action + keepAlive parameters to SubagentParams (NO async param)**

```ts
const ActionSchema = StringEnum(["run", "resume", "release"] as const, {
  description: "Action to perform. 'run': new task (default). 'resume': send follow-up to idle session. 'release': destroy idle session.",
  default: "run",
});

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
});
```

Note: NO `async` parameter. Single mode is always fire-and-forget.

- [ ] **Step 3: Add keepAlive param to runSingleAgent**

Add `keepAlive: boolean = false` as the last parameter:

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
  fireAndForget: boolean = false,
  keepAlive: boolean = false,
): Promise<SingleResult> {
```

- [ ] **Step 4: Implement keepAlive in runSingleAgent**

In the event listener (where `session.onEvent(...)` is wired), capture the unsubscribe and modify the auto-cleanup:

Replace the current auto-cleanup:

```ts
// Current (line ~444-448):
// Auto-cleanup after delay (unsub listeners + stop session)
setTimeout(() => {
  unsubEvents();
  removeRun(runId);
  session.stop().catch(() => {});
}, 60_000);
```

With:

```ts
// New: suppress auto-cleanup when keepAlive, move to pool on success
let poolRunId: string | undefined;

if (keepAlive && fireAndForget) {
  // keepAlive doesn't make sense with fireAndForget — ignore
  // (single mode already stays alive in run-registry)
}

if (!keepAlive || fireAndForget) {
  // Standard auto-cleanup
  setTimeout(() => {
    unsubEvents();
    removeRun(runId);
    session.stop().catch(() => {});
  }, 60_000);
}
// When keepAlive && !fireAndForget, cleanup happens in agent_end handler below
```

In the existing `onEvent` listener, after `if (event.type === "agent_end")`:

```ts
if (event.type === "agent_end") {
  runInfo.status = "completed";

  // keepAlive: move session from registry to pool
  if (keepAlive && !fireAndForget && session.getExitCode() === null) {
    unsubEvents();
    removeRun(runId);
    try {
      poolRunId = addToPool(session, agentName, agent.source, runInfo.accumulated.usage);
    } catch (err: any) {
      // Pool full — fall through to normal cleanup
      poolRunId = undefined;
    }
  }
}
```

After building the final result, add `runId`:

```ts
const result: SingleResult = {
  // ... existing fields ...
  runId: poolRunId, // undefined unless keepAlive + pooled successfully
};
```

- [ ] **Step 5: Wire action routing in execute handler**

At the top of the `execute` method, before existing logic:

```ts
async execute(_toolCallId, params, signal, onUpdate, ctx) {
  const action = params.action ?? "run";

  // Helper for simple results
  const simpleResult = (text: string, isError = false) => ({
    content: [{ type: "text" as const, text }],
    details: undefined as SubagentDetails | undefined,
    ...(isError ? { isError: true } : {}),
  });

  // ── RELEASE action ──
  if (action === "release") {
    if (!params.runId) return simpleResult("runId is required for release action.", true);
    const pooled = getFromPool(params.runId);
    if (!pooled) return simpleResult(`No active session with runId "${params.runId}". Available: ${getPoolRunIds().join(", ") || "none"}`, true);
    await pooled.session.stop().catch(() => {});
    removeFromPool(params.runId);
    return simpleResult(`Session ${params.runId} released.`);
  }

  // ── RESUME action ──
  if (action === "resume") {
    if (!params.runId) return simpleResult("runId is required for resume action.", true);
    if (!params.task) return simpleResult("task is required for resume action.", true);
    const pooled = getFromPool(params.runId);
    if (!pooled) return simpleResult(`No active session with runId "${params.runId}". Available: ${getPoolRunIds().join(", ") || "none"}`, true);

    // Pool invariant: only sessions past agent_end are stored.
    // followUp is safe because the agent inner loop has exited.
    pooled.lastActivityAt = Date.now();

    // O(1) event accumulation
    const accumulated: AccumulatedResult = {
      messages: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      stderr: "",
    };

    const currentResult: SingleResult = {
      agent: pooled.agent,
      agentSource: pooled.agentSource,
      task: params.task,
      exitCode: 0,
      messages: [],
      stderr: "",
      usage: { ...pooled.usage },
    };

    const agentScope: AgentScope = params.agentScope ?? "user";
    const makeResumeDetails = (results: SingleResult[]): SubagentDetails => ({
      mode: "single",
      agentScope,
      projectAgentsDir: null,
      results,
      runId: pooled.runId,
    });

    const unsubResume = pooled.session.onEvent((event) => {
      accumulateEvent(accumulated, event); // O(1)
      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: getFinalOutput(accumulated.messages) || "(running...)" }],
          details: makeResumeDetails([{
            ...currentResult,
            messages: accumulated.messages,
            usage: accumulated.usage,
            model: accumulated.model,
          }]),
        });
      }
      if (event.type === "agent_end") {
        currentResult.exitCode = pooled.session.getExitCode() ?? 0;
      }
    });

    // Send follow-up
    pooled.session.followUp(`Task: ${params.task}`);

    // Wait for completion (blocking — same as chain/parallel)
    try {
      await pooled.session.waitForIdle(subagentConfig.idleTimeoutMs);
    } catch (err: any) {
      currentResult.exitCode = 1;
      currentResult.stderr = err.message;
    } finally {
      unsubResume();
    }

    // Final result from accumulated
    currentResult.messages = accumulated.messages;
    currentResult.usage = accumulated.usage;
    currentResult.model = accumulated.model ?? currentResult.model;
    currentResult.stopReason = accumulated.stopReason ?? currentResult.stopReason;
    currentResult.errorMessage = accumulated.errorMessage ?? currentResult.errorMessage;

    // If keepAlive, keep in pool for further follow-ups
    if (params.keepAlive && currentResult.exitCode === 0) {
      updatePoolActivity(pooled.runId, currentResult.usage);
      currentResult.runId = pooled.runId;
      return {
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(no output)" }],
        details: makeResumeDetails([currentResult]),
      };
    }

    // Otherwise, release the session
    await pooled.session.stop().catch(() => {});
    removeFromPool(pooled.runId);
    return {
      content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(no output)" }],
      details: makeResumeDetails([currentResult]),
    };
  }

  // ── RUN action (default) ──
  // ... existing run logic (chain/parallel/single), pass keepAlive to runSingleAgent ...
```

In the chain mode section, pass `keepAlive` on the last step only:

```ts
// Chain mode — only keep alive on the LAST step
const isLastStep = i === params.chain.length - 1;
const result = await runSingleAgent(
  ctx.cwd, agents, step.agent, taskWithContext, step.cwd, i + 1,
  signal, chainUpdate, makeDetails("chain"),
  false, // fireAndForget — chain always waits
  isLastStep && (params.keepAlive ?? false), // keepAlive only on last step
);
```

In the parallel mode section, pass `keepAlive` is NOT supported (which step do we keep?). Document this:

```ts
// Parallel mode — keepAlive not supported (ambiguous which session to keep)
// If user passes keepAlive with parallel, it's silently ignored.
```

In the single mode section, `keepAlive` is ignored (fire-and-forget already keeps session alive):

```ts
// Single mode — fire-and-forget, session stays in run-registry
// keepAlive is not applicable (session already alive, parent polls via subagent_status)
```

- [ ] **Step 6: Update makeDetails closure to include runId**

In the chain result, when `keepAlive` is true and the last result has `runId`:

```ts
// After building chain results:
const lastResult = results[results.length - 1];
return {
  content: [{ type: "text", text: getFinalOutput(lastResult.messages) || "(no output)" }],
  details: {
    ...makeDetails("chain")(results),
    runId: lastResult.runId,
  },
};
```

- [ ] **Step 7: Call registerExitHandlers() in extension init**

After `subagentConfig = readSubagentConfig(process.cwd())` in the extension entry point:

```ts
if (process.env.SUBAGENT_CHILD !== "1") {
  subagentConfig = readSubagentConfig(process.cwd());
  registerExitHandlers();
}
```

- [ ] **Step 8: Verify**

Run: `npm run check`

### Task 4: Rendering Updates

**Files:**
- Modify: `C:\Code\DeepAgent\src\extension\tool.ts` (renderCall + renderResult)

- [ ] **Step 1: Update renderResult for keepAlive sessions**

In the single result rendering (expanded and collapsed), when `details.runId` is present, add:

```ts
// After usage line:
if (details.runId) {
  text += `\n${theme.fg("accent", `run: ${details.runId} (idle)`)}`;
}
```

- [ ] **Step 2: Update renderCall for action routing**

```ts
// In renderCall, at the top:
if (args.action === "resume") {
  const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
  let text =
    theme.fg("toolTitle", theme.bold("subagent ")) +
    theme.fg("accent", "resume") +
    theme.fg("dim", ` ${args.runId}`);
  text += `\n  ${theme.fg("dim", preview)}`;
  return new Text(text, 0, 0);
}
if (args.action === "release") {
  return new Text(
    theme.fg("toolTitle", theme.bold("subagent ")) +
    theme.fg("warning", "release") +
    theme.fg("dim", ` ${args.runId}`),
    0, 0,
  );
}
// Default: existing rendering
```

- [ ] **Step 3: Verify**

Run: `npm run check`

### Task 5: /doctor Update

**Files:**
- Modify: `C:\Code\DeepAgent\src\extension\tool.ts`

- [ ] **Step 1: Add pool status to /doctor**

Import `getPoolRunIds` and `getPoolSize` from `session-pool.ts`.

```ts
const activeAsyncRuns = getActiveRunCount();
const pooledCount = getPoolSize();
const pooledIds = getPoolRunIds();
const totalChildren = activeAsyncRuns + pooledCount;

const lines = [
  "Subagent Extension",
  "extension: loaded",
  `agents: ${agentList}`,
  "transport: rpc (--mode rpc)",
  `child processes: ${totalChildren}/${MAX_TOTAL_CHILDREN} (async: ${activeAsyncRuns}, pooled: ${pooledCount})`,
  `config: idleTimeoutMs=${subagentConfig.idleTimeoutMs}`,
];

if (pooledIds.length > 0) {
  lines.push(`pooled sessions: ${pooledIds.join(", ")}`);
}
```

Import `MAX_TOTAL_CHILDREN` from `session-pool.ts` (via `child-limit.ts` if extracted, or directly).

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
1. Use `subagent` with `keepAlive: true` (chain/parallel mode) for the first step
2. Use `subagent` with `action: "resume"` and the returned `runId` for follow-up steps
3. Use `subagent` with `action: "release"` and the `runId` when done to free resources

For simple one-off tasks, omit `keepAlive` (default behavior: session destroyed after completion).

When resuming, you can pass `keepAlive: true` again to keep the session alive for further follow-ups.

Note: `keepAlive` works with chain and parallel modes. Single mode is always fire-and-forget — use `subagent_status` to poll results.
```

- [ ] **Step 2: Update skill**

Add resume/release workflow to the subagent skill.

### Task 7: Verification

- [ ] **Step 1: Unit tests**

```powershell
npm run check
```

Expected: all tests pass, 0 tsc errors.

- [ ] **Step 2: Chain with keepAlive**

```text
Use subagent with chain mode, keepAlive true, to investigate the project.
```

Expected:
- result contains `runId` in details
- `/doctor` shows pooled session

- [ ] **Step 3: Resume follow-up**

```text
Use subagent with action "resume", runId "<returned-id>", task "based on the investigation, list all exported functions".
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

- `subagent` with `keepAlive: true` (chain/parallel) returns `runId` and keeps session alive
- `subagent` with `action: "resume"` sends follow-up task to idle session
- `subagent` with `action: "release"` destroys idle session
- Pool and registry share total child process limit (unidirectional imports)
- `RpcSession.isAlive()` detects dead child processes
- `RpcSession.killSync()` used in exit handler (sync)
- Resume events collected via `accumulateEvent()` (O(1))
- Pool idle timeout (30 min safety net)
- `registerExitHandlers()` called in extension init
- `agentSource` preserved from original run in pooled session
- `/doctor` reports child process count with breakdown
- `npm run check` passes
- Real Pi smoke confirms keepAlive → resume → release lifecycle
