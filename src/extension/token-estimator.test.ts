import { describe, expect, it } from "vitest";
import { estimateTextTokens, estimateMessagesTokens } from "./token-estimator.ts";
import type { ContextMessage } from "./types.ts";

function user(text: string): ContextMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as ContextMessage;
}

describe("estimateTextTokens", () => {
  it("returns 0 for empty strings", () => {
    expect(estimateTextTokens("")).toBe(0);
  });

  it("uses a conservative latin character heuristic", () => {
    expect(estimateTextTokens("hello world")).toBeGreaterThanOrEqual(2);
    expect(estimateTextTokens("hello world")).toBeLessThanOrEqual(4);
  });

  it("counts CJK characters closer to one token each", () => {
    expect(estimateTextTokens("你好世界")).toBeGreaterThanOrEqual(3);
  });
});

describe("estimateMessagesTokens", () => {
  it("sums text content and per-message overhead", () => {
    const total = estimateMessagesTokens([user("hello"), user("world")]);
    expect(total).toBeGreaterThan(2);
  });
});
