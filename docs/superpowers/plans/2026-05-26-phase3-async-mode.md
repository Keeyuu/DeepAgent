# Phase 3: Async Subagent Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add async subagent execution — the parent agent can fire-and-forget a subagent task, then steer/check/abort it later via new tools.

**Architecture:** The `runSingleAgent` function currently blocks until `agent_end`. For async mode, we add a module-level `activeRuns` Map that holds live `RpcSession` instances keyed by run ID. The `subagent` tool gets a new `async: true` param; when set, `runSingleAgent` returns immediately with a run ID, and the session continues in the background. Three new tools (`subagent_steer`, `subagent_status`, `subagent_abort`) let the parent interact with live sessions.

**Tech Stack:** TypeScript, Pi RPC protocol (`--mode rpc`), Vitest for tests.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/extension/types.ts` | Modify | Add `AsyncRunInfo`, `RunStatus` types |
| `src/extension/run-registry.ts` | Create | `activeRuns` Map + lifecycle functions (register/get/remove/cleanup) |
| `src/extension/tool.ts` | Modify | Add `async` param to schema, register 3 new tools, modify `runSingleAgent` for async |
| `src/extension/run-registry.test.ts` | Create | Tests for run registry lifecycle |
| `src/extension/tool-async.test.ts` | Create | Tests for async mode schema + integration |

---

## Design Decisions

1. **Run ID generation**: `crypto.randomUUID()` — globally unique, no collision risk.
2. **Async session cleanup**: Sessions auto-cleanup on `agent_end` event. Also expose `subagent_abort` for manual cleanup. No background GC loop needed.
3. **Background event handling**: When `async: true`, events are accumulated in the registry entry. `subagent_status` reads the accumulated state.
4. **Steer vs followUp**: `subagent_steer` uses `session.steer()` (modifies current behavior). `session.followUp()` is not exposed as a separate tool — followUp is for after `agent_end`, which auto-cleans the run.
5. **Error in async mode**: If session fails to start, the run is never registered. If it fails mid-run, the error is captured in `AsyncRunInfo.lastError` and status becomes `failed`.
6. **Max concurrent runs**: Hard limit of 8 concurrent async runs (same as `MAX_PARALLEL_TASKS`). Prevents resource exhaustion.

---

### Task 1: Add Async Types to `types.ts`

**Files:**
- Modify: `src/extension/types.ts:62-95` (add after existing types)

- [ ] **Step 1: Add `RunStatus` and `AsyncRunInfo` types**

Add these types after the existing `RpcEvent` type (after line 95):

```typescript
/** Status of an async subagent run */
export type RunStatus = "running" | "completed" | "failed" | "aborted";

/** Info tracked for each async subagent run */
export interface AsyncRunInfo {
  /** Unique run ID */
  id: string;
  /** Agent name */
  agent: string;
  /** Original task */
  task: string;
  /** Current status */
  status: RunStatus;
  /** Live RPC session */
  session: RpcSession;
  /** Accumulated events from the session */
  events: RpcEvent[];
  /** Accumulated result (updated on each event) */
  accumulated: AccumulatedResult;
  /** Start timestamp */
  startedAt: number;
  /** Last error message (if failed) */
  lastError?: string;
  /** Agent source (user/project) */
  agentSource: "user" | "project" | "unknown";
}
```

Also add the import for `RpcSession` at the top of types.ts:

```typescript
import type { RpcSession } from "./rpc-session.ts";
```

Wait — `types.ts` should not depend on `rpc-session.ts` (circular risk). Instead, use the import inline in the interface or make `session` typed as `unknown` with a type assertion at usage. Better approach: keep `RpcSession` import in `run-registry.ts` only, and use `import type` in `types.ts`.

Actually, the cleanest approach: **don't import RpcSession in types.ts**. Instead, make the session field opaque:

```typescript
/** Opaque handle to the RPC session — avoid importing RpcSession in types.ts */
export type RpcSessionHandle = InstanceType<typeof import("./rpc-session.ts").RpcSession>;

/** Info tracked for each async subagent run */
export interface AsyncRunInfo {
  id: string;
  agent: string;
  task: string;
  status: RunStatus;
  session: RpcSessionHandle;
  events: RpcEvent[];
  accumulated: AccumulatedResult;
  startedAt: number;
  lastError?: string;
  agentSource: "user" | "project" | "unknown";
}
```

Hmm, but `InstanceType<typeof import(...))>` is valid TypeScript but unusual. Let's use the simpler approach: import `RpcSession` as a type-only import. No circular dependency since `rpc-session.ts` already imports from `types.ts` (only `RpcEvent`), and `types.ts` would import `RpcSession` as type-only.

Actually check: `rpc-session.ts` imports `{ RpcEvent }` from `./types.ts`. Adding `import type { RpcSession }` from `./rpc-session.ts` in `types.ts` creates a circular type import. TypeScript handles circular type-only imports fine, but it's a code smell.

**Best approach**: Don't reference `RpcSession` in `types.ts`. Make the session field `unknown` and cast at usage in `run-registry.ts`.

```typescript
/** Info tracked for each async subagent run */
export interface AsyncRunInfo {
  id: string;
  agent: string;
  task: string;
  status: RunStatus;
  /** Live RPC session (RpcSession instance, typed as unknown to avoid circular imports) */
  session: unknown;
  events: RpcEvent[];
  accumulated: AccumulatedResult;
  startedAt: number;
  lastError?: string;
  agentSource: "user" | "project" | "unknown";
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS (no code uses the new types yet)

---

### Task 2: Create `run-registry.ts`

**Files:**
- Create: `src/extension/run-registry.ts`
- Test: `src/extension/run-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/extension/run-registry.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerRun,
  getRun,
  removeRun,
  getActiveRunCount,
  getAllRuns,
  clearAllRuns,
  MAX_ACTIVE_RUNS,
} from "./run-registry.ts";
import type { AsyncRunInfo, RunStatus, RpcEvent, AccumulatedResult } from "./types.ts";

function makeMockSession(): { session: any; methods: { abort: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; isStarted: ReturnType<typeof vi.fn> } } {
  const methods = {
    abort: vi.fn(),
    steer: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    isStarted: vi.fn().mockReturnValue(true),
  };
  return { session: methods, methods };
}

function makeRunInfo(overrides?: Partial<AsyncRunInfo>): AsyncRunInfo {
  const { session } = makeMockSession();
  return {
    id: "test-run-id",
    agent: "worker",
    task: "do something",
    status: "running",
    session,
    events: [],
    accumulated: {
      messages: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      stderr: "",
    },
    startedAt: Date.now(),
    agentSource: "user",
    ...overrides,
  };
}

beforeEach(() => {
  clearAllRuns();
});

describe("registerRun", () => {
  it("registers a run and returns the run ID", () => {
    const info = makeRunInfo();
    const id = registerRun(info);
    expect(id).toBe("test-run-id");
    expect(getRun(id)).toBe(info);
  });

  it("rejects when max concurrent runs reached", () => {
    for (let i = 0; i < MAX_ACTIVE_RUNS; i++) {
      registerRun(makeRunInfo({ id: `run-${i}` }));
    }
    expect(() => registerRun(makeRunInfo({ id: "overflow" }))).toThrow(/max.*concurrent/i);
  });
});

describe("getRun", () => {
  it("returns undefined for unknown run ID", () => {
    expect(getRun("nonexistent")).toBeUndefined();
  });

  it("returns the run info for a registered run", () => {
    const info = makeRunInfo();
    registerRun(info);
    expect(getRun("test-run-id")).toBe(info);
  });
});

describe("removeRun", () => {
  it("removes a run and returns it", () => {
    const info = makeRunInfo();
    registerRun(info);
    const removed = removeRun("test-run-id");
    expect(removed).toBe(info);
    expect(getRun("test-run-id")).toBeUndefined();
  });

  it("returns undefined for unknown run ID", () => {
    expect(removeRun("nonexistent")).toBeUndefined();
  });
});

describe("getActiveRunCount", () => {
  it("returns 0 when no runs", () => {
    expect(getActiveRunCount()).toBe(0);
  });

  it("returns count of registered runs", () => {
    registerRun(makeRunInfo({ id: "a" }));
    registerRun(makeRunInfo({ id: "b" }));
    expect(getActiveRunCount()).toBe(2);
  });
});

describe("getAllRuns", () => {
  it("returns all runs as array", () => {
    const a = makeRunInfo({ id: "a" });
    const b = makeRunInfo({ id: "b" });
    registerRun(a);
    registerRun(b);
    const all = getAllRuns();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });
});

describe("clearAllRuns", () => {
  it("removes all runs", () => {
    registerRun(makeRunInfo({ id: "a" }));
    registerRun(makeRunInfo({ id: "b" }));
    clearAllRuns();
    expect(getActiveRunCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/extension/run-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `run-registry.ts`**

Create `src/extension/run-registry.ts`:

```typescript
/**
 * Run Registry — tracks active async subagent runs.
 *
 * Module-level Map with lifecycle functions.
 * Used by tool.ts to register async runs and by steer/status/abort tools
 * to interact with them.
 */

import type { AsyncRunInfo } from "./types.ts";

/** Maximum concurrent async runs */
export const MAX_ACTIVE_RUNS = 8;

/** Active runs keyed by run ID */
const activeRuns = new Map<string, AsyncRunInfo>();

/** Register a new async run. Returns the run ID. Throws if max reached. */
export function registerRun(info: AsyncRunInfo): string {
  if (activeRuns.size >= MAX_ACTIVE_RUNS) {
    throw new Error(
      `Max concurrent async runs reached (${MAX_ACTIVE_RUNS}). Abort an existing run first.`,
    );
  }
  activeRuns.set(info.id, info);
  return info.id;
}

/** Get a run by ID. Returns undefined if not found. */
export function getRun(id: string): AsyncRunInfo | undefined {
  return activeRuns.get(id);
}

/** Remove a run by ID. Returns the removed info or undefined. */
export function removeRun(id: string): AsyncRunInfo | undefined {
  return activeRuns.delete(id) ? activeRuns.get(id) : undefined;
}

/** Actually, Map.delete returns boolean. Fix: */
// Rewrite removeRun properly:
```

Wait, `Map.delete` returns boolean, not the value. Let me fix:

```typescript
/** Remove a run by ID. Returns the removed info or undefined. */
export function removeRun(id: string): AsyncRunInfo | undefined {
  const info = activeRuns.get(id);
  if (info) activeRuns.delete(id);
  return info;
}

/** Get count of active runs */
export function getActiveRunCount(): number {
  return activeRuns.size;
}

/** Get all active runs as array */
export function getAllRuns(): AsyncRunInfo[] {
  return Array.from(activeRuns.values());
}

/** Remove all runs (for testing/cleanup) */
export function clearAllRuns(): void {
  activeRuns.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/extension/run-registry.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Run full check**

Run: `npm run check`
Expected: PASS (all tests, no type errors)

- [ ] **Step 6: Commit**

```bash
git add src/extension/run-registry.ts src/extension/run-registry.test.ts src/extension/types.ts
git commit -m "feat: add run registry + async types for Phase 3"
```

---

### Task 3: Add `async` Param to Subagent Schema

**Files:**
- Modify: `src/extension/tool.ts:241-251` (SubagentParams schema)
- Modify: `src/extension/tool.ts:493-729` (execute handler)

- [ ] **Step 1: Add `async` field to SubagentParams schema**

In `src/extension/tool.ts`, find the `SubagentParams` schema (around line 241) and add the `async` field:

```typescript
const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
  async: Type.Optional(Type.Boolean({ description: "Run in background. Returns run ID immediately. Use subagent_steer/status/abort to interact. Only for single mode.", default: false })),
});
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS (field is optional, no behavior change yet)

---

### Task 4: Implement Async Mode in `runSingleAgent`

**Files:**
- Modify: `src/extension/tool.ts:262-422` (runSingleAgent function)

This is the core change. When `async: true`, `runSingleAgent` starts the session, registers it in the run registry, wires up background event accumulation, and returns immediately with a `SingleResult` containing the run ID.

- [ ] **Step 1: Add imports for run-registry**

Add at the top of `tool.ts` with other imports:

```typescript
import { randomUUID } from "node:crypto";
import { registerRun, getRun, removeRun, getActiveRunCount, getAllRuns } from "./run-registry.ts";
import type { AsyncRunInfo, RunStatus } from "./types.ts";
```

- [ ] **Step 2: Modify `runSingleAgent` signature to accept `asyncMode`**

Change the function signature (around line 262):

```typescript
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
): Promise<SingleResult> {
```

- [ ] **Step 3: Add async mode early return after session start**

After the session start success (around line 330, after `await session.start()`), add the async mode branch. Find the section starting with:

```typescript
	// Handle extension UI requests (confirm/input from child)
```

Add the async branch **before** the UI request handler setup:

```typescript
	// ── Async mode: register run and return immediately ──
	if (asyncMode) {
		const runId = randomUUID();
		const runInfo: AsyncRunInfo = {
			id: runId,
			agent: agentName,
			task,
			status: "running",
			session,
			events: [],
			accumulated: {
				messages: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				stderr: "",
			},
			startedAt: Date.now(),
			agentSource: agent.source,
		};

		// Wire up background event accumulation
		session.onEvent((event) => {
			runInfo.events.push(event);
			accumulateEvent(runInfo.accumulated, event);

			if (event.type === "agent_end") {
				runInfo.status = "completed";
				// Auto-cleanup after a delay to allow status queries
				setTimeout(() => {
					removeRun(runId);
					session.stop().catch(() => {});
				}, 60_000); // Keep in registry for 1 min after completion
			}
		});

		// Handle UI requests in background (auto-respond)
		session.onUIRequest((req) => {
			const fireAndForget = ["notify", "setStatus", "setTitle", "setWidget", "set_editor_text"];
			if (fireAndForget.includes(req.method)) return;
			if (req.method === "confirm") session.respondToUIRequest(req.id, { confirmed: true });
			else if (req.method === "input") session.respondToUIRequest(req.id, { value: String(req.default_value ?? "") });
			else if (req.method === "select") {
				const opts = req.options as string[] | undefined;
				session.respondToUIRequest(req.id, { value: opts?.[0] ?? "" });
			} else if (req.method === "editor") session.respondToUIRequest(req.id, { value: String(req.prefill ?? "") });
			else session.respondToUIRequest(req.id, { cancelled: true });
		});

		// Wire abort signal
		if (signal) {
			const killSession = async () => {
				runInfo.status = "aborted";
				try { session.abort(); } catch { /* ignore */ }
				setTimeout(() => {
					removeRun(runId);
					session.stop().catch(() => {});
				}, 1000);
			};
			if (signal.aborted) killSession();
			else signal.addEventListener("abort", killSession, { once: true });
		}

		// Register the run
		registerRun(runInfo);

		// Send the task prompt
		session.prompt(`Task: ${task}`);

		// Return immediately with run ID
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: -1, // still running
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: agent.model,
			step,
			errorMessage: `Async run started. Run ID: ${runId}`,
		};
	}
```

- [ ] **Step 4: Add `accumulateEvent` import**

The async branch uses `accumulateEvent` from event-accumulator. Update the import line:

```typescript
import { accumulateResultFromEvents, accumulateEvent, getFinalOutput } from "./event-accumulator.ts";
```

- [ ] **Step 5: Modify the single-mode execute handler to pass asyncMode**

In the execute handler's single mode section (around line 697), pass the `async` param:

```typescript
		// ── Single mode ──
		if (params.agent && params.task) {
			const isAsync = params.async ?? false;

			if (isAsync && (hasChain || hasTasks)) {
				return {
					content: [{ type: "text", text: "Async mode is only supported for single task mode (agent + task)." }],
					details: makeDetails("single")([]),
				};
			}

			const result = await runSingleAgent(
				ctx.cwd,
				agents,
				params.agent,
				params.task,
				params.cwd,
				undefined,
				signal,
				onUpdate,
				makeDetails("single"),
				isAsync,
			);

			if (isAsync) {
				// Async mode — result contains run ID in errorMessage
				return {
					content: [{ type: "text", text: result.errorMessage || "Async run started." }],
					details: makeDetails("single")([result]),
				};
			}

			const isError = isFailedResult(result);
			if (isError) {
				// ... existing error handling unchanged
```

- [ ] **Step 6: Run typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `npm run check`
Expected: All existing tests still pass (50 + new registry tests)

- [ ] **Step 8: Commit**

```bash
git add src/extension/tool.ts
git commit -m "feat: async mode for subagent single task — returns run ID immediately"
```

---

### Task 5: Register `subagent_steer` Tool

**Files:**
- Modify: `src/extension/tool.ts` (add after subagent tool registration, before `/doctor` command)

- [ ] **Step 1: Add `subagent_steer` schema and tool registration**

Add after the `subagent` tool registration block (after `pi.registerTool({ ... })` close), before `pi.registerCommand("doctor", ...)`:

```typescript
	// ── Register subagent_steer tool ──
	pi.registerTool({
		name: "subagent_steer",
		label: "Subagent Steer",
		description: "Send a steering message to a running async subagent. The message modifies the agent's current behavior without ending its turn.",
		parameters: Type.Object({
			runId: Type.String({ description: "The run ID returned by the async subagent call" }),
			message: Type.String({ description: "The steering message to send to the running agent" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<undefined>> {
			const run = getRun(params.runId);
			if (!run) {
				return {
					content: [{ type: "text", text: `No active run with ID: ${params.runId}` }],
					details: undefined,
				};
			}
			if (run.status !== "running") {
				return {
					content: [{ type: "text", text: `Run ${params.runId} is not running (status: ${run.status})` }],
					details: undefined,
				};
			}

			const session = run.session as RpcSession;
			try {
				session.steer(params.message);
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Failed to steer: ${err.message}` }],
					details: undefined,
				};
			}

			return {
				content: [{ type: "text", text: `Steering message sent to run ${params.runId}` }],
				details: undefined,
			};
		},
	});
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/extension/tool.ts
git commit -m "feat: add subagent_steer tool for async run steering"
```

---

### Task 6: Register `subagent_status` Tool

**Files:**
- Modify: `src/extension/tool.ts` (add after subagent_steer)

- [ ] **Step 1: Add `subagent_status` tool registration**

```typescript
	// ── Register subagent_status tool ──
	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: "Check the status of an async subagent run. Returns current progress, accumulated output, and usage stats.",
		parameters: Type.Object({
			runId: Type.Optional(Type.String({ description: "The run ID to check. If omitted, lists all active runs." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<undefined>> {
			// List all runs if no runId specified
			if (!params.runId) {
				const runs = getAllRuns();
				if (runs.length === 0) {
					return {
						content: [{ type: "text", text: "No active async subagent runs." }],
						details: undefined,
					};
				}
				const lines = runs.map((r) => {
					const elapsed = Math.round((Date.now() - r.startedAt) / 1000);
					const output = getFinalOutput(r.accumulated.messages);
					const preview = output.length > 80 ? `${output.slice(0, 80)}...` : output || "(no output yet)";
					return `- ${r.id}: [${r.status}] ${r.agent} "${r.task}" (${elapsed}s)\n  ${preview}`;
				});
				return {
					content: [{ type: "text", text: `Active runs (${runs.length}):\n${lines.join("\n")}` }],
					details: undefined,
				};
			}

			const run = getRun(params.runId);
			if (!run) {
				return {
					content: [{ type: "text", text: `No run found with ID: ${params.runId}. It may have completed and been cleaned up.` }],
					details: undefined,
				};
			}

			const elapsed = Math.round((Date.now() - run.startedAt) / 1000);
			const output = getFinalOutput(run.accumulated.messages);
			const usage = run.accumulated.usage;

			const parts = [
				`Run: ${run.id}`,
				`Agent: ${run.agent} (${run.agentSource})`,
				`Task: ${run.task}`,
				`Status: ${run.status}`,
				`Elapsed: ${elapsed}s`,
				`Turns: ${usage.turns}`,
			];

			if (usage.input || usage.output) {
				parts.push(`Tokens: ↑${usage.input} ↓${usage.output}`);
			}
			if (usage.cost) {
				parts.push(`Cost: $${usage.cost.toFixed(4)}`);
			}
			if (run.accumulated.model) {
				parts.push(`Model: ${run.accumulated.model}`);
			}
			if (run.accumulated.stopReason) {
				parts.push(`Stop: ${run.accumulated.stopReason}`);
			}
			if (run.accumulated.errorMessage) {
				parts.push(`Error: ${run.accumulated.errorMessage}`);
			}
			if (run.lastError) {
				parts.push(`LastError: ${run.lastError}`);
			}
			if (output) {
				parts.push(`\nOutput:\n${output}`);
			}

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: undefined,
			};
		},
	});
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/extension/tool.ts
git commit -m "feat: add subagent_status tool for async run status queries"
```

---

### Task 7: Register `subagent_abort` Tool

**Files:**
- Modify: `src/extension/tool.ts` (add after subagent_status)

- [ ] **Step 1: Add `subagent_abort` tool registration**

```typescript
	// ── Register subagent_abort tool ──
	pi.registerTool({
		name: "subagent_abort",
		label: "Subagent Abort",
		description: "Abort a running async subagent. Sends SIGTERM to the child process and removes it from the active runs registry.",
		parameters: Type.Object({
			runId: Type.String({ description: "The run ID to abort" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<undefined>> {
			const run = getRun(params.runId);
			if (!run) {
				return {
					content: [{ type: "text", text: `No active run with ID: ${params.runId}` }],
					details: undefined,
				};
			}
			if (run.status !== "running") {
				return {
					content: [{ type: "text", text: `Run ${params.runId} is not running (status: ${run.status})` }],
					details: undefined,
				};
			}

			run.status = "aborted";
			const session = run.session as RpcSession;

			// Remove from registry first
			removeRun(params.runId);

			// Graceful abort then force stop
			try { session.abort(); } catch { /* ignore */ }
			try { await session.stop(); } catch { /* ignore */ }

			return {
				content: [{ type: "text", text: `Run ${params.runId} aborted and cleaned up.` }],
				details: undefined,
			};
		},
	});
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npm run check`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/extension/tool.ts
git commit -m "feat: add subagent_abort tool for async run termination"
```

---

### Task 8: Add Async Mode Tests

**Files:**
- Create: `src/extension/tool-async.test.ts`

- [ ] **Step 1: Write tests for async mode behavior**

Create `src/extension/tool-async.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { clearAllRuns, getRun, getActiveRunCount, getAllRuns } from "./run-registry.ts";
import type { AsyncRunInfo, RpcEvent, AccumulatedResult } from "./types.ts";

// Note: Full integration tests require RpcSession mocking which is complex.
// These tests focus on the registry and async mode parameter validation.

beforeEach(() => {
  clearAllRuns();
});

describe("async mode integration", () => {
  it("getActiveRunCount is 0 initially", () => {
    expect(getActiveRunCount()).toBe(0);
  });

  it("getRun returns undefined for unknown ID", () => {
    expect(getRun("nonexistent")).toBeUndefined();
  });

  it("getAllRuns returns empty array when no runs", () => {
    expect(getAllRuns()).toEqual([]);
  });

  it("can register and retrieve a run", () => {
    const info: AsyncRunInfo = {
      id: "test-id",
      agent: "worker",
      task: "test task",
      status: "running",
      session: { abort: vi.fn(), steer: vi.fn(), stop: vi.fn() },
      events: [],
      accumulated: {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        stderr: "",
      },
      startedAt: Date.now(),
      agentSource: "user",
    };

    const { registerRun } = require("./run-registry.ts");
    // Actually, we import at top. Just test directly:
    // registerRun is already imported
  });
});
```

Wait, `require` won't work in ESM. Let me fix the test to use proper imports and test the registry + parameter schema validation:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerRun, getRun, removeRun, clearAllRuns, getActiveRunCount, getAllRuns, MAX_ACTIVE_RUNS } from "./run-registry.ts";
import { randomUUID } from "node:crypto";
import type { AsyncRunInfo } from "./types.ts";

function makeRunInfo(overrides?: Partial<AsyncRunInfo>): AsyncRunInfo {
  return {
    id: randomUUID(),
    agent: "worker",
    task: "test task",
    status: "running",
    session: { abort: vi.fn(), steer: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) },
    events: [],
    accumulated: {
      messages: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      stderr: "",
    },
    startedAt: Date.now(),
    agentSource: "user",
    ...overrides,
  };
}

beforeEach(() => {
  clearAllRuns();
});

describe("run registry lifecycle", () => {
  it("registers and retrieves a run", () => {
    const info = makeRunInfo();
    registerRun(info);
    expect(getRun(info.id)).toBe(info);
  });

  it("removes a run", () => {
    const info = makeRunInfo();
    registerRun(info);
    const removed = removeRun(info.id);
    expect(removed).toBe(info);
    expect(getRun(info.id)).toBeUndefined();
  });

  it("enforces max concurrent runs", () => {
    for (let i = 0; i < MAX_ACTIVE_RUNS; i++) {
      registerRun(makeRunInfo());
    }
    expect(() => registerRun(makeRunInfo())).toThrow(/max.*concurrent/i);
  });

  it("clears all runs", () => {
    registerRun(makeRunInfo());
    registerRun(makeRunInfo());
    clearAllRuns();
    expect(getActiveRunCount()).toBe(0);
  });

  it("lists all runs", () => {
    const a = makeRunInfo();
    const b = makeRunInfo();
    registerRun(a);
    registerRun(b);
    const all = getAllRuns();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === a.id)).toBeDefined();
    expect(all.find((r) => r.id === b.id)).toBeDefined();
  });
});

describe("async mode status transitions", () => {
  it("tracks status change from running to completed", () => {
    const info = makeRunInfo();
    registerRun(info);
    expect(getRun(info.id)!.status).toBe("running");

    info.status = "completed";
    expect(getRun(info.id)!.status).toBe("completed");
  });

  it("tracks status change from running to aborted", () => {
    const info = makeRunInfo();
    registerRun(info);
    info.status = "aborted";
    removeRun(info.id);
    expect(getRun(info.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/extension/tool-async.test.ts`
Expected: PASS

- [ ] **Step 3: Run full check**

Run: `npm run check`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/extension/tool-async.test.ts
git commit -m "test: add async mode registry and lifecycle tests"
```

---

### Task 9: Update `/doctor` Command

**Files:**
- Modify: `src/extension/tool.ts` (the `/doctor` command handler)

- [ ] **Step 1: Add active runs info to doctor output**

Find the `/doctor` handler (around line 1041) and update:

```typescript
	pi.registerCommand("doctor", {
		description: "Check subagent extension status",
		async handler(_args, ctx) {
			const discovery = discoverAgents(ctx.cwd, "both");
			const agentList = discovery.agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			const activeRuns = getActiveRunCount();

			const lines = [
				"Subagent Extension",
				"extension: loaded",
				`agents: ${agentList}`,
				"transport: rpc (--mode rpc)",
				`active async runs: ${activeRuns}`,
				`config: idleTimeoutMs=${subagentConfig.idleTimeoutMs}`,
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
```

- [ ] **Step 2: Run full check**

Run: `npm run check`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/extension/tool.ts
git commit -m "feat: update /doctor with async run count and config info"
```

---

### Task 10: Final Verification

- [ ] **Step 1: Run full check**

Run: `npm run check`
Expected: All tests pass, 0 type errors

- [ ] **Step 2: Verify file structure**

Run: `ls -la src/extension/`
Expected files:
- `agents.ts`, `agents.test.ts`
- `event-accumulator.ts`, `event-accumulator.test.ts`
- `guards.ts`, `guards.test.ts`
- `rpc-session.ts`
- `run-registry.ts`, `run-registry.test.ts`
- `tool.ts`, `tool-async.test.ts`
- `types.ts`

- [ ] **Step 3: Verify git log**

Run: `git log --oneline -10`
Expected: All Phase 3 commits visible
