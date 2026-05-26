# Session Resume: Subagent Idle Keep-Alive and Reuse

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a foreground subagent completes a task, let the parent agent choose whether to destroy the child process or keep it alive for follow-up tasks. This preserves accumulated context (read files, explored code, built understanding) across multiple tasks without re-investigation.

**Architecture:** When `subagent` finishes a foreground task, instead of immediately calling `session.stop()`, store the `RpcSession` in an in-process pool keyed by `runId`. Return the `runId` to the parent agent. The parent then decides: release (destroy) or resume (follow-up with new task in the same session).

**Precedent:** The official Pi RPC mode (`--mode rpc`) is inherently long-lived — `rpc-mode.ts` ends with `return new Promise(() => {})` to keep the process alive indefinitely. The official `RpcClient` exposes `followUp()` for exactly this purpose: sending a new prompt to an idle session while preserving all prior context. This plan simply exposes that capability at the tool level.

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
  → child 返回结果 + runId: "abc123"
  → child 进程保持 idle，上下文完整保留

parent → subagent_resume({ runId: "abc123", task: "基于刚才的调研改 README" })
  → 同一个 child，上下文接力
  → child 直接改 README，不需要重新调研

parent → subagent_release({ runId: "abc123" })
  → child 进程销毁
```

## Scope

### In Scope

- `keepAlive` option on `subagent` foreground calls
- In-process `RpcSession` pool (`Map<runId, RpcSession>`)
- `subagent_resume` tool — send follow-up task to idle session
- `subagent_release` tool — destroy idle session
- `runId` in foreground result when `keepAlive: true`
- Idle sessions exempt from `waitForIdle` timeout (normally 5 min) — kept alive indefinitely
- Pool cleanup on parent process exit (all child sessions auto-destroyed)

### Out of Scope

- Auto-release timeout based on idle duration (sessions stay idle indefinitely)
- Heartbeat health-check for dead child processes (YAGNI for now, add later if needed)
- Persisting sessions across parent restarts (sessions die with parent process)
- Session serialization / deserialization
- Resuming async (background) sessions — those already stay alive
- Multiple concurrent tasks on the same session (one at a time)
- Session migration between parent processes
- Session state persistence to disk

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

After this, the `RpcSession` sits idle in the pool. The parent agent sees `runId` in the result.

### Resume

```json
// Request
{
  "runId": "run_abc123",
  "task": "based on the investigation, update README"
}

// Response
{
  "content": [{ "type": "text", "text": "... updated README ..." }],
  "details": { "mode": "single", "results": [...], "runId": "run_abc123" }
}
```

The child receives a `follow_up` command. All prior messages are preserved.

### Release

```json
// Request
{
  "runId": "run_abc123"
}

// Response
{
  "content": [{ "type": "text", "text": "Session run_abc123 released." }],
  "details": undefined
}
```

The `RpcSession` is stopped and removed from the pool.

### Idle Timeout Exemption

`runSingleAgent` uses `session.waitForIdle(300_000)` (5-minute timeout) to wait for task completion. This is correct for foreground tasks — we need a timeout to detect hung agents.

However, when `keepAlive: true` and the task has completed (first `agent_end` received), the session should **not** be subject to any timeout. It stays idle indefinitely until the parent sends `followUp` or `release`.

Implementation: after the first `waitForIdle` succeeds and the result is captured, the session is moved to the pool. No further `waitForIdle` is called. The child process just sits there, listening on stdin, until the parent sends the next command.

### Parent Exit Cleanup

When the parent Pi process exits (normal exit, crash, or SIGTERM), all pooled sessions are automatically stopped. This is implemented via `process.on('exit')` and `process.on('SIGTERM')` hooks in the SessionPool.

### Parent Can Release Anytime

A parent being alive does not mean children must stay alive. The parent can call `subagent_release` at any time to destroy a specific session. This is the normal cleanup path — the parent decides when a session's context is no longer needed.

## Implementation Plan

### Task 1: Session Pool

**Files:**

- Modify: `C:\Code\DeepAgent\src\extension\tool.ts`
- Add: `C:\Code\DeepAgent\src\extension\session-pool.ts`
- Add: `C:\Code\DeepAgent\src\extension\session-pool.test.ts`

- [ ] **Step 1: Create SessionPool class**

```ts
interface PooledSession {
  runId: string;
  session: RpcSession;
  agent: string;
  agentScope: AgentScope;
  lastActivity: number;
  events: RpcEvent[];
}

class SessionPool {
  private sessions = new Map<string, PooledSession>();

  add(session: RpcSession, agent: string, agentScope: AgentScope, events: RpcEvent[]): string;
  get(runId: string): PooledSession | undefined;
  remove(runId: string): boolean;
  has(runId: string): boolean;
  getActiveRunIds(): string[];
  releaseAll(): Promise<void>;
  // Called on parent process exit — kills all child sessions
  registerExitHandlers(): void;
}
```

- [ ] **Step 2: Generate unique runId**

Use `crypto.randomUUID()` with a `run_` prefix for clarity.

- [ ] **Step 3: Idle timeout exemption**

When `keepAlive: true`, after `waitForIdle` succeeds (task completed), move the session to the pool **without** calling `session.stop()`. The child process stays alive, listening on stdin. No further timeout applies.

For `subagent_resume`, the `waitForIdle` timeout applies during task execution (detect hung agents), but after completion the session returns to idle-in-pool state.

- [ ] **Step 4: Parent exit cleanup**

Register `process.on('exit')` and `process.on('SIGTERM')` hooks to call `releaseAll()`. This ensures child processes don't outlive the parent.

The parent can also call `subagent_release` at any time for individual cleanup — alive means "can be alive", not "must be alive".

- [ ] **Step 4: Test pool lifecycle**

Test cases:

- add / get / remove round-trip
- releaseAll cleans up
- duplicate runId rejected
- getActiveRunIds returns correct list
- keepAlive session not affected by waitForIdle timeout after task completion
- process exit hooks registered

Run:

```powershell
npm run test -- src/extension/session-pool.test.ts
```

### Task 2: keepAlive Option on Subagent Tool

**Files:**

- Modify: `C:\Code\DeepAgent\src\extension\tool.ts`
- Modify: `C:\Code\DeepAgent\src\extension\types.ts`

- [ ] **Step 1: Add keepAlive to SubagentParams**

```ts
const SubagentParams = Type.Object({
  // ... existing fields ...
  keepAlive: Type.Optional(
    Type.Boolean({
      description: "Keep the child session alive after task completion for follow-up via subagent_resume. Default: false.",
      default: false,
    }),
  ),
});
```

- [ ] **Step 2: Modify runSingleAgent to optionally keep session**

When `keepAlive` is true:

1. After `waitForIdle()`, do NOT call `session.stop()`
2. Add session to pool: `pool.add(session, agentName, agentScope, events)`
3. Include `runId` in the returned `SingleResult`

Add `runId?: string` to `SingleResult` and `SubagentDetails`.

- [ ] **Step 3: Update makeDetails to include runId**

```ts
interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
  runId?: string; // present when keepAlive: true
}
```

- [ ] **Step 4: Release session on error**

If `runSingleAgent` throws or returns an error result, always call `session.stop()` regardless of `keepAlive`. Only keep alive on success.

### Task 3: subagent_resume Tool

**Files:**

- Modify: `C:\Code\DeepAgent\src\extension\tool.ts`

- [ ] **Step 1: Register subagent_resume tool**

```ts
pi.registerTool({
  name: "subagent_resume",
  label: "Resume Subagent",
  description: "Send a follow-up task to an idle subagent session, preserving all prior context.",
  parameters: Type.Object({
    runId: Type.String({ description: "The runId returned by a previous subagent call with keepAlive: true." }),
    task: Type.String({ minLength: 1, description: "The follow-up task to send to the idle session." }),
  }),
  // ...
});
```

- [ ] **Step 2: Implement resume logic**

```ts
async execute(_toolCallId, params, signal, onUpdate, ctx) {
  const pooled = pool.get(params.runId);
  if (!pooled) {
    return makeResult(`No active session with runId "${params.runId}". Available: ${pool.getActiveRunIds().join(", ") || "none"}`, true);
  }

  // Reset events for this run
  pooled.events = [];
  pooled.lastActivity = Date.now();

  // Wire up onUpdate streaming
  const result = await runFollowUp(pooled, params.task, signal, onUpdate);
  return result;
}
```

- [ ] **Step 3: Implement runFollowUp**

```ts
async function runFollowUp(
  pooled: PooledSession,
  task: string,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
): Promise<AgentToolResult<SubagentDetails>> {
  const { session, agent, agentScope } = pooled;
  const events: RpcEvent[] = [];

  // Wire event listener
  const unsubscribe = session.onEvent((event) => {
    events.push(event);
    // Emit streaming updates (same pattern as runSingleAgent)
    if (onUpdate) { ... }
  });

  // Send follow-up
  session.followUp(`Task: ${task}`);

  // Wait for completion
  try {
    await session.waitForIdle(300_000);
  } finally {
    unsubscribe();
  }

  // Accumulate result
  const accumulated = accumulateResultFromEvents(events);
  // ... build SingleResult and return ...
}
```

- [ ] **Step 4: Handle session death**

If the pooled session's child process has exited (e.g., crashed, OOM), detect it and remove from pool. Return an error result.

### Task 4: subagent_release Tool

**Files:**

- Modify: `C:\Code\DeepAgent\src\extension\tool.ts`

- [ ] **Step 1: Register subagent_release tool**

```ts
pi.registerTool({
  name: "subagent_release",
  label: "Release Subagent",
  description: "Destroy an idle subagent session and discard its context.",
  parameters: Type.Object({
    runId: Type.String({ description: "The runId of the session to release." }),
  }),
  // ...
});
```

- [ ] **Step 2: Implement release logic**

```ts
async execute(_toolCallId, params) {
  const pooled = pool.get(params.runId);
  if (!pooled) {
    return makeResult(`No active session with runId "${params.runId}".`, true);
  }

  await pooled.session.stop();
  pool.remove(params.runId);
  return makeResult(`Session ${params.runId} released.`);
}
```

### Task 5: Rendering Updates

**Files:**

- Modify: `C:\Code\DeepAgent\src\extension\tool.ts`

- [ ] **Step 1: Update renderResult for keepAlive sessions**

When `details.runId` is present, append to collapsed and expanded views:

```
✓ worker (project)
  → result preview
  3 turns ↑2.1k ↓180 R1.0k
  run: run_abc123 (idle)  ← new line
```

- [ ] **Step 2: Update renderCall for resume**

```ts
// subagent_resume renderCall
`subagent resume ${args.runId}
  ${args.task preview}`
```

### Task 6: /doctor Update

**Files:**

- Modify: `C:\Code\DeepAgent\src\extension\tool.ts`

- [ ] **Step 1: Add pool status to /doctor**

```ts
const activeSessions = pool.getActiveRunIds();
lines.push(`sessions: ${activeSessions.length} active${activeSessions.length > 0 ? ` (${activeSessions.join(", ")})` : ""}`);
```

### Task 7: Parent Prompt Update

**Files:**

- Modify: `C:\Code\DeepAgent\.pi\prompts\parent.md`
- Modify: `C:\Code\DeepAgent\.pi\skills\subagent\SKILL.md`

- [ ] **Step 1: Update parent prompt**

Add guidance:

```markdown
When a task benefits from context accumulation across multiple steps:
1. Use `subagent` with `keepAlive: true` for the first step
2. Use `subagent_resume` with the returned `runId` for follow-up steps
3. Use `subagent_release` when done to free resources

For simple one-off tasks, omit `keepAlive` (default behavior: session destroyed after completion).
```

- [ ] **Step 2: Update skill**

Add resume/release workflow to the subagent skill.

### Task 8: Verification

- [ ] **Step 1: Unit tests**

```powershell
npm run check
```

- [ ] **Step 2: Foreground single with keepAlive**

```text
Use subagent with agent "worker", agentScope "both", keepAlive true, to inspect the project entrypoints.
```

Expected:

- result contains `runId`
- `/doctor` shows active session

- [ ] **Step 3: Resume follow-up**

```text
Use subagent_resume with the returned runId and task "based on the inspection, list all exported functions".
```

Expected:

- child uses prior context, does not re-investigate
- result reflects accumulated understanding

- [ ] **Step 4: Release**

```text
Use subagent_release with the runId.
```

Expected:

- session destroyed
- `/doctor` shows 0 active sessions
- subsequent `subagent_resume` with same runId returns error

- [ ] **Step 5: Parent exit cleanup**

Verify that registering a session pool and simulating parent exit triggers `releaseAll()`.

## Session Metadata

When a session enters idle state, the pool stores rich metadata so the parent can make informed decisions about whether to resume or release.

### Stored per session

```ts
interface PooledSession {
  runId: string;
  session: RpcSession;
  agent: string;
  model?: string;
  agentScope: AgentScope;
  createdAt: number;
  lastActivityAt: number;

  // History: what has this session done
  originalTask: string;
  totalTasks: number;
  taskHistory: Array<{ task: string; result: "completed" | "failed"; turns: number }>;
  lastOutput: string;  // last assistant output, truncated to ~200 chars

  // Context state: how much room is left
  messages: number;
  turns: number;
  usage: UsageStats;

  // Why it stopped
  stopReason: "end" | "need_decision" | "error" | "aborted";

  // What it touched (coarse-grained)
  filesRead: string[];
  filesEdited: string[];
}
```

### Why each field matters

| Field | Parent decision |
|-------|----------------|
| `taskHistory` | "这个 session 已经理解了什么，不用重复交代" |
| `usage.contextTokens` | "上下文快满了就不值得复用，不如开新的" |
| `stopReason` | "`need_decision` = child 在等我回复；`end` = 任务自然完成" |
| `filesRead` / `filesEdited` | "不用 resume 就能判断已经读过哪些文件" |
| `totalTasks` + `turns` | "已经 resume 了几次，累积了多少轮" |
| `cost` | "这个 session 已经花了多少钱" |

### Exposed through existing flows

1. **subagent result** (keepAlive: true): appends `run: run_abc123 (idle)` + context summary to renderResult
2. **subagent_resume result**: same format, cumulative stats
3. **/doctor**: lists active sessions with one-line summary each

No separate introspection tool needed — metadata travels with results.

## Completion Criteria

- `subagent` with `keepAlive: true` returns `runId` and keeps session alive
- `subagent_resume` sends follow-up task to idle session with preserved context
- `subagent_release` destroys idle session
- Idle sessions exempt from waitForIdle timeout
- Parent exit cleans up all sessions
- `/doctor` reports active sessions with summary
- `npm run check` passes
- Real Pi smoke confirms keepAlive → resume → release lifecycle
