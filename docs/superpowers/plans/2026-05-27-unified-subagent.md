# Unified Subagent Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify single/parallel/chain modes into a single `tasks` array dispatch, remove `chain` and top-level `agent`/`task` params, add `async` param to control blocking behavior.

**Architecture:** Replace three dispatch modes (single fire-and-forget, parallel fire-and-forget, chain sequential-wait) with one: `tasks` array always dispatched in parallel. `async: true` (default) returns run IDs immediately; `async: false` blocks until all complete. Chain behavior is emulated by parent LLM making sequential calls. `keepAlive` works per-task (no single-task restriction). Split `runSingleAgent` into `launchAgent()` (fire-and-forget) + `runAgent()` (wait).

**Tech Stack:** TypeScript, Pi Extension API, typebox, vitest

---

## File Structure

| File | Responsibility | Change |
|------|---------------|--------|
| `src/extension/types.ts` | Type definitions | Remove `mode` from `SubagentDetails`, remove `step` from `SingleResult` |
| `src/extension/tool.ts` | Main subagent tool + renderCall/renderResult | Major rewrite: new schema, split runSingleAgent, remove chain, unified dispatch |
| `.pi/prompts/parent.md` | Parent agent system prompt | Update for unified dispatch |
| `.pi/skills/subagent/SKILL.md` | Subagent skill documentation | Update for unified dispatch |

**Files NOT changed:** `rpc-session.ts`, `session-pool.ts`, `run-registry.ts`, `event-accumulator.ts`, `agents.ts`, `guards.ts`, `types.ts` (other than noted above)

---

### Task 1: Update types.ts — Remove `mode` and `step`

**Files:**
- Modify: `src/extension/types.ts:39-61`

- [ ] **Step 1: Update `SingleResult` and `SubagentDetails`**

In `src/extension/types.ts`, make these changes:

1. Remove `step?: number` from `SingleResult` (line 50).
2. Change `SubagentDetails.mode` from `"single" | "parallel" | "chain"` to just track the count. Replace the `mode` field with nothing — infer behavior from `results.length` and `exitCode`. The new `SubagentDetails`:

```typescript
/** Details payload for the tool result */
export interface SubagentDetails {
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
  runId?: string; // present when keepAlive: true or action: "resume"
}
```

So `SingleResult` becomes:
```typescript
export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  runId?: string;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: Errors in tool.ts (references to `mode`, `step`, `"single"`, `"parallel"`, `"chain"`) — that's expected, will fix in Task 2.

- [ ] **Step 3: Commit**

```bash
git add src/extension/types.ts
git commit -m "refactor: remove mode from SubagentDetails, step from SingleResult"
```

---

### Task 2: Rewrite tool.ts — Schema, launchAgent/runAgent split, unified dispatch

This is the largest task. It touches: schema definitions, `runSingleAgent` → `launchAgent` + `runAgent`, execute handler, renderCall, renderResult.

**Files:**
- Modify: `src/extension/tool.ts` (major rewrite)

- [ ] **Step 2a: New schema definitions**

Replace the current schema block (lines 219-261) with:

```typescript
const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const ActionSchema = StringEnum(["run", "resume", "release"] as const, {
	description: "Action to perform. 'run': new task(s) (default). 'resume': send follow-up to idle session. 'release': destroy idle session.",
	default: "run",
});

const SubagentParams = Type.Object({
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} to dispatch. Default: requires at least one task for action='run'." })),
	async: Type.Optional(Type.Boolean({ description: "true (default) = return run IDs immediately. false = block until all tasks complete.", default: true })),
	keepAlive: Type.Optional(Type.Boolean({ description: "Keep child sessions alive after completion for follow-up via action='resume'. Default: false.", default: false })),
	agentScope: Type.Optional(AgentScopeSchema),
	action: Type.Optional(ActionSchema),
	runId: Type.Optional(Type.String({ description: "Session runId for resume/release actions" })),
	task: Type.Optional(Type.String({ description: "Task for resume action" })),
	confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true })),
});
```

Note: `agent`, `task` (top-level), `tasks` (required for run), `chain`, `cwd` (top-level) are removed. `async` is added.

- [ ] **Step 2b: Split runSingleAgent into launchAgent + runAgent**

Delete the entire `runSingleAgent` function (approximately lines 279-500).

Replace with two functions:

```typescript
/**
 * Launch a single agent — fire-and-forget.
 * Registers the run and returns immediately with the run ID.
 * The caller gets a SingleResult with exitCode=EXIT_CODE_PENDING.
 */
function launchAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	keepAlive: boolean = false,
): SingleResult {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const session = new RpcSession({
		cwd: cwd ?? defaultCwd,
		env: {
			SUBAGENT_CHILD: "1",
			SUBAGENT_DEPTH: String(parseInt(process.env.SUBAGENT_DEPTH || "0", 10) + 1),
		},
		model: agent.model,
		tools: agent.tools,
		systemPrompt: agent.systemPrompt,
		args: ["-p"],
		childExtensionPath: path.join(defaultCwd, ".pi", "extensions", "subagent", "index.ts"),
	});

	// Start session in background — errors handled in event handlers
	let startError: string | undefined;
	session.start().catch((err: any) => { startError = err.message; });

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

	let poolRunId: string | undefined;

	const unsubEvents = session.onEvent((event) => {
		runInfo.events.push(event);
		runInfo.unsubEvents = unsubEvents;
		accumulateEvent(runInfo.accumulated, event);

		if (event.type === "agent_end") {
			runInfo.status = "completed";
			if (keepAlive && session.getExitCode() === null) {
				unsubEvents();
				removeRun(runId);
				try {
					poolRunId = addToPool(session, agentName, agent.source, runInfo.accumulated.usage);
				} catch {
					session.stop().catch(() => {});
					poolRunId = undefined;
				}
			} else {
				// Auto-cleanup 60s after completion
				setTimeout(() => {
					unsubEvents();
					removeRun(runId);
					session.stop().catch(() => {});
				}, 60_000);
			}
		}
	});

	session.onUIRequest((req) => {
		const fireAndForgetMethods = ["notify", "setStatus", "setTitle", "setWidget", "set_editor_text"];
		if (fireAndForgetMethods.includes(req.method)) return;
		runInfo.pendingDecision = {
			requestId: req.id,
			message: (req as Record<string, unknown>).message as string ?? (req as Record<string, unknown>).title as string ?? "Unknown request",
			requestedAt: Date.now(),
		};
	});

	const unsubClose = session.onClose((code) => {
		if (runInfo.status === "running") {
			runInfo.status = code === 0 ? "completed" : "failed";
			unsubEvents();
			unsubClose();
			setTimeout(() => {
				removeRun(runId);
				session.stop().catch(() => {});
			}, 5_000);
		}
	});

	if (signal) {
		const killSession = async () => {
			runInfo.status = "aborted";
			unsubEvents();
			try { session.abort(); } catch { /* ignore */ }
			setTimeout(() => {
				removeRun(runId);
				session.stop().catch(() => {});
			}, 1000);
		};
		if (signal.aborted) killSession();
		else signal.addEventListener("abort", killSession, { once: true });
	}

	registerRun(runInfo);

	// Wait for start before sending prompt
	session.start().then(() => {
		session.prompt(`Task: ${task}`);
	}).catch(() => {
		// Start already failed, handled by onClose
	});

	return {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: EXIT_CODE_PENDING,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		errorMessage: `Async run started. Run ID: ${runId}`,
		runId: poolRunId,
	};
}

/**
 * Run a single agent — blocks until completion.
 * Used internally by async=false mode and resume.
 */
async function runAgent(
	session: RpcSession,
	runInfo: AsyncRunInfo,
	keepAlive: boolean = false,
): Promise<SingleResult> {
	let poolRunId: string | undefined;
	const unsubEvents = session.onEvent((event) => {
		runInfo.events.push(event);
		runInfo.unsubEvents = unsubEvents;
		accumulateEvent(runInfo.accumulated, event);

		if (event.type === "agent_end") {
			runInfo.status = "completed";
			if (keepAlive && session.getExitCode() === null) {
				unsubEvents();
				removeRun(runInfo.id);
				try {
					poolRunId = addToPool(session, runInfo.agent, runInfo.agentSource, runInfo.accumulated.usage);
				} catch {
					session.stop().catch(() => {});
					poolRunId = undefined;
				}
			}
		}
	});

	session.onUIRequest((req) => {
		const fireAndForgetMethods = ["notify", "setStatus", "setTitle", "setWidget", "set_editor_text"];
		if (fireAndForgetMethods.includes(req.method)) return;
		runInfo.pendingDecision = {
			requestId: req.id,
			message: (req as Record<string, unknown>).message as string ?? (req as Record<string, unknown>).title as string ?? "Unknown request",
			requestedAt: Date.now(),
		};
	});

	const unsubClose = session.onClose((code) => {
		if (runInfo.status === "running") {
			runInfo.status = code === 0 ? "completed" : "failed";
		}
	});

	try {
		await session.waitForIdle(subagentConfig.idleTimeoutMs);
	} catch {
		// Idle timeout or process crash
	} finally {
		unsubEvents();
		unsubClose();
	}

	// Auto-cleanup if not keepAlive
	if (!keepAlive) {
		setTimeout(() => {
			removeRun(runInfo.id);
			session.stop().catch(() => {});
		}, 60_000);
	}

	return {
		agent: runInfo.agent,
		agentSource: runInfo.agentSource,
		task: runInfo.task,
		exitCode: session.getExitCode() ?? (runInfo.status === "completed" ? 0 : 1),
		messages: runInfo.accumulated.messages,
		stderr: runInfo.accumulated.stderr,
		usage: runInfo.accumulated.usage,
		model: runInfo.accumulated.model,
		stopReason: runInfo.accumulated.stopReason,
		errorMessage: runInfo.accumulated.errorMessage,
		runId: poolRunId,
	};
}
```

**IMPORTANT**: `launchAgent` does NOT await `session.start()`. Instead it calls `session.start()` fire-and-forget, and sends `session.prompt()` after start resolves. This is a design change — the caller gets the run ID immediately. If start fails, `onClose` handles cleanup.

However, this is a problem: `registerRun` is called before `session.start()` resolves, and `session.prompt()` might be called before the session is ready. The fix: `launchAgent` should await `session.start()` first (it's fast, ~2s), then return. This makes it "semi-fire-and-forget": it awaits startup but not execution.

**Revised `launchAgent`**: The function should `await session.start()` at the top (before registerRun), then return immediately after sending prompt. The "fire-and-forget" part is NOT awaiting `waitForIdle`.

```typescript
async function launchAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	keepAlive: boolean = false,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const session = new RpcSession({
		cwd: cwd ?? defaultCwd,
		env: {
			SUBAGENT_CHILD: "1",
			SUBAGENT_DEPTH: String(parseInt(process.env.SUBAGENT_DEPTH || "0", 10) + 1),
		},
		model: agent.model,
		tools: agent.tools,
		systemPrompt: agent.systemPrompt,
		args: ["-p"],
		childExtensionPath: path.join(defaultCwd, ".pi", "extensions", "subagent", "index.ts"),
	});

	try {
		await session.start();
	} catch (err: any) {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: `Failed to start RPC session: ${err.message}`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

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

	let poolRunId: string | undefined;

	const unsubEvents = session.onEvent((event) => {
		runInfo.events.push(event);
		runInfo.unsubEvents = unsubEvents;
		accumulateEvent(runInfo.accumulated, event);

		if (event.type === "agent_end") {
			runInfo.status = "completed";
			if (keepAlive && session.getExitCode() === null) {
				unsubEvents();
				removeRun(runId);
				try {
					poolRunId = addToPool(session, agentName, agent.source, runInfo.accumulated.usage);
				} catch {
					session.stop().catch(() => {});
					poolRunId = undefined;
				}
			} else {
				setTimeout(() => {
					unsubEvents();
					removeRun(runId);
					session.stop().catch(() => {});
				}, 60_000);
			}
		}
	});

	session.onUIRequest((req) => {
		const fireAndForgetMethods = ["notify", "setStatus", "setTitle", "setWidget", "set_editor_text"];
		if (fireAndForgetMethods.includes(req.method)) return;
		runInfo.pendingDecision = {
			requestId: req.id,
			message: (req as Record<string, unknown>).message as string ?? (req as Record<string, unknown>).title as string ?? "Unknown request",
			requestedAt: Date.now(),
		};
	});

	const unsubClose = session.onClose((code) => {
		if (runInfo.status === "running") {
			runInfo.status = code === 0 ? "completed" : "failed";
			unsubEvents();
			unsubClose();
			setTimeout(() => {
				removeRun(runId);
				session.stop().catch(() => {});
			}, 5_000);
		}
	});

	if (signal) {
		const killSession = async () => {
			runInfo.status = "aborted";
			unsubEvents();
			try { session.abort(); } catch { /* ignore */ }
			setTimeout(() => {
				removeRun(runId);
				session.stop().catch(() => {});
			}, 1000);
		};
		if (signal.aborted) killSession();
		else signal.addEventListener("abort", killSession, { once: true });
	}

	registerRun(runInfo);
	session.prompt(`Task: ${task}`);

	return {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: EXIT_CODE_PENDING,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		errorMessage: `Async run started. Run ID: ${runId}`,
	};
}
```

- [ ] **Step 2c: Rewrite execute handler (action=run)**

Replace the entire RUN action block (from `// ── RUN action` to end of single/parallel/chain modes). The new unified dispatch:

```typescript
// ── RUN action (default) ──
const agentScope: AgentScope = params.agentScope ?? "user";
const discovery = discoverAgents(ctx.cwd, agentScope);
const agents = discovery.agents;
const confirmProjectAgents = params.confirmProjectAgents ?? true;

const tasks = params.tasks;
if (!tasks || tasks.length === 0) {
	const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
	return {
		content: [{ type: "text", text: `Provide a non-empty 'tasks' array.\nAvailable agents: ${available}` }],
		details: { agentScope, projectAgentsDir: discovery.projectAgentsDir, results: [] },
	};
}

if (tasks.length > MAX_PARALLEL_TASKS) {
	return {
		content: [{ type: "text", text: `Too many tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
		details: { agentScope, projectAgentsDir: discovery.projectAgentsDir, results: [] },
	};
};

const isAsync = params.async ?? true;
const keepAlive = params.keepAlive ?? false;

// Project agent confirmation
if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
	const requestedAgentNames = new Set(tasks.map((t) => t.agent));
	const projectAgentsRequested = Array.from(requestedAgentNames)
		.map((name) => agents.find((a) => a.name === name))
		.filter((a): a is AgentConfig => a?.source === "project");

	if (projectAgentsRequested.length > 0) {
		const names = projectAgentsRequested.map((a) => a.name).join(", ");
		const dir = discovery.projectAgentsDir ?? "(unknown)";
		const ok = await ctx.ui.confirm(
			"Run project-local agents?",
			`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
		);
		if (!ok)
			return {
				content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
				details: { agentScope, projectAgentsDir: discovery.projectAgentsDir, results: [] },
			};
	}
}

// Check capacity
const currentTotal = getActiveRunCount() + getPoolSize();
if (currentTotal + tasks.length > MAX_TOTAL_CHILDREN) {
	return {
		content: [{ type: "text", text: `Not enough capacity. Active: ${currentTotal}, requested: ${tasks.length}, max: ${MAX_TOTAL_CHILDREN}. Release or abort some runs first.` }],
		details: { agentScope, projectAgentsDir: discovery.projectAgentsDir, results: [] },
		isError: true,
	};
}

// ── Async mode: fire-and-forget ──
if (isAsync) {
	const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t) => {
		return await launchAgent(ctx.cwd, agents, t.agent, t.task, t.cwd, signal, keepAlive);
	});

	const lines = results.map((r) => {
		const runId = r.errorMessage?.match(/Run ID: ([\w-]+)/)?.[1] ?? "?";
		const status = r.exitCode === EXIT_CODE_PENDING ? "launched" : "failed";
		return `- [${r.agent}] → ${runId} (${status})`;
	});
	return {
		content: [{ type: "text", text: `Launched ${results.length} task(s). Use subagent_status to track.\n${lines.join("\n")}` }],
		details: { agentScope, projectAgentsDir: discovery.projectAgentsDir, results },
	};
}

// ── Sync mode: block until all complete ──
const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t) => {
	// Create session + start
	const agent = agents.find((a) => a.name === t.agent);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: t.agent,
			agentSource: "unknown" as const,
			task: t.task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${t.agent}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const session = new RpcSession({
		cwd: t.cwd ?? ctx.cwd,
		env: {
			SUBAGENT_CHILD: "1",
			SUBAGENT_DEPTH: String(parseInt(process.env.SUBAGENT_DEPTH || "0", 10) + 1),
		},
		model: agent.model,
		tools: agent.tools,
		systemPrompt: agent.systemPrompt,
		args: ["-p"],
		childExtensionPath: path.join(ctx.cwd, ".pi", "extensions", "subagent", "index.ts"),
	});

	try {
		await session.start();
	} catch (err: any) {
		return {
			agent: t.agent,
			agentSource: agent.source,
			task: t.task,
			exitCode: 1,
			messages: [],
			stderr: `Failed to start RPC session: ${err.message}`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const runId = randomUUID();
	const runInfo: AsyncRunInfo = {
		id: runId,
		agent: t.agent,
		task: t.task,
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

	registerRun(runInfo);
	session.prompt(`Task: ${t.task}`);

	return await runAgent(session, runInfo, keepAlive);
});

// Find any pooled runIds
const lastPooled = results.find((r) => r.runId);

return {
	content: [{ type: "text", text: results.map((r) => getFinalOutput(r.messages) || "(no output)").join("\n\n---\n\n") }],
	details: {
		agentScope,
		projectAgentsDir: discovery.projectAgentsDir,
		results,
		runId: lastPooled?.runId,
	},
};
```

- [ ] **Step 2d: Update subagent tool description**

Replace the current `description` array (lines 565-572) with:

```typescript
description: [
	"Delegate tasks to specialized subagents with isolated context.",
	"Provide a 'tasks' array of {agent, task} to dispatch.",
	"async=true (default): returns run IDs immediately. Poll with subagent_status.",
	"async=false: blocks until all tasks complete, returns full results.",
	"keepAlive=true: keeps child sessions alive for follow-up via action='resume'.",
	"Actions: run (default), resume (continue idle session), release (destroy idle session).",
	'Default agent scope is "user" (from ~/.pi/agent/agents).',
	'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
].join(" "),
```

- [ ] **Step 2e: Simplify renderCall**

Replace the entire `renderCall` method. Remove chain rendering, simplify single/parallel into one path:

```typescript
renderCall(args, theme, _context) {
	// Action routing display
	if (args.action === "resume") {
		const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", "resume") +
			theme.fg("dim", ` ${args.runId}`);
		text += `\n  ${theme.fg("dim", preview)}`;
		if (args.keepAlive) text += theme.fg("muted", " [keep-alive]");
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

	const scope: AgentScope = args.agentScope ?? "user";
	const tasks = args.tasks ?? [];
	const count = tasks.length;

	if (count === 0) {
		return new Text(
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("muted", `[${scope}] no tasks`),
			0, 0,
		);
	}

	if (count === 1) {
		const t = tasks[0];
		const preview = t.task.length > 60 ? `${t.task.slice(0, 60)}...` : t.task;
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", t.agent) +
			theme.fg("muted", ` [${scope}]`);
		text += `\n  ${theme.fg("dim", preview)}`;
		if (args.keepAlive) text += theme.fg("muted", " [keep-alive]");
		if (args.async === false) text += theme.fg("muted", " [sync]");
		return new Text(text, 0, 0);
	}

	// Multi-task
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", `${count} tasks`) +
		theme.fg("muted", ` [${scope}]`);
	if (args.keepAlive) text += theme.fg("muted", " [keep-alive]");
	if (args.async === false) text += theme.fg("muted", " [sync]");
	for (const t of tasks.slice(0, 3)) {
		const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
		text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
	}
	if (count > 3) text += `\n  ${theme.fg("muted", `... +${count - 3} more`)}`;
	return new Text(text, 0, 0);
},
```

- [ ] **Step 2f: Simplify renderResult**

Replace the entire `renderResult` method. Remove chain and parallel specific branches. The new renderer uses `results.length` to decide layout:

```typescript
renderResult(result, { expanded }, theme, _context) {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();
	const results = details.results;

	const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
		const toShow = limit ? items.slice(-limit) : items;
		const skipped = limit && items.length > limit ? items.length - limit : 0;
		let text = "";
		if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
		for (const item of toShow) {
			if (item.type === "text") {
				const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
				text += `${theme.fg("toolOutput", preview)}\n`;
			} else {
				text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
			}
		}
		return text.trimEnd();
	};

	const aggregateUsage = (res: SingleResult[]) => {
		const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
		for (const r of res) {
			total.input += r.usage.input;
			total.output += r.usage.output;
			total.cacheRead += r.usage.cacheRead;
			total.cacheWrite += r.usage.cacheWrite;
			total.cost += r.usage.cost;
			total.contextTokens += r.usage.contextTokens || 0;
			total.turns += r.usage.turns;
		}
		return total;
	};

	// Single result
	if (results.length === 1) {
		const r = results[0];
		const isPending = r.exitCode === EXIT_CODE_PENDING;
		const isError = isFailedResult(r);
		const icon = isPending ? theme.fg("accent", "⏳") : isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const displayItems = getDisplayItems(r.messages);
		const finalOutput = getFinalOutput(r.messages);

		if (expanded) {
			const container = new Container();
			let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
			if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
			if (isPending && r.errorMessage) header += ` ${theme.fg("accent", `→ ${r.errorMessage}`)}`;
			container.addChild(new Text(header, 0, 0));
			if (isError && r.errorMessage && !isPending)
				container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
			container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
			if (displayItems.length === 0 && !finalOutput) {
				container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
			} else {
				for (const item of displayItems) {
					if (item.type === "toolCall")
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0, 0,
							),
						);
				}
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}
			}
			const usageStr = formatUsageStats(r.usage, r.model);
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
			}
			if (details.runId) {
				container.addChild(new Text(theme.fg("accent", `run: ${details.runId} (idle)`), 0, 0));
			}
			return container;
		}

		let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
		if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		if (isPending && r.errorMessage) text += `\n${theme.fg("accent", r.errorMessage)}`;
		else if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
		else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
		else {
			text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
			if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		}
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
		if (details.runId) text += `\n${theme.fg("accent", `run: ${details.runId} (idle)`)}`;
		return new Text(text, 0, 0);
	}

	// Multi-result (parallel)
	const running = results.filter((r) => r.exitCode === EXIT_CODE_PENDING).length;
	const successCount = results.filter((r) => r.exitCode !== EXIT_CODE_PENDING && !isFailedResult(r)).length;
	const failCount = results.filter((r) => r.exitCode !== EXIT_CODE_PENDING && isFailedResult(r)).length;
	const isRunning = running > 0;
	const icon = isRunning
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");
	const status = isRunning
		? `${successCount + failCount}/${results.length} done, ${running} running`
		: `${successCount}/${results.length} tasks`;

	if (expanded && !isRunning) {
		const container = new Container();
		container.addChild(
			new Text(`${icon} ${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", status)}`, 0, 0),
		);

		for (const r of results) {
			const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const displayItems = getDisplayItems(r.messages);
			const finalOutput = getFinalOutput(r.messages);

			container.addChild(new Spacer(1));
			container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`, 0, 0));
			container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

			for (const item of displayItems) {
				if (item.type === "toolCall") {
					container.addChild(
						new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
					);
				}
			}

			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}

			const taskUsage = formatUsageStats(r.usage, r.model);
			if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
		}

		const usageStr = formatUsageStats(aggregateUsage(results));
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
		}
		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", status)}`;
	for (const r of results) {
		const rIcon =
			r.exitCode === EXIT_CODE_PENDING
				? theme.fg("warning", "⏳")
				: isFailedResult(r)
					? theme.fg("error", "✗")
					: theme.fg("success", "✓");
		const displayItems = getDisplayItems(r.messages);
		text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
		if (displayItems.length === 0)
			text += `\n${theme.fg("muted", r.exitCode === EXIT_CODE_PENDING ? "(running...)" : "(no output)")}`;
		else text += `\n${renderDisplayItems(displayItems, 5)}`;
	}
	if (!isRunning) {
		const usageStr = formatUsageStats(aggregateUsage(results));
		if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
	}
	if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
},
```

- [ ] **Step 2g: Remove unused imports/variables**

Remove: `ChainItem` schema (no longer used), `OnUpdateCallback` import (no longer used in new code — only used in resume path which still exists but doesn't need the import separately).

Remove the `truncateParallelOutput` function if it's no longer referenced (it was used by the old parallel mode).

- [ ] **Step 2h: Run typecheck + tests**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: 0 tsc errors, all tests pass (existing tests for run-registry, session-pool, event-accumulator, guards, agents should still pass since they don't depend on tool.ts).

- [ ] **Step 2i: Commit**

```bash
git add src/extension/tool.ts
git commit -m "refactor: unified subagent dispatch — remove single/chain/parallel modes

- New schema: tasks[] always, async boolean, keepAlive per-task
- Split runSingleAgent into launchAgent (fire-and-forget) + runAgent (block)
- Remove chain mode + {previous} substitution
- Remove mode field from SubagentDetails
- Simplify renderCall/renderResult: single path vs multi-path
- Parent LLM emulates chains via sequential calls"
```

---

### Task 3: Update parent prompt + skill docs

**Files:**
- Modify: `.pi/prompts/parent.md`
- Modify: `.pi/skills/subagent/SKILL.md`

- [ ] **Step 3a: Update `.pi/prompts/parent.md`**

```markdown
---
description: Start a parent agent session
---

You are the parent session. Keep the main context clean. Use official Pi capabilities first. When a task benefits from isolated work, call `subagent` with `agent: "worker"` and a bounded task. Do not use third-party subagent runtimes.

## Subagent Tool

**Actions:**
- `action: "run"` (default) — Dispatch one or more tasks via `tasks: [{agent, task}]`.
  - `async: true` (default) — Returns run IDs immediately. Poll with `subagent_status`.
  - `async: false` — Blocks until all tasks complete.
  - `keepAlive: true` — Keeps child sessions alive for later `resume`.
- `action: "resume"` — Resume a kept-alive session with a follow-up task.
- `action: "release"` — Release a kept-alive session.

**Sequential workflows:** For multi-step tasks that need intermediate decisions, make sequential `subagent` calls. The parent decides whether to continue, modify, or stop after each result.

## Monitoring Tools

- `subagent_status` — Check run progress or list all active runs. Shows pending decisions.
- `subagent_steer` — Send a mid-run steering message to redirect an agent.
- `subagent_respond` — Answer a pending decision from a child (contact_supervisor).
- `subagent_abort` — Abort a running subagent immediately.

## Guidelines

1. Delegate only bounded tasks.
2. Use only `agent: "worker"` in V1.
3. Do not ask the child to start more subagents.
4. Poll `subagent_status` periodically for async runs.
5. If a child has a pending decision, respond via `subagent_respond` promptly.
6. Before completion, verify the child result in the parent session.
7. Release kept-alive sessions when done (max 8 concurrent child processes).
```

- [ ] **Step 3b: Update `.pi/skills/subagent/SKILL.md`**

```markdown
---
name: subagent
description: Delegate tasks to isolated child Pi processes with session resume support.
---

# Subagent Workflow

Use this workflow when a task should be delegated to an isolated child Pi process.

## Dispatch

```
subagent({ tasks: [{ agent: "worker", task: "..." }] })
```

- `async: true` (default) — Returns run IDs immediately. Poll with `subagent_status`.
- `async: false` — Blocks until all tasks complete, returns full results.
- `keepAlive: true` — Keeps child sessions alive for follow-up.

Multiple tasks run in parallel:
```
subagent({ tasks: [
  { agent: "worker", task: "task A" },
  { agent: "worker", task: "task B" },
] })
```

## Session Resume

Set `keepAlive: true` to keep the child session alive after completion.
- Later: `action: "resume"` with `runId` + `task` to continue the session.
- Done: `action: "release"` with `runId` to free the child process.

## Sequential Workflows

For multi-step tasks, make sequential `subagent` calls. The parent sees each result and decides whether to continue:
```
subagent({ tasks: [{ agent: "researcher", task: "investigate X" }], async: false })
// → see result, decide next step
subagent({ tasks: [{ agent: "coder", task: "implement based on: <result>" }], async: false })
```

## Monitoring

- `subagent_status` — Check progress, list active runs, see pending decisions.
- `subagent_steer` — Redirect a running agent mid-turn.
- `subagent_respond` — Answer a child's decision request (via contact_supervisor).
- `subagent_abort` — Kill a running subagent immediately.

## Guidelines

1. Keep the parent session responsible for user communication, decisions, and final verification.
2. Delegate only bounded tasks to `subagent`.
3. Use only `agent: "worker"` in V1.
4. Do not ask the child to start more subagents.
5. Treat pending decisions as high priority — respond via `subagent_respond` promptly.
6. Before completion, verify the child result in the parent session.
7. Release kept-alive sessions when done to free child process slots (max 8 concurrent).
```

- [ ] **Step 3c: Commit**

```bash
git add .pi/prompts/parent.md .pi/skills/subagent/SKILL.md
git commit -m "docs: update parent prompt + skill for unified subagent dispatch"
```

---

### Task 4: Final verification

**Files:** none

- [ ] **Step 4a: Full typecheck + test suite**

Run: `npm run check`
Expected: 0 tsc errors, all tests pass.

- [ ] **Step 4b: Smoke test — single task async**

Run the existing `smoke-async.ts` script (update it if needed to use new `tasks` schema):

```bash
npx tsx scripts/smoke-async.ts
```

Expected: task launched, run ID returned, poll works, status shows completion.

- [ ] **Step 4c: Smoke test — single task sync**

Run the existing `smoke-rpc.ts` script (update if needed to use new schema with `async: false`):

```bash
npx tsx scripts/smoke-rpc.ts
```

Expected: blocks until completion, returns full result.

- [ ] **Step 4d: Commit smoke test updates if needed**

```bash
git add scripts/
git commit -m "test: update smoke tests for unified subagent dispatch"
```
