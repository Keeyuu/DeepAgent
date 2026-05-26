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
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";
import { randomUUID } from "node:crypto";
import { accumulateResultFromEvents, accumulateEvent, getFinalOutput } from "./event-accumulator.ts";
import type {
	AgentConfig,
	AgentScope,
	AsyncRunInfo,
	DisplayItem,
	OnUpdateCallback,
	RpcEvent,
	RunStatus,
	SingleResult,
	SubagentDetails,
	UsageStats,
} from "./types.ts";
import { RpcSession } from "./rpc-session.ts";
import { registerRun, getRun, removeRun, getActiveRunCount, getAllRuns } from "./run-registry.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
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
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
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
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

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

const ContactSupervisorParams = Type.Object({
	type: Type.String({ description: "Type of communication: 'progress' for status updates, 'decision' for questions requiring supervisor's answer" }),
	message: Type.String({ description: "The message to send to the supervisor" }),
	options: Type.Optional(Type.Array(Type.String(), { description: "Available options for the supervisor to choose from (decision type only)" })),
});

// ── RPC-based agent runner ──────────────────────────────────────────────────

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
			step,
		};
	}

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

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
			...currentResult,
			exitCode: 1,
			stderr: `Failed to start RPC session: ${err.message}`,
		};
	}

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
				// Auto-cleanup after delay to allow status queries
				setTimeout(() => {
					removeRun(runId);
					session.stop().catch(() => {});
				}, 60_000);
			}
		});

		// Framework UI requests from child — async mode.
		// contact_supervisor(decision) uses ctx.ui.input() → triggers extension_ui_request.
		// Store as pending decision so parent LLM can respond via subagent_respond.
		session.onUIRequest((req) => {
			const fireAndForget = ["notify", "setStatus", "setTitle", "setWidget", "set_editor_text"];
			if (fireAndForget.includes(req.method)) return;
			runInfo.pendingDecision = {
				requestId: req.id,
				message: (req as Record<string, unknown>).message as string ?? (req as Record<string, unknown>).title as string ?? "Unknown request",
				requestedAt: Date.now(),
			};
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
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: agent.model,
			step,
			errorMessage: `Async run started. Run ID: ${runId}`,
		};
	}

	// Framework UI requests from child — sync mode.
	// contact_supervisor(decision) uses ctx.ui.input() → triggers extension_ui_request.
	// In sync mode, parent LLM is blocked waiting for tool result — auto-cancel.
	// Child falls back to default value.
	const uiUnsubscribe = session.onUIRequest((req) => {
		const fireAndForget = ["notify", "setStatus", "setTitle", "setWidget", "set_editor_text"];
		if (fireAndForget.includes(req.method)) return;
		session.respondToUIRequest(req.id, { cancelled: true });
	});

	// Track events for accumulation
	const events: RpcEvent[] = [];
	const eventUnsubscribe = session.onEvent((event) => {
		events.push(event);
		// Emit streaming updates
		const partial = accumulateResultFromEvents(events);
		currentResult.messages = partial.messages;
		currentResult.usage = partial.usage;
		currentResult.model = partial.model;
		currentResult.stopReason = partial.stopReason;
		currentResult.errorMessage = partial.errorMessage;
		emitUpdate();
	});

	let wasAborted = false;

	// Wire up abort signal
	if (signal) {
		const killSession = async () => {
			wasAborted = true;
			try { session.abort(); } catch { /* ignore */ }
			// Give it a moment, then force stop
			setTimeout(() => {
				try { session.stop(); } catch { /* ignore */ }
			}, 5000);
		};
		if (signal.aborted) killSession();
		else signal.addEventListener("abort", killSession, { once: true });
	}

	// Send the task as a prompt
	session.prompt(`Task: ${task}`);

	// Wait for agent to finish (idle heartbeat, configurable via subagentIdleTimeoutMs)
	try {
		await session.waitForIdle(subagentConfig.idleTimeoutMs);
	} catch (err: any) {
		// Idle timeout — child stopped producing events
		currentResult.exitCode = 1;
		currentResult.stderr = err.message;
	} finally {
		uiUnsubscribe();
		eventUnsubscribe();
	}

	// Final accumulation
	const final = accumulateResultFromEvents(events);
	currentResult.messages = final.messages;
	currentResult.usage = final.usage;
	currentResult.model = final.model ?? currentResult.model;
	currentResult.stopReason = final.stopReason ?? currentResult.stopReason;
	currentResult.errorMessage = final.errorMessage ?? currentResult.errorMessage;
	currentResult.stderr = session.getStderr();

	const exitCode = session.getExitCode();
	if (exitCode !== null) currentResult.exitCode = exitCode;

	// Clean up
	await session.stop();

	if (wasAborted) {
		throw new Error("Subagent was aborted");
	}

	return currentResult;
}

// ── Extension entry point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Load config from .pi/settings.json (parent mode only)
	if (process.env.SUBAGENT_CHILD !== "1") {
		// pi.cwd is available via the API but not typed — use process.cwd() fallback
		subagentConfig = readSubagentConfig(process.cwd());
	}

	// ── CHILD MODE: register contact_supervisor only ──
	if (process.env.SUBAGENT_CHILD === "1") {
		pi.registerTool({
			name: "contact_supervisor",
			label: "Contact Supervisor",
			description: "Communicate with your supervisor. 'progress' sends a status update (no response expected). 'decision' asks a question and waits for the supervisor's answer — you MUST wait for the response before continuing.",
			parameters: ContactSupervisorParams,

			async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<undefined>> {
				if (params.type === "progress") {
					return {
						content: [{ type: "text", text: `[progress] ${params.message}` }],
						details: undefined,
					};
				}

				if (params.type === "decision") {
					const opts = params.options?.length ? `\nOptions: ${params.options.join(", ")}` : "";
					const prompt = `${params.message}${opts}`;

					try {
						const response = await ctx.ui.input("Supervisor Decision", prompt, { signal });
						return {
							content: [{ type: "text", text: response ?? "No response from supervisor." }],
							details: undefined,
						};
					} catch {
						// Supervisor cannot respond (e.g. parent is blocked in sync mode).
						// This is a hard stop — tell the LLM it must decide on its own.
						return {
							content: [{ type: "text", text: `Supervisor is unavailable for real-time decisions. You must make this decision yourself based on available context. Do not call contact_supervisor with type 'decision' again for this task.` }],
							details: undefined,
						};
					}
				}

				return {
					content: [{ type: "text", text: `Unknown type: ${params.type}. Use 'progress' or 'decision'.` }],
					details: undefined,
					terminate: true,
				} as AgentToolResult<undefined>;
			},
		});
		return;
	}

	// ── PARENT MODE: register subagent tool + /doctor command ──

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

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
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			// ── Chain mode ──
			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [
						{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" },
					],
					details: makeDetails("chain")(results),
				};
			}

			// ── Parallel mode ──
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				const allResults: SingleResult[] = new Array(params.tasks.length);
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

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
					return {
						content: [{ type: "text", text: result.errorMessage || "Async run started." }],
						details: makeDetails("single")([result]),
					};
				}

				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
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

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
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
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

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

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
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

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
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
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
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

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

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
			session.respondToUIRequest(run.pendingDecision.requestId, { value: params.response });
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

	// Register the `/doctor` command
	pi.registerCommand("doctor", {
		description: "Check subagent extension status",
		async handler(_args, ctx) {
			const discovery = discoverAgents(ctx.cwd, "both");
			const agentList = discovery.agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			const activeAsyncRuns = getActiveRunCount();

			const lines = [
				"Subagent Extension",
				"extension: loaded",
				`agents: ${agentList}`,
				"transport: rpc (--mode rpc)",
				`active async runs: ${activeAsyncRuns}`,
				`config: idleTimeoutMs=${subagentConfig.idleTimeoutMs}`,
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
