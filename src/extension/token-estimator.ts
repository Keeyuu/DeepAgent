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
