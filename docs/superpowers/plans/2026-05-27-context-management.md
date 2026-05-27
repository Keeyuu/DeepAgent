# Context Management — Active Context Lens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Pi subagent 在 child 模式下拥有主动上下文管理能力：原始 session history 保持不变，后续 LLM call 持续通过 active context lens 看到“摘要 + 保留尾部”的压缩视野。

**Architecture:** This is a virtual compaction layer on Pi's `context` event, not native durable compaction. `compress` creates or refreshes an active lens, stores lens metadata in the persisted tool result `details`, and the `context` hook reconstructs/applies the latest lens on every later LLM call. Pi threshold auto-compaction is intentionally avoided during healthy lens operation because Pi bases normal threshold checks on the provider request usage; native compaction is only a last-resort path for provider overflow, manual compact, or explicit `ctx.compact()`. If native compaction, fork, or branch/tree navigation changes the raw message array shape, treat the current lens cursor as invalid and clear or rebuild the lens from the new raw context.

**Tech Stack:** TypeScript, Pi Extension API (`registerTool`, `on("context")`, `ctx.sessionManager`, `ctx.modelRegistry`), `@earendil-works/pi-ai.complete`, Vitest.

---

## Key Decisions

- **Use active lens, not one-shot blocks.** Do not clear the lens after first application. A lens remains active until replaced by another `compress` call or cleared by `clear_context_lens`.
- **Do not use `AgentMessage.id`.** Pi context messages do not have stable message ids. The lens boundary is `compressedThroughMessageCount`, an index into the raw message array received by the `context` hook.
- **Lens cursors are branch-shape scoped.** `compressedThroughMessageCount` is valid only for the raw message array shape that created/refreshed the lens. Native compaction, fork, or branch/tree navigation can rewrite that shape; these events are reset boundaries. Normal operation avoids native compaction. If native compaction happens as a fallback, clear the active lens or rebuild it against the new raw context before applying another lens view.
- **Count the actual provider view.** When a lens is active, context usage and nudge thresholds use the transformed view (`summary + rawMessages.slice(compressedThroughMessageCount)`), because that is what the LLM receives.
- **Long-running windows require refresh.** The retained tail grows after lens creation. When the lens view approaches budget, nudge the agent to refresh the lens. Refresh summarizes the previous lens summary plus the delta since the previous boundary, then advances `compressedThroughMessageCount`.
- **Re-entry source of truth is persisted tool results.** In-memory state is only a cache. On every context hook, reconstruct the latest lens command from `toolResult.details.contextLens`, so keep-alive resume and process restart can recover the active lens from session history.
- **Summary must be semantic.** No structural placeholder summary for active lens. The lens summary is generated with an LLM using the configured prompt. If summary generation fails, leave the current lens unchanged and return an error tool result.
- **Project-local config only in this plan.** Read `.pi/settings.json` and `.pi/prompts/context-lens.md`; do not depend on `~/.pi/agent/*` for the project feature.
- **Native auto-compaction is not the normal control loop.** With an active lens, normal successful turns report provider usage for the lens view, so Pi threshold auto-compaction should not fire just because raw session history is large. This extension monitors and refreshes the lens itself; native compaction remains the last-resort overflow/manual fallback.

## Context Accounting

There are two token numbers:

- `rawTokens`: estimate of the unmodified Pi session context.
- `lensTokens`: estimate of the transformed context sent to the provider.

Nudge behavior:

- No active lens: compare `rawTokens / budget`.
- Active lens: compare `lensTokens / budget`.
- If `rawTokens` is high but `lensTokens` is healthy, report that the raw session is large but the active lens is controlling provider context.
- If `lensTokens` is high, instruct the agent to refresh the lens with `compress`.

Lens application is deterministic:

```typescript
view = [
  createLensSummaryMessage(activeLens),
  ...rawMessages.slice(activeLens.compressedThroughMessageCount),
]
```

Refresh is incremental:

```typescript
summaryInput = [
  createLensSummaryMessage(previousLens),
  ...rawMessages.slice(previousLens.compressedThroughMessageCount, newCompressedThroughMessageCount),
]
```

That prevents re-summarizing the whole raw session after the first lens.

Before applying a persisted lens, verify that its cursor still matches the current raw message array. The implementation stores a source fingerprint for the messages before `compressedThroughMessageCount`; if the current raw context does not match that fingerprint, the lens is ignored and the next `compress` call must build a fresh lens from the current context.

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `src/extension/token-estimator.ts` | Estimate text/message tokens for nudge and lens accounting. |
| `src/extension/context-lens.ts` | Pure active-lens state, re-entry resolution, lens application, tail boundary calculation. |
| `src/extension/context-compactor.ts` | Prompt rendering and LLM-backed summary generation. |
| `src/extension/context-tools.ts` | Child-mode registration for `compress`, `context_usage`, `clear_context_lens`, and context hooks. |
| `src/extension/token-estimator.test.ts` | Token estimator tests. |
| `src/extension/context-lens.test.ts` | Active lens / re-entry / accounting tests. |
| `src/extension/context-compactor.test.ts` | Prompt rendering and fake LLM summary tests. |
| `src/extension/context-tools.test.ts` | Fake ExtensionAPI integration tests. |
| `.pi/prompts/context-lens.md` | Project-local summary prompt template. |

### Modified Files

| File | Change |
|------|--------|
| `src/extension/types.ts` | Add context lens types. |
| `src/extension/tool.ts` | Import and call `registerContextManagement(pi)` in child mode before `return`. |
| `.pi/settings.json` | Add optional `contextManagement` defaults. |
| `docs/architecture/context-management.md` | Document active lens semantics, accounting, and re-entry. |
| `docs/index.md` | Link architecture document if docs index exists. |

---

### Task 1: Types — Define Active Context Lens Contracts

**Files:**
- Modify: `src/extension/types.ts`

- [ ] **Step 1: Add lens types at the end of `src/extension/types.ts`**

```typescript
import type { ContextEvent } from "@earendil-works/pi-coding-agent";

export type ContextMessage = ContextEvent["messages"][number];

export interface CompressParams {
  focus: string;
  filter: string;
  guideline: string;
  retainRecentTurns?: number;
}

export interface ContextLens {
  version: 1;
  id: string;
  previousLensId?: string;
  summary: string;
  params: Required<CompressParams>;
  compressedThroughMessageCount: number;
  sourceFingerprint: string;
  retainedMessageCountAtCreation: number;
  rawTokensAtCreation: number;
  lensTokensAtCreation: number;
  createdAt: number;
  updatedAt: number;
}

export interface ContextLensCommand {
  version: 1;
  command: "activate" | "clear";
  lens?: ContextLens;
  lensId?: string;
  createdAt: number;
}

export interface ContextUsageSnapshot {
  rawTokens: number;
  lensTokens: number;
  budget: number;
  nudgeThreshold: number;
  activeLensId?: string;
  compressedThroughMessageCount?: number;
  retainedMessageCount?: number;
  usageRatio: number;
  level: "none" | "info" | "warning" | "critical";
}

export interface ContextConfig {
  budget: number;
  nudgeThreshold: number;
  nudgeUrgent: number;
  retainRecentTurns: number;
  summaryPromptPath: string;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS or only pre-existing unrelated failures.

---

### Task 2: Token Estimator — Estimate Actual Message Text

**Files:**
- Create: `src/extension/token-estimator.ts`
- Create: `src/extension/token-estimator.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
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
```

- [ ] **Step 2: Verify tests fail**

```bash
npx vitest run src/extension/token-estimator.test.ts
```

Expected: FAIL because `token-estimator.ts` does not exist.

- [ ] **Step 3: Implement estimator**

```typescript
import type { ContextMessage } from "./types.ts";

const CJK_RANGES = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
  [0xf900, 0xfaff],
  [0x3040, 0x309f],
  [0x30a0, 0x30ff],
  [0xac00, 0xd7af],
] as const;

function isCjk(ch: string): boolean {
  const cp = ch.codePointAt(0);
  return cp !== undefined && CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let latin = 0;
  let cjk = 0;
  for (const ch of text) {
    if (isCjk(ch)) cjk++;
    else latin++;
  }
  return Math.ceil(latin / 4) + cjk;
}

export function extractMessageText(message: ContextMessage): string {
  const content = (message as any).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function estimateMessagesTokens(messages: readonly ContextMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTextTokens(extractMessageText(message)) + 4, 0);
}
```

- [ ] **Step 4: Verify tests pass**

```bash
npx vitest run src/extension/token-estimator.test.ts
```

Expected: PASS.

---

### Task 3: Context Lens Pure Logic

**Files:**
- Create: `src/extension/context-lens.ts`
- Create: `src/extension/context-lens.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
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
  it("retains the requested number of recent user turns", () => {
    const raw = [user("u1"), user("u2"), user("u3"), user("u4")];
    expect(calculateLensBoundary(raw, 2)).toBe(2);
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
```

- [ ] **Step 2: Verify tests fail**

```bash
npx vitest run src/extension/context-lens.test.ts
```

Expected: FAIL because `context-lens.ts` does not exist.

- [ ] **Step 3: Implement pure lens logic**

```typescript
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
  hash.update("v2:"); // Algorithm version
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
    // Include tool result status and timestamp for shape-change detection
    if (message.isError !== undefined) {
      hash.update(String(message.isError));
      hash.update("\0");
    }
    if (message.timestamp) {
      hash.update(String(message.timestamp));
      hash.update("\0");
    }
  }
  return hash.digest("hex").slice(0, 16); // Shorter, sufficient for collision resistance
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
  const clamped = Math.max(1, retainRecentTurns); // Always keep at least 1 turn
  let userTurnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as any).role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen >= clamped) return i;
    }
  }
  return 0;
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
  thresholds: { nudgeThreshold: number; nudgeUrgent: number } = { nudgeThreshold: 0.7, nudgeUrgent: 0.9 },
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
```

- [ ] **Step 4: Verify tests pass**

```bash
npx vitest run src/extension/context-lens.test.ts
```

Expected: PASS.

---

### Task 4: Context Compactor — LLM Summary for Lens Creation and Refresh

**Files:**
- Create: `src/extension/context-compactor.ts`
- Create: `src/extension/context-compactor.test.ts`
- Create: `.pi/prompts/context-lens.md`

- [ ] **Step 1: Add project-local prompt**

Create `.pi/prompts/context-lens.md`:

```markdown
You are maintaining an active context lens for a coding agent.

Summarize the supplied conversation into a compact state that the next model calls can rely on.

Retain:
{{focus}}

Discard or compress:
{{filter}}

Guideline:
{{guideline}}

Output exactly these sections:

## Goal
One sentence.

## Decisions
Bullets with rationale.

## Current State
Confirmed facts, active branch, active files, blockers.

## Technical Details
APIs, file paths, commands, errors, validation evidence.

## Next Actions
Immediate next steps.
```

- [ ] **Step 2: Write failing tests with fake completion**

```typescript
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
```

- [ ] **Step 3: Implement compactor with injectable completion**

```typescript
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompressParams, ContextMessage } from "./types.ts";
import { extractMessageText } from "./token-estimator.ts";

export type CompleteText = (prompt: string, signal?: AbortSignal) => Promise<string>;

export function renderLensPrompt(template: string, params: Required<CompressParams>): string {
  return template
    .replace(/\{\{focus\}\}/g, params.focus)
    .replace(/\{\{filter\}\}/g, params.filter)
    .replace(/\{\{guideline\}\}/g, params.guideline);
}

export function buildLensPrompt(renderedTemplate: string, messages: readonly ContextMessage[]): string {
  // Phase 1: Hand-rolled serialization covers text, tool_call, tool_result.
  // Phase 2: Replace with Pi's convertToLlm + serializeConversation for full fidelity.
  const conversation = messages
    .map((message, index) => {
      const msg = message as any;
      const role = String(msg.role ?? "unknown");
      const parts: string[] = [];
      // Text content blocks
      const text = extractMessageText(message);
      if (text) parts.push(text);
      // Tool calls from assistant messages
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "toolCall") {
            parts.push(`[Tool: ${part.name}(${JSON.stringify(part.arguments)})]`);
          } else if (part.type === "toolResult") {
            const err = part.isError ? " ERROR" : "";
            parts.push(`[ToolResult${err}: ${truncate(String(part.content ?? part.text ?? ""), 200)}]`);
          }
        }
      }
      return `### Msg ${index + 1} (${role})\n${parts.join("\n")}`;
    })
    .join("\n\n");
  return `${renderedTemplate}\n\n<conversation>\n${conversation}\n</conversation>`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

export async function summarizeForLens(args: {
  messages: readonly ContextMessage[];
  params: Required<CompressParams>;
  promptTemplate: string;
  completeText: CompleteText;
  signal?: AbortSignal;
}): Promise<string> {
  const rendered = renderLensPrompt(args.promptTemplate, args.params);
  const prompt = buildLensPrompt(rendered, args.messages);
  const summary = await args.completeText(prompt, args.signal);
  const trimmed = summary.trim();
  if (!trimmed) throw new Error("Context lens summary was empty.");
  return trimmed;
}

export async function completeWithPi(ctx: ExtensionContext, prompt: string, signal?: AbortSignal): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error("No model selected for context lens summary.");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const response = await complete(
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
    { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 8192, signal },
  );
  return response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
```

- [ ] **Step 4: Verify tests pass**

```bash
npx vitest run src/extension/context-compactor.test.ts
```

Expected: PASS.

---

### Task 5: Context Tools and Hooks

**Files:**
- Create: `src/extension/context-tools.ts`
- Modify: `src/extension/tool.ts`

- [ ] **Step 1: Implement config loading and active lens helpers**

In `src/extension/context-tools.ts`, add top-level imports and config helpers:

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyContextLens,
  calculateLensBoundary,
  calculateLensSourceFingerprint,
  isLensCursorValid,
  resolveLatestLensCommand,
  usageForMessages,
} from "./context-lens.ts";
import { completeWithPi, summarizeForLens } from "./context-compactor.ts";
import { estimateMessagesTokens } from "./token-estimator.ts";
import type { CompressParams, ContextConfig, ContextLens, ContextLensCommand, ContextMessage } from "./types.ts";

const DEFAULT_CONFIG: ContextConfig = {
  budget: 180000,
  nudgeThreshold: 0.7,
  nudgeUrgent: 0.9,
  retainRecentTurns: 3,
  summaryPromptPath: ".pi/prompts/context-lens.md",
};

function readContextConfig(cwd: string): ContextConfig {
  const settingsPath = path.join(cwd, ".pi", "settings.json");
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...(settings.contextManagement ?? {}) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function readPromptTemplate(cwd: string, config: ContextConfig): string {
  const promptPath = path.isAbsolute(config.summaryPromptPath)
    ? config.summaryPromptPath
    : path.join(cwd, config.summaryPromptPath);
  return fs.readFileSync(promptPath, "utf-8");
}

function normalizeParams(params: CompressParams, config: ContextConfig): Required<CompressParams> {
  return {
    focus: params.focus,
    filter: params.filter,
    guideline: params.guideline,
    retainRecentTurns: params.retainRecentTurns ?? config.retainRecentTurns,
  };
}

function latestActiveLens(messages: readonly ContextMessage[], memoryLens: ContextLens | undefined): ContextLens | undefined {
  const command = resolveLatestLensCommand(messages);
  if (command?.command === "clear") return undefined;
  const candidate = command?.command === "activate" && command.lens ? command.lens : memoryLens;
  if (!candidate) return undefined;
  return isLensCursorValid(messages, candidate) ? candidate : undefined;
}
```

- [ ] **Step 2: Implement lens creation and refresh**

```typescript
async function createOrRefreshLens(args: {
  ctx: ExtensionContext;
  rawMessages: readonly ContextMessage[];
  previousLens?: ContextLens;
  params: Required<CompressParams>;
  config: ContextConfig;
  promptTemplate: string;
  signal?: AbortSignal;
}): Promise<ContextLens> {
  const candidateBoundary = calculateLensBoundary(args.rawMessages, args.params.retainRecentTurns);
  const previousBoundary = args.previousLens?.compressedThroughMessageCount ?? 0;
  const newBoundary = Math.max(previousBoundary, candidateBoundary);
  const messagesToSummarize = args.previousLens
    ? [
        {
          role: "user",
          content: [{ type: "text", text: `[Previous Context Lens]\n${args.previousLens.summary}` }],
          timestamp: args.previousLens.updatedAt,
        } as ContextMessage,
        ...args.rawMessages.slice(previousBoundary, newBoundary),
      ]
    : args.rawMessages.slice(0, newBoundary);

  const summary = await summarizeForLens({
    messages: messagesToSummarize,
    params: args.params,
    promptTemplate: args.promptTemplate,
    completeText: (prompt, signal) => completeWithPi(args.ctx, prompt, signal),
    signal: args.signal,
  });

  const now = Date.now();
  const lens: ContextLens = {
    version: 1,
    id: randomUUID(),
    previousLensId: args.previousLens?.id,
    summary,
    params: args.params,
    compressedThroughMessageCount: newBoundary,
    sourceFingerprint: calculateLensSourceFingerprint(args.rawMessages, newBoundary),
    retainedMessageCountAtCreation: args.rawMessages.length - newBoundary,
    rawTokensAtCreation: estimateMessagesTokens(args.rawMessages),
    lensTokensAtCreation: usageForMessages(args.rawMessages, {
      version: 1,
      id: "estimate",
      summary,
      params: args.params,
      compressedThroughMessageCount: newBoundary,
      sourceFingerprint: calculateLensSourceFingerprint(args.rawMessages, newBoundary),
      retainedMessageCountAtCreation: args.rawMessages.length - newBoundary,
      rawTokensAtCreation: 0,
      lensTokensAtCreation: 0,
      createdAt: now,
      updatedAt: now,
    }, args.config.budget, args.config).lensTokens,
    createdAt: now,
    updatedAt: now,
  };
  return lens;
}
```

- [ ] **Step 3: Register hooks and tools**

```typescript
export function registerContextManagement(pi: ExtensionAPI): void {
  const config = readContextConfig(process.cwd());
  let memoryLens: ContextLens | undefined;

  pi.on("context", async (event) => {
    const rawMessages = event.messages as ContextMessage[];
    const activeLens = latestActiveLens(rawMessages, memoryLens);
    memoryLens = activeLens;

    const transformed = activeLens ? applyContextLens(rawMessages, activeLens) : [...rawMessages];
    const usage = usageForMessages(rawMessages, activeLens, config.budget, config);
    const nudge = formatUsageNudge(usage, config);

    return {
      messages: nudge ? [...transformed, nudge] : transformed,
    };
  });

  pi.registerTool({
    name: "context_usage",
    label: "Context Usage",
    description: "Report raw session context, active lens context, and whether the lens should be refreshed.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const rawMessages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as ContextMessage[];
      const activeLens = latestActiveLens(rawMessages, memoryLens);
      const usage = usageForMessages(rawMessages, activeLens, config.budget, config);
      return {
        content: [{ type: "text", text: formatUsageReport(usage) }],
        details: { contextUsage: usage },
      };
    },
  });

  pi.registerTool({
    name: "compress",
    label: "Compress Context Lens",
    description: "Create or refresh the active context lens. Original session history is preserved; future LLM calls see summary plus recent tail.",
    parameters: Type.Object({
      focus: Type.String({ description: "What the lens summary must retain." }),
      filter: Type.String({ description: "What can be discarded or aggressively compressed." }),
      guideline: Type.String({ description: "One-sentence summary policy." }),
      retainRecentTurns: Type.Optional(Type.Number({ description: "Recent user turns to keep raw. Defaults to contextManagement.retainRecentTurns." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const rawMessages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as ContextMessage[];
      const previousLens = latestActiveLens(rawMessages, memoryLens);
      const promptTemplate = readPromptTemplate(ctx.cwd, config);
      const normalized = normalizeParams(params as CompressParams, config);
      const lens = await createOrRefreshLens({
        ctx,
        rawMessages,
        previousLens,
        params: normalized,
        config,
        promptTemplate,
        signal,
      });
      memoryLens = lens;
      const command: ContextLensCommand = { version: 1, command: "activate", lens, createdAt: Date.now() };
      return {
        content: [{ type: "text", text: `Active context lens ${lens.id} created. Retained ${lens.retainedMessageCountAtCreation} raw messages.` }],
        details: { contextLens: command },
      };
    },
  });

  pi.registerTool({
    name: "clear_context_lens",
    label: "Clear Context Lens",
    description: "Disable the active context lens and return future calls to the raw Pi session context.",
    parameters: Type.Object({}),
    async execute() {
      const command: ContextLensCommand = {
        version: 1,
        command: "clear",
        lensId: memoryLens?.id,
        createdAt: Date.now(),
      };
      memoryLens = undefined;
      return {
        content: [{ type: "text", text: "Active context lens cleared." }],
        details: { contextLens: command },
      };
    },
  });

  pi.on("session_before_compact", async (event) => {
    // Last-resort native compaction path (provider overflow, manual compact, etc.).
    // Do NOT inject lens summary as custom compaction: Pi discards messages before
    // firstKeptEntryId, which may differ from the lens boundary. The gap between
    // lens boundary and firstKeptEntryId would be lost. Instead, defer to Pi's
    // default compaction. session_compact handler clears the memory lens, and
    // the next context hook will rebuild from the compacted raw context.
    return undefined;
  });

  pi.on("session_compact", async () => {
    memoryLens = undefined;
    // Persist clear: native compaction replaced old messages; any surviving
    // activate command from before compaction is now orphaned.
    pi.sendMessage({
      customType: "context-lens-reset",
      content: "Context lens reset due to native compaction.",
      details: {
        contextLens: {
          version: 1,
          command: "clear",
          lensId: undefined,
          createdAt: Date.now(),
        },
      },
    });
  });

  pi.on("session_tree", async () => {
    // Persist a clear marker so resolveLatestLensCommand finds it even
    // after fork/tree navigation rewrites the message array.
    memoryLens = undefined;
    pi.sendMessage({
      customType: "context-lens-reset",
      content: "Context lens reset due to session tree navigation.",
      details: {
        contextLens: {
          version: 1,
          command: "clear",
          lensId: undefined,
          createdAt: Date.now(),
        } as ContextLensCommand,
      },
    });
  });

  pi.on("session_before_fork", async () => {
    memoryLens = undefined;
    pi.sendMessage({
      customType: "context-lens-reset",
      content: "Context lens reset due to session fork.",
      details: {
        contextLens: {
          version: 1,
          command: "clear",
          lensId: undefined,
          createdAt: Date.now(),
        } as ContextLensCommand,
      },
    });
  });

  // This is the end of registerContextManagement
}
```

- [ ] **Step 4: Add formatting helpers**

```typescript
function formatUsageReport(usage: ReturnType<typeof usageForMessages>): string {
  const rawK = Math.round(usage.rawTokens / 1000);
  const lensK = Math.round(usage.lensTokens / 1000);
  const budgetK = Math.round(usage.budget / 1000);
  const active = usage.activeLensId ? `active lens: ${usage.activeLensId}` : "active lens: none";
  const refreshHint = usage.activeLensId
    ? (usage.level !== "none"
        ? "Refresh the lens with compress if the retained tail grows too large."
        : "Lens view is healthy. No action needed.")
    : (usage.rawTokens > usage.budget * usage.nudgeThreshold
        ? "No active lens — create one with compress to reduce context usage."
        : "No active lens and raw context is below threshold.");
  return [
    `raw context: ~${rawK}K tokens`,
    `lens view: ~${lensK}K / ${budgetK}K tokens`,
    active,
    `level: ${usage.level}`,
    refreshHint,
  ].join("\n");
}

function formatUsageNudge(usage: ReturnType<typeof usageForMessages>, config: ContextConfig): ContextMessage | undefined {
  const ratio = usage.usageRatio;
  if (ratio < config.nudgeThreshold) return undefined;
  const action = usage.activeLensId
    ? "Refresh the active context lens with compress to summarize the growing tail."
    : "Create an active context lens with compress.";
  return {
    role: "user",
    content: [{
      type: "text",
      text: [
        "<context-usage>",
        `Context lens view is ${Math.round(ratio * 100)}% of budget.`,
        `Raw tokens: ${usage.rawTokens}; lens tokens: ${usage.lensTokens}.`,
        action,
        "</context-usage>",
      ].join("\n"),
    }],
    timestamp: Date.now(),
  } as ContextMessage;
}
```

- [ ] **Step 5: Wire into child mode**

In `src/extension/tool.ts`, add a top-level import:

```typescript
import { registerContextManagement } from "./context-tools.ts";
```

Then in the `SUBAGENT_CHILD === "1"` branch, after `contact_supervisor` is registered and before `return`:

```typescript
registerContextManagement(pi);
```

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

---

### Task 6: Integration Tests — Persistent Lens and Re-entry

**Files:**
- Create: `src/extension/context-tools.test.ts`

- [ ] **Step 1: Write fake ExtensionAPI tests**

```typescript
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
```

- [ ] **Step 2: Verify tests**

```bash
npx vitest run src/extension/context-tools.test.ts
```

Expected: PASS after Tasks 3 and 5.

---

### Task 7: Config and Documentation

**Files:**
- Modify: `.pi/settings.json`
- Create or modify: `docs/architecture/context-management.md`
- Modify: `docs/index.md` if present

- [ ] **Step 1: Add project config defaults**

Update `.pi/settings.json` by adding:

```json
"contextManagement": {
  "budget": 180000,
  "nudgeThreshold": 0.7,
  "nudgeUrgent": 0.9,
  "retainRecentTurns": 3,
  "summaryPromptPath": ".pi/prompts/context-lens.md"
}
```

- [ ] **Step 2: Add architecture document**

Create `docs/architecture/context-management.md`:

```markdown
# Context Management

DeepAgent uses an active context lens for child subagents.

The raw Pi session history is preserved. Future LLM calls are transformed through the `context` hook so the provider receives:

1. a semantic summary message generated by `compress`
2. raw messages after `compressedThroughMessageCount`

The lens remains active until another `compress` refreshes it or `clear_context_lens` disables it.

## Accounting

`rawTokens` estimates the unmodified session. `lensTokens` estimates the transformed provider view. Nudge thresholds use `lensTokens` when a lens is active.

## Long-Running Windows

The retained tail grows after lens creation. When `lensTokens` approaches budget, the agent should call `compress` again. Refresh summarizes the previous lens summary plus messages added after the old boundary, then advances the boundary.

## Re-entry

Lens metadata is persisted in the `compress` tool result details. The `context` hook reconstructs the latest command from session messages, so process restart or keep-alive resume can recover the active lens. In-memory state is only a cache.

The stored cursor is valid only while the raw message array shape before that cursor is still the same. Each lens stores a source fingerprint for the prefix it summarized. If native compaction, fork, or branch/tree navigation changes the raw context, the fingerprint check fails and the lens is ignored. The agent should run `compress` again to rebuild a lens from the new raw context.

## Native Compaction

Pi native compaction is not the normal context-control loop for this feature. On successful turns, Pi's threshold auto-compaction uses the assistant response usage from the actual provider request; with an active lens, that usage reflects the lens view rather than the unmodified raw session. Therefore raw session growth alone should not trigger threshold auto-compaction while the lens remains under budget.

Native compaction remains a last-resort path for provider context overflow, manual compact, or explicit `ctx.compact()`. If that path fires while a lens is active, `session_before_compact` can reuse the active lens summary as the compaction summary. After `session_compact`, clear the in-memory lens and require the next lens to be created against the compacted raw context.
```

- [ ] **Step 3: Link docs index if available**

If `docs/index.md` exists, add a link under the architecture section:

```markdown
- [Context Management](architecture/context-management.md)
```

---

### Task 8: Full Verification

- [ ] **Step 1: Run focused tests**

```bash
npx vitest run src/extension/token-estimator.test.ts src/extension/context-lens.test.ts src/extension/context-compactor.test.ts src/extension/context-tools.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

```bash
npm run test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Manual smoke in child mode**

Run a child subagent task that calls `context_usage`, then `compress`, then continues with another reasoning step. Verify:

- `context_usage` reports both raw and lens tokens.
- `compress` returns a `details.contextLens.command === "activate"` payload.
- the next LLM call receives an `[Active Context Lens]` summary plus retained tail.
- a second later call still receives the active lens view without calling `compress` again.
- `clear_context_lens` disables the transformed view.
- after native compaction, fork, or branch/tree navigation changes the raw context shape, the previous lens is not applied until `compress` rebuilds it from the new context.

---

## Implementation Notes

- `context` hook is intentionally non-destructive. That is the feature: it preserves raw history while focusing provider context.
- Do not use Pi threshold auto-compaction as the normal refresh mechanism. Refresh the active lens based on `lensTokens`.
- Do not mutate `event.messages` in place. Always return a new array.
- Do not store secrets or auth data in `details.contextLens`.
- Do not let the lens summary include full raw logs unless `focus` explicitly asks for them.
- Keep native compaction support narrow: return an extension compaction only when a last-resort native compaction path fires and an active lens summary is non-empty.
- Treat `sourceFingerprint` mismatch as a lens reset boundary. Do not clamp and continue with an old cursor after native compaction, fork, or branch/tree navigation changes the raw message array.
