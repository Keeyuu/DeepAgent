import { describe, it, expect } from "vitest";
import { accumulateResultFromEvents, accumulateEvent, getFinalOutput } from "./event-accumulator.ts";
import type { Message, RpcEvent } from "./types.ts";

describe("accumulateResultFromEvents", () => {
  it("returns empty result for no events", () => {
    const result = accumulateResultFromEvents([]);
    expect(result.messages).toEqual([]);
    expect(result.usage.turns).toBe(0);
    expect(result.model).toBeUndefined();
    expect(result.stderr).toBe("");
  });

  it("accumulates assistant message from message_end", () => {
    const events: RpcEvent[] = [
      { type: "agent_start" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello world" }],
          usage: { input: 100, output: 50, cost: 0.01 },
          model: "test-model",
          stopReason: "endTurn",
        },
      },
      { type: "agent_end" },
    ];

    const result = accumulateResultFromEvents(events);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("assistant");
    expect(result.usage.turns).toBe(1);
    expect(result.usage.input).toBe(100);
    expect(result.usage.output).toBe(50);
    expect(result.usage.cost).toBe(0.01);
    expect(result.model).toBe("test-model");
    expect(result.stopReason).toBe("endTurn");
  });

  it("accumulates multiple assistant turns with usage aggregation", () => {
    const events: RpcEvent[] = [
      { type: "agent_start" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
          usage: { input: 100, output: 50 },
        },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tc1",
        toolName: "bash",
        result: "output",
        isError: false,
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second" }],
          usage: { input: 200, output: 100, cost: 0.02 },
        },
      },
      { type: "agent_end" },
    ];

    const result = accumulateResultFromEvents(events);
    expect(result.messages).toHaveLength(2);
    expect(result.usage.turns).toBe(2);
    expect(result.usage.input).toBe(300);
    expect(result.usage.output).toBe(150);
    expect(result.usage.cost).toBe(0.02);
  });

  it("ignores tool_execution_end events (not accumulated as messages)", () => {
    const events: RpcEvent[] = [
      {
        type: "tool_execution_end",
        toolCallId: "tc1",
        toolName: "bash",
        result: "some result",
        isError: false,
      },
    ];

    const result = accumulateResultFromEvents(events);
    expect(result.messages).toHaveLength(0);
  });

  it("handles message_end with toolResult role (RPC-specific)", () => {
    const events: RpcEvent[] = [
      {
        type: "message_end",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "tool output" }],
        },
      },
    ];

    const result = accumulateResultFromEvents(events);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("toolResult");
    // toolResult does NOT increment turns
    expect(result.usage.turns).toBe(0);
  });

  it("captures errorMessage from assistant message", () => {
    const events: RpcEvent[] = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          errorMessage: "context window exceeded",
          stopReason: "error",
        },
      },
    ];

    const result = accumulateResultFromEvents(events);
    expect(result.errorMessage).toBe("context window exceeded");
    expect(result.stopReason).toBe("error");
  });

  it("ignores unknown event types", () => {
    const events: RpcEvent[] = [
      { type: "unknown_event", data: "something" } as RpcEvent,
      { type: "another_unknown" } as RpcEvent,
    ];

    const result = accumulateResultFromEvents(events);
    expect(result.messages).toHaveLength(0);
  });

  it("handles cache usage fields", () => {
    const events: RpcEvent[] = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "cached" }],
          usage: { input: 100, output: 50, cacheRead: 80, cacheWrite: 20, contextTokens: 5000 },
        },
      },
    ];

    const result = accumulateResultFromEvents(events);
    expect(result.usage.cacheRead).toBe(80);
    expect(result.usage.cacheWrite).toBe(20);
    expect(result.usage.contextTokens).toBe(5000);
  });
});

describe("accumulateEvent", () => {
  it("mutates result in place and returns it", () => {
    const result = { messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, stderr: "" };
    const event: RpcEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "test" }],
        usage: { input: 10 },
      },
    };

    const returned = accumulateEvent(result, event);
    expect(returned).toBe(result); // same reference
    expect(result.messages).toHaveLength(1);
    expect(result.usage.input).toBe(10);
  });
});

describe("getFinalOutput", () => {
  it("returns last assistant text", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "first" }], api: "anthropic-messages", provider: "glm", model: "glm-5.1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "last" }], api: "anthropic-messages", provider: "glm", model: "glm-5.1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 },
    ] as Message[];

    expect(getFinalOutput(messages)).toBe("last");
  });

  it("returns empty string when no assistant messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
    ] as Message[];

    expect(getFinalOutput(messages)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(getFinalOutput([])).toBe("");
  });

  it("skips assistant messages with no text content", () => {
    const messages = [
      { role: "assistant", content: [{ type: "tool_use", name: "bash" }], api: "anthropic-messages", provider: "glm", model: "glm-5.1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "fallback" }], api: "anthropic-messages", provider: "glm", model: "glm-5.1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 },
    ] as Message[];

    expect(getFinalOutput(messages)).toBe("fallback");
  });
});
