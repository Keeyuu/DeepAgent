import { createHash } from "node:crypto";
import type { ContextLens, ContextLensCommand, ContextMessage, ContextUsageSnapshot } from "./types.ts";
import { estimateMessagesTokens, extractMessageText } from "./token-estimator.ts";

export function createLensSummaryMessage(lens: ContextLens): ContextMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `[Active Context Lens]\n${lens.summary}` }],
    timestamp: lens.updatedAt,
  } as ContextMessage;
}

export function calculateLensSourceFingerprint(messages: readonly ContextMessage[], boundary: number): string {
  const cutoff = Math.max(0, Math.min(boundary, messages.length));
  const hash = createHash("sha256");
  hash.update("v2:");
  for (let i = 0; i < cutoff; i++) {
    const message = messages[i] as any;
    hash.update(String(i));
    hash.update("\0");
    hash.update(String(message.role ?? ""));
    hash.update("\0");
    hash.update(String(message.toolName ?? ""));
    hash.update("\0");
    hash.update(extractMessageText(messages[i]));
    hash.update("\0");
    if (message.isError !== undefined) {
      hash.update(String(message.isError));
      hash.update("\0");
    }
    if (message.timestamp) {
      hash.update(String(message.timestamp));
      hash.update("\0");
    }
  }
  return hash.digest("hex").slice(0, 16);
}

export function isLensCursorValid(messages: readonly ContextMessage[], lens: ContextLens): boolean {
  return Number.isInteger(lens.compressedThroughMessageCount)
    && lens.compressedThroughMessageCount >= 0
    && lens.compressedThroughMessageCount <= messages.length
    && lens.sourceFingerprint === calculateLensSourceFingerprint(messages, lens.compressedThroughMessageCount);
}

export function applyContextLens(messages: readonly ContextMessage[], lens: ContextLens): ContextMessage[] {
  if (!isLensCursorValid(messages, lens)) return [...messages];
  const cutoff = Math.max(0, Math.min(lens.compressedThroughMessageCount, messages.length));
  return [createLensSummaryMessage(lens), ...messages.slice(cutoff)];
}

export function calculateLensBoundary(messages: readonly ContextMessage[], retainRecentTurns: number): number {
	// retainRecentTurns means: keep the last N messages raw, compress everything before.
	// This ensures compression works even in single-turn sessions with many tool calls.
	const clamped = Math.max(1, retainRecentTurns);
	const boundary = Math.max(0, messages.length - clamped);
	return boundary;
}

export function getContextLensCommand(message: ContextMessage): ContextLensCommand | undefined {
  const details = (message as any).details;
  const command = details?.contextLens;
  if (command?.version !== 1) return undefined;
  if (command.command !== "activate" && command.command !== "clear") return undefined;
  return command as ContextLensCommand;
}

export function resolveLatestLensCommand(messages: readonly ContextMessage[]): ContextLensCommand | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const command = getContextLensCommand(messages[i]);
    if (command) return command;
  }
  return undefined;
}

export function usageForMessages(
  rawMessages: readonly ContextMessage[],
  activeLens: ContextLens | undefined,
  budget: number,
  thresholds: { nudgeThreshold: number; nudgeUrgent: number } = { nudgeThreshold: 0.6, nudgeUrgent: 0.8 },
): ContextUsageSnapshot {
  const rawTokens = estimateMessagesTokens(rawMessages);
  const effectiveLens = activeLens && isLensCursorValid(rawMessages, activeLens) ? activeLens : undefined;
  const viewMessages = effectiveLens ? applyContextLens(rawMessages, effectiveLens) : [...rawMessages];
  const lensTokens = estimateMessagesTokens(viewMessages);
  const used = effectiveLens ? lensTokens : rawTokens;
  const usageRatio = budget > 0 ? used / budget : 0;
  const level =
    usageRatio >= thresholds.nudgeUrgent ? "critical" :
    usageRatio >= thresholds.nudgeThreshold + 0.1 ? "warning" :
    usageRatio >= thresholds.nudgeThreshold ? "info" :
    "none";

  return {
    rawTokens,
    lensTokens,
    budget,
    nudgeThreshold: thresholds.nudgeThreshold,
    activeLensId: effectiveLens?.id,
    compressedThroughMessageCount: effectiveLens?.compressedThroughMessageCount,
    retainedMessageCount: effectiveLens ? rawMessages.length - effectiveLens.compressedThroughMessageCount : rawMessages.length,
    usageRatio,
    level,
  };
}
