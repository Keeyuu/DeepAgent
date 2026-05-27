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
  const conversation = messages
    .map((message, index) => {
      const msg = message as any;
      const role = String(msg.role ?? "unknown");
      const parts: string[] = [];
      const text = extractMessageText(message);
      if (text) parts.push(text);
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

export async function completeWithPi(ctx: any, prompt: string, signal?: AbortSignal): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error("No model selected for context lens summary.");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  // NOTE: Dynamic import to avoid hard dependency at load time
  const { complete } = await import("@earendil-works/pi-ai");
  const response = await complete(
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
    { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 8192, signal },
  );
  return response.content
    .filter((part: any): part is { type: "text"; text: string } => part.type === "text")
    .map((part: any) => part.text)
    .join("\n");
}
