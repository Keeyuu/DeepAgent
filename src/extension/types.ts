/**
 * Type definitions for the subagent extension.
 * Aligned with the official Pi subagent demo's types.
 */

import type { Message } from "@earendil-works/pi-ai";
export type { Message };
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
export type { AgentToolResult };

/** Agent configuration loaded from .pi/agents/*.md */
export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  filePath: string;
  source: "user" | "project" | "unknown";
}

/** Token and cost usage statistics for a single agent run */
export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** Display item extracted from assistant messages for rendering */
export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, any> };

/** Result from a single agent run */
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
  step?: number;
  runId?: string; // present when session is pooled (keepAlive)
}

/** Details payload for the tool result (supports single/parallel/chain) */
export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
  runId?: string; // present when keepAlive: true or action: "resume"
}

/** Agent discovery scope */
export type AgentScope = "user" | "project" | "both";

/** Callback for streaming updates during agent execution */
export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Accumulated result from RPC event stream parsing.
 * Internal representation before conversion to SingleResult.
 */
export interface AccumulatedResult {
  messages: Message[];
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  stderr: string;
}

/**
 * A single JSONL event from the RPC stdout stream.
 * Three categories: responses, agent events, and extension UI requests.
 */
export type RpcEvent =
  | { type: "response"; command: string; success: boolean; data?: unknown; error?: string; id?: string }
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: Message[]; willRetry?: boolean }
  | { type: "message_start"; message?: Message }
  | { type: "message_update"; message?: Message; assistantMessageEvent?: Record<string, unknown> }
  | { type: "message_end"; message?: Message }
  | { type: "tool_execution_start"; toolCallId?: string; toolName?: string; args?: string }
  | { type: "tool_execution_update"; toolCallId?: string; toolName?: string; args?: string; partialResult?: string }
  | { type: "tool_execution_end"; toolCallId?: string; toolName?: string; result?: string; isError?: boolean }
  | { type: "extension_ui_request"; id: string; method: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown }; // fallback for unknown events

/** Status of an async subagent run */
export type RunStatus = "running" | "completed" | "failed" | "aborted";

/** Pending decision request from a child subagent (via extension_ui_request) */
export interface PendingDecision {
  /** The UI request ID to respond to */
  requestId: string;
  /** The child's question/message */
  message: string;
  /** Available options (if any) */
  options?: string[];
  /** Default value (if any) */
  defaultValue?: string;
  /** Timestamp when the request was received */
  requestedAt: number;
}

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
  /** Live RPC session (typed as unknown to avoid circular imports with rpc-session.ts) */
  session: unknown;
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
  /** Pending decision request from child (if any, async mode only) */
  pendingDecision?: PendingDecision;
}
