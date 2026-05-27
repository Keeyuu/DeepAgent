/**
 * Subagent Extension — Delegate tasks to specialized agents.
 *
 * Based on the official Pi subagent demo, with:
 * - RPC transport (replaces --mode json spawn)
 * - contact_supervisor tool for child-to-parent communication
 * - renderCall/renderResult for rich TUI display
 *
 * When SUBAGENT_CHILD=1, registers only contact_supervisor (not subagent).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";
import { randomUUID } from "node:crypto";
import { accumulateEvent, getFinalOutput } from "./event-accumulator.ts";
import type {
	AgentConfig,
	AgentScope,
	AccumulatedResult,
	AsyncRunInfo,
	DisplayItem,
	SingleResult,
	SubagentDetails,
	UsageStats,
} from "./types.ts";
import { RpcSession } from "./rpc-session.ts";
import { registerRun, getRun, removeRun, getActiveRunCount, getAllRuns } from "./run-registry.ts";
import { addToPool, getFromPool, removeFromPool, updatePoolActivity, getPoolRunIds, getPoolSize, registerExitHandlers, MAX_TOTAL_CHILDREN } from "./session-pool.ts";
import { registerContextManagement } from "./context-tools.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const EXIT_CODE_PENDING = -1; // Signals a run is still in progress
const DEFAULT_IDLE_TIMEOUT_MS = 300_000; // 5 minutes

// ── Config ─────────────────────────────────────────────────────────────────

/** Read subagent config from .pi/settings.json */
function readSubagentConfig(cwd: string): { idleTimeoutMs: number } {
	try {
		// Walk up to find .pi/settings.json
		let dir = cwd;
		for (let i = 0; i < 20; i++) {
			const settingsPath = path.join(dir, ".pi", "settings.json");
			if (fs.existsSync(settingsPath)) {
				const raw = fs.readFileSync(settingsPath, "utf-8");
				const settings = JSON.parse(raw);
				return {
					idleTimeoutMs: settings.subagentIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
				};
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		// Ignore — use defaults
	}
	return { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS };
}

/** Module-level config, populated on extension init */
let subagentConfig = { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS };

// ── Formatting helpers ─────────────────────────────────────────────────────

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

// ── Display helpers ─────────────────────────────────────────────────────────

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function isFailedResult(result: SingleResult): boolean {
	if (result.exitCode === EXIT_CODE_PENDING) return false; // still running
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}


async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0; // Safe: JS is single-threaded, no real race on ++
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

// ── Schema definitions ─────────────────────────────────────────────────────

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	keepAlive: Type.Optional(Type.Boolean({ description: "Keep this child session alive after completion for follow-up via action='resume'. Default: false.", default: false })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const ActionSchema = StringEnum(["run", "resume", "release", "follow_up", "steer"] as const, {
	description: "Action: 'run' (default) = new tasks. 'resume' = restart idle session with prompt(). 'release' = destroy session. 'follow_up' = queue message on running session. 'steer' = interrupt running session.",
	default: "run",
});

const SubagentParams = Type.Object({
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} to dispatch for action='run'." })),
	agentScope: Type.Optional(AgentScopeSchema),
	action: Type.Optional(ActionSchema),
	runId: Type.Optional(Type.String({ description: "Session runId for resume/release actions" })),
	task: Type.Optional(Type.String({ description: "Task for resume action" })),
	keepAlive: Type.Optional(Type.Boolean({ description: "Keep session alive after resume completion (for action='resume'). Default: false.", default: false })),
});

const ContactSupervisorParams = Type.Object({
	type: Type.String({ description: "Type of communication: 'progress' for status updates, 'decision' for questions requiring supervisor's answer" }),
	message: Type.String({ description: "The message to send to the supervisor" }),
	options: Type.Optional(Type.Array(Type.String(), { description: "Available options for the supervisor to choose from (decision type only)" })),
});

// ── RPC-based agent runners ────────────────────────────────────────────────

/**
 * Launch a single agent via RPC session, fire-and-forget.
 * Registers the run and returns immediately with the run ID.
 * Auto-cleanup after 60s (non-keepAlive) or moves to pool on agent_end (keepAlive).
 */
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
		thinking: agent.thinking,
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

	// ── Register run ──
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

	// Wire up event accumulation
	const unsubEvents = session.onEvent((event) => {
		runInfo.events.push(event);
		runInfo.unsubEvents = unsubEvents;
		accumulateEvent(runInfo.accumulated, event);

		if (event.type === "agent_end") {
			runInfo.status = "completed";
			if (keepAlive && session.getExitCode() === null) {
				// Move session from registry to pool
				unsubEvents();
				removeRun(runId);
				try {
					addToPool(session, agentName, agent.source, runInfo.accumulated.usage, runId);
				} catch {
					// Pool full — stop session to avoid orphaned child process
					session.stop().catch(() => {});
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

	// Framework UI requests from child.
	session.onUIRequest((req) => {
		const fireAndForgetMethods = ["notify", "setStatus", "setTitle", "setWidget", "set_editor_text"];
		if (fireAndForgetMethods.includes(req.method)) return;
		runInfo.pendingDecision = {
			requestId: req.id,
			message: (req as Record<string, unknown>).message as string ?? (req as Record<string, unknown>).title as string ?? "Unknown request",
			requestedAt: Date.now(),
		};
	});

	// If process dies before agent_end (crash), clean up registry
	const unsubClose = session.onClose((code) => {
		if (runInfo.status === "running") {
			runInfo.status = code === 0 ? "completed" : "failed";
			unsubEvents();
			unsubClose();
			// Delayed cleanup for fire-and-forget runs
			setTimeout(() => {
				removeRun(runId);
				session.stop().catch(() => {});
			}, 5_000);
		}
	});

	// Wire abort signal
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



// ── Extension entry point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Load config from .pi/settings.json (parent mode only)
	if (process.env.SUBAGENT_CHILD !== "1") {
		// pi.cwd is available via the API but not typed — use process.cwd() fallback
		subagentConfig = readSubagentConfig(process.cwd());
		registerExitHandlers();
	}

	// ── CHILD MODE: register contact_supervisor only ──
	if (process.env.SUBAGENT_CHILD === "1") {
		pi.registerTool({
			name: "contact_supervisor",
			label: "Contact Supervisor",
			description: "Communicate with your supervisor. 'progress' sends a status update (no response expected). 'decision' asks a question — your run will pause and wait for the supervisor's answer before you continue.",
			parameters: ContactSupervisorParams,

			async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<undefined>> {
				if (params.type === "progress") {
					return {
						content: [{ type: "text", text: `[progress] ${params.message}` }],
						details: undefined,
					};
				}

				if (params.type === "decision") {
					// Decision request — use ctx.ui.input() as blocking transport.
					// Parent receives extension_ui_request via run registry, responds via subagent_respond.
					const opts = params.options?.length ? `\nOptions: ${params.options.join(", ")}` : "";
					const prompt = `${params.message}${opts}`;

					try {
						const response = await ctx.ui.input("Supervisor Decision", prompt);
						return {
							content: [{ type: "text", text: response ?? "No response from supervisor." }],
							details: undefined,
						};
					} catch {
						// Parent cancelled or timed out — end the run.
						return {
							content: [{ type: "text", text: `[decision-request] ${params.message}${opts}\nNo supervisor response received.` }],
							details: undefined,
							terminate: true,
						} as AgentToolResult<undefined>;
					}
				}

				return {
					content: [{ type: "text", text: `Unknown type: ${params.type}. Use 'progress' or 'decision'.` }],
					details: undefined,
					terminate: true,
				} as AgentToolResult<undefined>;
			},
		});
		registerContextManagement(pi);
		return;
	}

	// ── PARENT MODE: register subagent tool + /doctor command ──

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"action='run': provide tasks[] to launch. Returns run IDs immediately. Use subagent_status to track.",
			"action='resume': restart idle session (keepAlive) with prompt(). Requires runId + task.",
			"action='release': destroy idle session. Requires runId.",
			"action='steer': interrupt running session with message. Requires runId + task.",
			"action='follow_up': queue message on running session (non-interrupting). Requires runId + task.",
			"Use keepAlive on tasks to keep sessions alive for resume.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const action = params.action ?? "run";

			// Helper for simple text results
			const simpleResult = (text: string, isError = false) => ({
				content: [{ type: "text" as const, text }],
				details: undefined as SubagentDetails | undefined,
				...(isError ? { isError: true as const } : {}),
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

			// ── FOLLOW_UP action (queue message on running session) ──
			if (action === "follow_up") {
				if (!params.runId) return simpleResult("runId is required for follow_up action.", true);
				if (!params.task) return simpleResult("task is required for follow_up action.", true);
				const run = getRun(params.runId);
				if (!run) return simpleResult(`No active run with ID: ${params.runId}`, true);
				if (run.status !== "running") return simpleResult(`Run ${params.runId} is not running (status: ${run.status}). Use resume instead.`, true);
				const session = run.session as RpcSession;
				try {
					session.followUp(params.task);
				} catch (err: any) {
					return simpleResult(`Failed to follow up: ${err.message}`, true);
				}
				return simpleResult(`Follow-up queued for run ${params.runId}.`);
			}

			// ── STEER action (interrupt running session) ──
			if (action === "steer") {
				if (!params.runId) return simpleResult("runId is required for steer action.", true);
				if (!params.task) return simpleResult("task (message) is required for steer action.", true);
				const run = getRun(params.runId);
				if (!run) return simpleResult(`No active run with ID: ${params.runId}`, true);
				if (run.status !== "running") return simpleResult(`Run ${params.runId} is not running (status: ${run.status}).`, true);
				const session = run.session as RpcSession;
				try {
					session.steer(params.task);
				} catch (err: any) {
					return simpleResult(`Failed to steer: ${err.message}`, true);
				}
				return simpleResult(`Steering message sent to run ${params.runId}.`);
			}

			// ── RESUME action (async: prompt idle session, return runId immediately) ──
			if (action === "resume") {
				if (!params.runId) return simpleResult("runId is required for resume action.", true);
				if (!params.task) return simpleResult("task is required for resume action.", true);
				const pooled = getFromPool(params.runId);
				if (!pooled) return simpleResult(`No active session with runId "${params.runId}". Available: ${getPoolRunIds().join(", ") || "none"}`, true);

				if (!pooled.session.isAlive()) {
					removeFromPool(params.runId);
					return simpleResult(`Session ${params.runId} is dead (child process exited).`, true);
				}

				pooled.lastActivityAt = Date.now();
				const keepAlive = params.keepAlive ?? false;

				// Build run info for the registry
				const resumeRunInfo: AsyncRunInfo = {
					id: pooled.runId,
					agent: pooled.agent,
					task: params.task,
					status: "running",
					session: pooled.session,
					events: [],
					accumulated: { messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, stderr: "" },
					startedAt: Date.now(),
					agentSource: pooled.agentSource,
				};

				// Wire event accumulation + keepAlive/auto-cleanup on agent_end
				const unsubEvents = pooled.session.onEvent((event) => {
					resumeRunInfo.events.push(event);
					resumeRunInfo.unsubEvents = unsubEvents;
					accumulateEvent(resumeRunInfo.accumulated, event);

					if (event.type === "agent_end") {
						resumeRunInfo.status = "completed";
						removeFromPool(pooled.runId);
						if (keepAlive && pooled.session.getExitCode() === null) {
							// Re-pool for further resume
							unsubEvents();
							removeRun(pooled.runId);
							try { addToPool(pooled.session, pooled.agent, pooled.agentSource, resumeRunInfo.accumulated.usage, pooled.runId); } catch { pooled.session.stop().catch(() => {}); }
						} else {
							// Auto-cleanup 60s after completion
							setTimeout(() => { unsubEvents(); removeRun(pooled.runId); pooled.session.stop().catch(() => {}); }, 60_000);
						}
					}
				});

				// Wire onUIRequest for contact_supervisor — store as pendingDecision
				// Parent LLM responds via subagent_respond (same as launchAgent)
				pooled.session.onUIRequest((req) => {
					const ff = ["notify", "setStatus", "setTitle", "setWidget", "set_editor_text"];
					if (ff.includes(req.method)) return;
					resumeRunInfo.pendingDecision = {
						requestId: req.id,
						message: (req as Record<string, unknown>).message as string ?? (req as Record<string, unknown>).title as string ?? "Unknown request",
						requestedAt: Date.now(),
					};
				});

				// Wire onClose for crash detection
				const unsubClose = pooled.session.onClose((code) => {
					if (resumeRunInfo.status === "running") {
						resumeRunInfo.status = code === 0 ? "completed" : "failed";
						unsubEvents();
						unsubClose();
						removeFromPool(pooled.runId);
						setTimeout(() => { removeRun(pooled.runId); pooled.session.stop().catch(() => {}); }, 5_000);
					}
				});

				registerRun(resumeRunInfo);
				pooled.session.prompt(`Task: ${params.task}`);

				return {
					content: [{ type: "text", text: `Resumed ${pooled.runId}. Use subagent_status to track.` }],
					details: { agentScope: params.agentScope ?? "user" as AgentScope, projectAgentsDir: null, results: [{ agent: pooled.agent, agentSource: pooled.agentSource, task: params.task, exitCode: EXIT_CODE_PENDING, messages: [], stderr: "", usage: { ...pooled.usage }, errorMessage: `Resumed. Run ID: ${pooled.runId}` }] },
				};
			}
			// ── RUN action (default) ──
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

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
			}



			// Capacity check
			const currentTotal = getActiveRunCount() + getPoolSize();
			if (currentTotal + tasks.length > MAX_TOTAL_CHILDREN) {
				return {
					content: [{ type: "text", text: `Not enough capacity. Active: ${currentTotal}, requested: ${tasks.length}, max: ${MAX_TOTAL_CHILDREN}. Release or abort some runs first.` }],
					details: { agentScope, projectAgentsDir: discovery.projectAgentsDir, results: [] },
					isError: true,
				};
			}

			// Launch all tasks as async fire-and-forget
			const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t) => {
				return await launchAgent(ctx.cwd, agents, t.agent, t.task, t.cwd, signal, t.keepAlive ?? false);
			});
			const lines = results.map((r) => {
				const runId = r.errorMessage?.match(/Run ID: ([\w-]+)/)?.[1] ?? "?";
				return `- [${r.agent}] → ${runId}`;
			});
			return {
				content: [{ type: "text", text: `Launched ${results.length} task(s). Use subagent_status to track.\n${lines.join("\n")}` }],
				details: { agentScope, projectAgentsDir: discovery.projectAgentsDir, results },
			};
		},

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
			if (args.action === "follow_up") {
				const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", "follow_up") +
					theme.fg("dim", ` ${args.runId}\n  ${preview}`),
					0, 0,
				);
			}
			if (args.action === "steer") {
				const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("warning", "steer") +
					theme.fg("dim", ` ${args.runId}\n  ${preview}`),
					0, 0,
				);
			}

			const scope: AgentScope = args.agentScope ?? "user";
			const tasks = args.tasks;

			if (!tasks || tasks.length === 0) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("muted", "no tasks"),
					0, 0,
				);
			}

			if (tasks.length === 1) {
				const t = tasks[0];
				const preview = t.task.length > 60 ? `${t.task.slice(0, 60)}...` : t.task;
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", t.agent) +
					theme.fg("muted", ` [${scope}]`);
				text += `\n  ${theme.fg("dim", preview)}`;
				if (t.keepAlive) text += theme.fg("muted", " [keep-alive]");
				return new Text(text, 0, 0);
			}

			// N tasks
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", `${tasks.length} tasks`) +
				theme.fg("muted", ` [${scope}]`);
			for (const t of tasks.slice(0, 3)) {
				const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
				text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
			}
			if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
			const hasKeepAlive = tasks.some((t: any) => t.keepAlive);
			if (hasKeepAlive) text += theme.fg("muted", " [keep-alive]");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

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

			// Single result
			if (details.results.length === 1) {
				const r = details.results[0];
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
										0,
										0,
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

				// Compact collapsed view — summary only, expand for details
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isPending && r.errorMessage) {
					text += ` ${theme.fg("accent", r.errorMessage)}`;
				} else if (finalOutput) {
					// Show first 2 lines of final output
					const lines = finalOutput.split("\n").filter(l => l.trim()).slice(0, 2);
					text += `\n  ${theme.fg("dim", lines.join("\n  "))}`;
					if (finalOutput.split("\n").filter(l => l.trim()).length > 2) {
						text += ` ${theme.fg("muted", "(" + keyHint("app.tools.expand", "expand") + ")")}`;
					}
				} else if (isError && r.errorMessage) {
					text += `\n  ${theme.fg("error", r.errorMessage)}`;
				} else {
					text += ` ${theme.fg("muted", "(no output)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += ` ${theme.fg("dim", usageStr)}`;
				if (details.runId) text += ` ${theme.fg("accent", `[${details.runId}]`)}`;
				return new Text(text, 0, 0);
			}

			// Multiple results
			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
				for (const r of results) {
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

			const running = details.results.filter((r) => r.exitCode === EXIT_CODE_PENDING).length;
			const successCount = details.results.filter((r) => r.exitCode !== EXIT_CODE_PENDING && !isFailedResult(r)).length;
			const failCount = details.results.filter((r) => r.exitCode !== EXIT_CODE_PENDING && isFailedResult(r)).length;
			const isRunning = running > 0;
			const icon = isRunning
				? theme.fg("warning", "⏳")
				: failCount > 0
					? theme.fg("warning", "◐")
					: theme.fg("success", "✓");
			const status = isRunning
				? `${successCount + failCount}/${details.results.length} done, ${running} running`
				: `${successCount}/${details.results.length} tasks`;

			if (expanded && !isRunning) {
				const container = new Container();
				container.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold("tasks "))}${theme.fg("accent", status)}`,
						0,
						0,
					),
				);

				for (const r of details.results) {
					const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					const finalOutput = getFinalOutput(r.messages);

					container.addChild(new Spacer(1));
					container.addChild(
						new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
					);
					container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

					for (const item of displayItems) {
						if (item.type === "toolCall") {
							container.addChild(
								new Text(
									theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
									0,
									0,
								),
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

				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
				}
				return container;
			}

			// Compact collapsed view — one line per task
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("tasks "))}${theme.fg("accent", status)}`;
			for (const r of details.results) {
				const rIcon =
					r.exitCode === EXIT_CODE_PENDING
						? theme.fg("warning", "⏳")
						: isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
				const out = getFinalOutput(r.messages);
				const preview = out ? out.split("\n").filter((l: string) => l.trim()).slice(0, 1)[0] : undefined;
				const taskPreview = r.task.length > 40 ? r.task.slice(0, 40) + "..." : r.task;
				text += `\n  ${rIcon} ${theme.fg("accent", r.agent)} ${theme.fg("dim", taskPreview)}`;
				if (preview) text += ` — ${theme.fg("muted", preview.slice(0, 60))}`;
				else if (r.exitCode === EXIT_CODE_PENDING) text += ` ${theme.fg("muted", "(running)")}`;
			}
			if (!isRunning) {
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n  ${theme.fg("dim", usageStr)}`;
			}
			text += `\n  ${theme.fg("muted", "(" + keyHint("app.tools.expand", "expand") + ")")}`;
			return new Text(text, 0, 0);
		},
	});

	// ── Register subagent_status tool ──
	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: "Check the status of an async subagent run. Returns current progress, accumulated output, and usage stats. If no runId specified, lists all active runs.",
		parameters: Type.Object({
			runId: Type.Optional(Type.String({ description: "The run ID to check. If omitted, lists all active runs." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<undefined>> {
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
			if (run.pendingDecision) {
				const waitSec = Math.round((Date.now() - run.pendingDecision.requestedAt) / 1000);
				parts.push(`\n⏳ PENDING DECISION (waiting ${waitSec}s):`);
				parts.push(run.pendingDecision.message);
				parts.push("Use subagent_respond to answer.");
			}

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: undefined,
			};
		},
	});

	// ── Register subagent_respond tool ──
	pi.registerTool({
		name: "subagent_respond",
		label: "Subagent Respond",
		description: "Respond to a pending decision request from an async subagent. The child is blocked waiting for your response. Use subagent_status first to see the pending question.",
		parameters: Type.Object({
			runId: Type.String({ description: "The run ID that has a pending decision" }),
			response: Type.String({ description: "Your answer to the child's question" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<undefined>> {
			const run = getRun(params.runId);
			if (!run) {
				return {
					content: [{ type: "text", text: `No run found with ID: ${params.runId}.` }],
					details: undefined,
				};
			}
			if (!run.pendingDecision) {
				return {
					content: [{ type: "text", text: `Run ${params.runId} has no pending decision. Use subagent_status to check.` }],
					details: undefined,
				};
			}

			// Send response via extension_ui_response → child unblocks
			const session = run.session as RpcSession;
			try {
				session.respondToUIRequest(run.pendingDecision.requestId, { value: params.response });
			} catch {
				run.pendingDecision = undefined;
				return {
					content: [{ type: "text", text: `Failed to respond to run ${params.runId} — session may have already closed.` }],
					details: undefined,
				};
			}
			run.pendingDecision = undefined;

			return {
				content: [{ type: "text", text: `Decision response sent to run ${params.runId}. The child will continue with your answer.` }],
				details: undefined,
			};
		},
	});

	// ── Register subagent_abort tool ──
	pi.registerTool({
		name: "subagent_abort",
		label: "Subagent Abort",
		description: "Abort a running async subagent. Sends abort to the child process and removes it from the active runs registry.",
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

			// Unsubscribe event listeners first
			if (run.unsubEvents) run.unsubEvents();

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

	// ── Context management (parent mode) ──
	registerContextManagement(pi);

	// Register the `/doctor` command
	pi.registerCommand("doctor", {
		description: "Check subagent extension status",
		async handler(_args, ctx) {
			const discovery = discoverAgents(ctx.cwd, "both");
			const agentList = discovery.agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
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

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
