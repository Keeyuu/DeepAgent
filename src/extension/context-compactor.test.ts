import { describe, expect, it } from "vitest";
import { buildLensPrompt, renderLensPrompt, summarizeForLens } from "./context-compactor.ts";
import type { CompressParams, ContextMessage } from "./types.ts";

const params: Required<CompressParams> = {
  focus: "architecture decisions",
  filter: "verbose logs",
  guideline: "preserve blockers",
  retainRecentTurns: 3,
};

function user(text: string): ContextMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as ContextMessage;
}

describe("renderLensPrompt", () => {
  it("renders all placeholders", () => {
    const result = renderLensPrompt("Keep {{focus}} / Drop {{filter}} / Rule {{guideline}}", params);
    expect(result).toBe("Keep architecture decisions / Drop verbose logs / Rule preserve blockers");
  });
});

describe("buildLensPrompt", () => {
  it("includes serialized message text", () => {
    const prompt = buildLensPrompt("Prompt", [user("important decision")]);
    expect(prompt).toContain("Prompt");
    expect(prompt).toContain("important decision");
  });
});

describe("summarizeForLens", () => {
  it("uses injected completion and returns its text", async () => {
    const summary = await summarizeForLens({
      messages: [user("decision")],
      params,
      promptTemplate: "Keep {{focus}}",
      completeText: async (prompt) => `summary from: ${prompt}`,
    });
    expect(summary).toContain("summary from:");
    expect(summary).toContain("architecture decisions");
  });
});
