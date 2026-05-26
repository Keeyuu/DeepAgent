/**
 * Pure function to accumulate agent run results from RPC event stream.
 *
 * Handles RPC-specific events (no tool_result_end; uses tool_execution_end + message_end).
 * Testable without any process or RPC mocking.
 */

import type { AccumulatedResult, UsageStats, RpcEvent, Message } from "./types.ts";

/** Create an empty accumulated result */
function emptyResult(): AccumulatedResult {
  return {
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    stderr: "",
  };
}

/** Minimal usage shape expected from Pi message events */
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number | { total?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  contextTokens?: number;
}

/** Add usage from a message's usage field into the accumulator */
function accumulateUsage(usage: UsageStats, msgUsage: PiUsage | undefined): void {
  if (!msgUsage) return;
  usage.input += msgUsage.input ?? 0;
  usage.output += msgUsage.output ?? 0;
  usage.cacheRead += msgUsage.cacheRead ?? 0;
  usage.cacheWrite += msgUsage.cacheWrite ?? 0;
  usage.cost += typeof msgUsage.cost === "number" ? msgUsage.cost : (msgUsage.cost as { total?: number })?.total ?? 0;
  usage.contextTokens += msgUsage.contextTokens ?? 0;
}

/**
 * Accumulate a single RPC event into the result.
 * Returns the updated result (mutates in place for efficiency).
 */
export function accumulateEvent(result: AccumulatedResult, event: RpcEvent): AccumulatedResult {
  switch (event.type) {
    case "message_end": {
      const msg = (event as { type: "message_end"; message?: Message }).message;
      if (msg) {
        result.messages.push(msg);

        // Accumulate usage and metadata from assistant messages
        if (msg.role === "assistant") {
          result.usage.turns++;
          accumulateUsage(result.usage, msg.usage);
          if (msg.model) result.model = msg.model;
          if (msg.stopReason) result.stopReason = msg.stopReason;
          if (msg.errorMessage) result.errorMessage = msg.errorMessage;
        }
      }
      break;
    }

    case "tool_execution_end": {
      // RPC mode uses tool_execution_end with result and isError fields
      // (unlike --mode json which uses tool_result_end)
      // We don't push tool results as messages — message_end with role "toolResult" handles that
      break;
    }

    case "message_update": {
      // Streaming text delta — handled by onUpdate callback in runSingleAgent, not accumulated here
      break;
    }

    case "agent_end": {
      // Terminal event. agent_end may carry final messages array.
      // Don't overwrite — messages already accumulated via message_end events
      break;
    }

    case "agent_start":
    case "message_start":
    case "tool_execution_start":
    case "tool_execution_update":
      // These events don't contribute to the final accumulated result
      break;

    default:
      // Unknown events are ignored
      break;
  }

  return result;
}

/**
 * Accumulate all events from an RPC session into a final result.
 * Pure function — takes an array of events, returns the accumulated result.
 */
export function accumulateResultFromEvents(events: RpcEvent[]): AccumulatedResult {
  const result = emptyResult();
  for (const event of events) {
    accumulateEvent(result, event);
  }
  return result;
}

/**
 * Get the last assistant text from accumulated messages.
 * Mirrors official demo's getFinalOutput().
 */
export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          return part.text;
        }
      }
    }
  }
  return "";
}
