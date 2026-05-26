/**
 * Pure function to accumulate agent run results from RPC event stream.
 *
 * Handles RPC-specific events (no tool_result_end; uses tool_execution_end + message_end).
 * Testable without any process or RPC mocking.
 */

import type { AccumulatedResult, UsageStats, RpcEvent } from "./types.ts";

/** Create an empty accumulated result */
function emptyResult(): AccumulatedResult {
  return {
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    stderr: "",
  };
}

/** Add usage from a message's usage field into the accumulator */
function accumulateUsage(usage: UsageStats, msgUsage: any): void {
  if (!msgUsage) return;
  usage.input += msgUsage.input ?? 0;
  usage.output += msgUsage.output ?? 0;
  usage.cacheRead += msgUsage.cacheRead ?? 0;
  usage.cacheWrite += msgUsage.cacheWrite ?? 0;
  usage.cost += msgUsage.cost ?? 0;
  usage.contextTokens += msgUsage.contextTokens ?? 0;
}

/**
 * Accumulate a single RPC event into the result.
 * Returns the updated result (mutates in place for efficiency).
 */
export function accumulateEvent(result: AccumulatedResult, event: RpcEvent): AccumulatedResult {
  switch (event.type) {
    case "message_end": {
      if (event.message) {
        result.messages.push(event.message);

        // Accumulate usage and metadata from assistant messages
        if (event.message.role === "assistant") {
          result.usage.turns++;
          accumulateUsage(result.usage, event.message.usage);
          if (event.message.model) result.model = event.message.model;
          if (event.message.stopReason) result.stopReason = event.message.stopReason;
          if (event.message.errorMessage) result.errorMessage = event.message.errorMessage;
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
      if (event.messages && Array.isArray(event.messages)) {
        // Don't overwrite — messages already accumulated via message_end events
      }
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
export function getFinalOutput(messages: any[]): string {
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
