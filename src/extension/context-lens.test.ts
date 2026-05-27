import { describe, expect, it } from "vitest";
import {
  applyContextLens,
  calculateLensBoundary,
  calculateLensSourceFingerprint,
  createLensSummaryMessage,
  isLensCursorValid,
  resolveLatestLensCommand,
  usageForMessages,
} from "./context-lens.ts";
import type { ContextLens, ContextLensCommand, ContextMessage } from "./types.ts";

function user(text: string): ContextMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as ContextMessage;
}

function toolResult(command: ContextLensCommand): ContextMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${command.createdAt}`,
    toolName: "compress",
    content: [{ type: "text", text: "context lens updated" }],
    details: { contextLens: command },
    isError: false,
    timestamp: command.createdAt,
  } as ContextMessage;
}

function lens(overrides: Partial<ContextLens> = {}, raw: readonly ContextMessage[] = []): ContextLens {
  const boundary = overrides.compressedThroughMessageCount ?? 3;
  return {
    version: 1,
    id: "lens-1",
    summary: "summary",
    params: { focus: "decisions", filter: "logs", guideline: "be concise", retainRecentTurns: 2 },
    compressedThroughMessageCount: boundary,
    sourceFingerprint: overrides.sourceFingerprint ?? calculateLensSourceFingerprint(raw, boundary),
    retainedMessageCountAtCreation: 2,
    rawTokensAtCreation: 100,
    lensTokensAtCreation: 20,
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

describe("applyContextLens", () => {
  it("keeps the lens summary plus raw messages after the stored boundary", () => {
    const raw = [user("a"), user("b"), user("c"), user("d"), user("e")];
    const activeLens = lens({}, raw);
    const view = applyContextLens(raw, activeLens);
    expect(view).toHaveLength(3);
    expect(view[0]).toEqual(createLensSummaryMessage(activeLens));
    expect(view[1]).toBe(raw[3]);
    expect(view[2]).toBe(raw[4]);
  });

  it("continues growing the retained tail on later calls", () => {
    const raw = [user("a"), user("b"), user("c"), user("d"), user("e"), user("f")];
    expect(applyContextLens(raw, lens({}, raw)).map((m) => (m as any).content?.[0]?.text)).toEqual([
      "[Active Context Lens]\nsummary",
      "d",
      "e",
      "f",
    ]);
  });

  it("ignores a lens when the raw prefix no longer matches the stored cursor fingerprint", () => {
    const original = [user("a"), user("b"), user("c"), user("d")];
    const staleLens = lens({}, original);
    const changed = [user("x"), user("b"), user("c"), user("d")];

    expect(isLensCursorValid(changed, staleLens)).toBe(false);
    expect(applyContextLens(changed, staleLens)).toEqual(changed);
  });
});

describe("calculateLensBoundary", () => {
  it("retains the requested number of recent messages", () => {
    const raw = [user("u1"), user("u2"), user("u3"), user("u4")];
    expect(calculateLensBoundary(raw, 2)).toBe(2); // 4 messages - 2 retained = boundary at 2
  });

  it("returns 0 when messages fit within retain window", () => {
    const raw = [user("u1"), user("u2")];
    expect(calculateLensBoundary(raw, 5)).toBe(0); // 2 < 5, compress nothing
  });
});

describe("resolveLatestLensCommand", () => {
  it("recovers the latest active lens from persisted tool result details", () => {
    const command: ContextLensCommand = { version: 1, command: "activate", lens: lens(), createdAt: 20 };
    expect(resolveLatestLensCommand([user("before"), toolResult(command)])?.lens?.id).toBe("lens-1");
  });

  it("treats a later clear command as disabling the lens", () => {
    const activate: ContextLensCommand = { version: 1, command: "activate", lens: lens(), createdAt: 20 };
    const clear: ContextLensCommand = { version: 1, command: "clear", lensId: "lens-1", createdAt: 30 };
    expect(resolveLatestLensCommand([toolResult(activate), toolResult(clear)])?.command).toBe("clear");
  });
});

describe("usageForMessages", () => {
  it("uses lens tokens when a lens is active", () => {
    const raw = [user("a".repeat(100)), user("tail")];
    const snapshot = usageForMessages(raw, lens({ compressedThroughMessageCount: 1, summary: "short" }, raw), 1000);
    expect(snapshot.rawTokens).toBeGreaterThan(snapshot.lensTokens);
    expect(snapshot.activeLensId).toBe("lens-1");
  });
});
