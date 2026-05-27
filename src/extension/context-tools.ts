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
import type { CompressParams, ContextConfig, ContextLens, ContextLensCommand, ContextMessage, NudgeTemplates } from "./types.ts";

const DEFAULT_NUDGE_TEMPLATES: NudgeTemplates = {
  info: `<context-usage>\nContext at {{ratio}}% ({{usedTokens}} / {{budget}}).\nConsider using \`compress\` to focus the context.\n</context-usage>`,
  warning: `<context-usage>\nContext at {{ratio}}% ({{usedTokens}} / {{budget}}).\nTail is growing — refresh the lens with \`compress\` soon.\n</context-usage>`,
  critical: `<context-usage>\nCRITICAL: Context at {{ratio}}% ({{usedTokens}} / {{budget}}).\nYou MUST call \`compress\` NOW or the context window may overflow.\n</context-usage>`,
};

const DEFAULT_CONFIG: ContextConfig = {
  budget: 180000,
  nudgeThreshold: 0.6,
  nudgeUrgent: 0.8,
  retainRecentTurns: 10,
  summaryPromptPath: ".pi/prompts/context-lens.md",
  nudgeTemplates: DEFAULT_NUDGE_TEMPLATES,
  modelOverrides: [],
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

/** Apply per-model overrides: match longest model key prefix */
function resolveModelConfig(modelId: string | undefined, config: ContextConfig): ContextConfig {
  if (!modelId || !config.modelOverrides?.length) return config;
  const match = config.modelOverrides
    .filter((o) => modelId.startsWith(o.model))
    .sort((a, b) => b.model.length - a.model.length)[0];
  if (!match) return config;
  return { ...config, ...match };
}

function resolveEffectiveConfig(modelId: string | undefined): ContextConfig {
  return resolveModelConfig(modelId, readContextConfig(process.cwd()));
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

function formatUsageReport(usage: ReturnType<typeof usageForMessages>, totalMessages?: number): string {
  const rawK = Math.round(usage.rawTokens / 1000);
  const lensK = Math.round(usage.lensTokens / 1000);
  const budgetK = Math.round(usage.budget / 1000);
  const active = usage.activeLensId ? `active lens: ${usage.activeLensId}` : "active lens: none";
  const rawLabel = totalMessages !== undefined
    ? `raw context: ~${rawK}K tokens · ${totalMessages} messages`
    : `raw context: ~${rawK}K tokens`;
  const lensLabel = usage.activeLensId
    ? `lens view:   ~${lensK}K / ${budgetK}K tokens · ${usage.retainedMessageCount ?? "?"} messages`
    : `lens view:   ~${lensK}K / ${budgetK}K tokens (no active lens)`;
  const refreshHint = usage.activeLensId
    ? (usage.level !== "none"
        ? "Refresh the lens with compress if the retained tail grows too large."
        : "Lens view is healthy. No action needed.")
    : (usage.rawTokens > usage.budget * usage.nudgeThreshold
        ? "No active lens — create one with compress to reduce context usage."
        : "No active lens and raw context is below threshold.");
  return [
    rawLabel,
    lensLabel,
    active,
    `level: ${usage.level}`,
    refreshHint,
  ].join("\n");
}

function formatUsageNudge(usage: ReturnType<typeof usageForMessages>, config: ContextConfig): ContextMessage | undefined {
  const ratio = usage.usageRatio;
  if (ratio < config.nudgeThreshold) return undefined;

  const level = usage.level;
  if (level === "none") return undefined;
  const templates = config.nudgeTemplates ?? DEFAULT_NUDGE_TEMPLATES;
  const template = templates[level];
  if (!template) return undefined;

  const usedTokens = usage.activeLensId ? usage.lensTokens : usage.rawTokens;
  const text = template
    .replace(/\{\{ratio\}\}/g, String(Math.round(ratio * 100)))
    .replace(/\{\{usedTokens\}\}/g, formatTokenCount(usedTokens))
    .replace(/\{\{budget\}\}/g, formatTokenCount(usage.budget))
    .replace(/\{\{level\}\}/g, level);

  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as ContextMessage;
}

function formatTokenCount(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

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
      const effective = resolveModelConfig(ctx.model?.id, config);
      const rawMessages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as ContextMessage[];
      const activeLens = latestActiveLens(rawMessages, memoryLens);
      const usage = usageForMessages(rawMessages, activeLens, effective.budget, effective);
      return {
        content: [{ type: "text", text: formatUsageReport(usage, rawMessages.length) }],
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
      guideline: Type.String({ description: "Core intent: what you aim to accomplish after compression." }),
      retainRecentTurns: Type.Optional(Type.Number({ description: "Number of recent messages to keep raw. Defaults to contextManagement.retainRecentTurns." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const effective = resolveModelConfig(ctx.model?.id, config);
      const rawMessages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as ContextMessage[];
      const previousLens = latestActiveLens(rawMessages, memoryLens);
      const promptTemplate = readPromptTemplate(ctx.cwd, effective);
      const normalized = normalizeParams(params as CompressParams, effective);
      const lens = await createOrRefreshLens({
        ctx,
        rawMessages,
        previousLens,
        params: normalized,
        config: effective,
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

  pi.on("session_before_compact", async (_event) => {
    return undefined;
  });

  pi.on("session_compact", async () => {
    memoryLens = undefined;
    pi.sendMessage({
      customType: "context-lens-reset",
      content: "Context lens reset due to native compaction.",
      display: false,
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
    memoryLens = undefined;
    pi.sendMessage({
      customType: "context-lens-reset",
      content: "Context lens reset due to session tree navigation.",
      display: false,
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
      display: false,
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
}
