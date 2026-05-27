import { describe, expect, it } from "vitest";
import { applyContextLens, calculateLensSourceFingerprint, resolveLatestLensCommand } from "./context-lens.ts";
import type { ContextLens, ContextLensCommand, ContextMessage } from "./types.ts";

function user(text: string): ContextMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as ContextMessage;
}

function lens(raw: readonly ContextMessage[] = []): ContextLens {
  const compressedThroughMessageCount = 2;
  return {
    version: 1,
    id: "lens-reentry",
    summary: "Recovered summary",
    params: { focus: "state", filter: "noise", guideline: "keep decisions", retainRecentTurns: 2 },
    compressedThroughMessageCount,
    sourceFingerprint: calculateLensSourceFingerprint(raw, compressedThroughMessageCount),
    retainedMessageCountAtCreation: 2,
    rawTokensAtCreation: 100,
    lensTokensAtCreation: 20,
    createdAt: 1,
    updatedAt: 1,
  };
}

function lensToolResult(command: ContextLensCommand): ContextMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "compress",
    content: [{ type: "text", text: "lens created" }],
    details: { contextLens: command },
    isError: false,
    timestamp: command.createdAt,
  } as ContextMessage;
}

describe("context lens re-entry", () => {
  it("reconstructs active lens from persisted tool result details", () => {
    const prefix = [
      user("old 1"),
      user("old 2"),
    ];
    const raw = [
      ...prefix,
      lensToolResult({ version: 1, command: "activate", lens: lens(prefix), createdAt: 2 }),
      user("new 1"),
    ];
    const active = resolveLatestLensCommand(raw)?.lens;
    expect(active?.id).toBe("lens-reentry");
    expect(applyContextLens(raw, active!)[0]).toMatchObject({ role: "user" });
  });

  it("keeps a later clear command authoritative after re-entry", () => {
    const raw = [
      lensToolResult({ version: 1, command: "activate", lens: lens(), createdAt: 2 }),
      lensToolResult({ version: 1, command: "clear", lensId: "lens-reentry", createdAt: 3 }),
    ];
    expect(resolveLatestLensCommand(raw)?.command).toBe("clear");
  });
});
