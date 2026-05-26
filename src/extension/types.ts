/**
 * Type definitions for the subagent extension.
 * Aligned with the official Pi subagent demo's types.
 */

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
  messages: any[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

/** Details payload for the tool result (supports single/parallel/chain) */
export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

/** Agent discovery scope */
export type AgentScope = "user" | "project" | "both";

/** Callback for streaming updates during agent execution */
export type OnUpdateCallback = (partial: any) => void;

/**
 * Accumulated result from RPC event stream parsing.
 * Internal representation before conversion to SingleResult.
 */
export interface AccumulatedResult {
  messages: any[];
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
  | { type: "response"; command: string; success: boolean; data?: any; error?: string; id?: string }
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: any[]; willRetry?: boolean }
  | { type: "message_start"; message?: any }
  | { type: "message_update"; message?: any; assistantMessageEvent?: any }
  | { type: "message_end"; message?: any }
  | { type: "tool_execution_start"; toolCallId?: string; toolName?: string; args?: string }
  | { type: "tool_execution_update"; toolCallId?: string; toolName?: string; args?: string; partialResult?: string }
  | { type: "tool_execution_end"; toolCallId?: string; toolName?: string; result?: string; isError?: boolean }
  | { type: "extension_ui_request"; id: string; method: string; [key: string]: any }
  | { type: string; [key: string]: any }; // fallback for unknown events
