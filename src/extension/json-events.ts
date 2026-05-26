import type { ParseResult } from "./types.ts";

export function parseJsonEvents(stdout: string): ParseResult {
  let finalText = "";
  let assistantMessages = 0;
  let parseErrors = 0;

  const lines = stdout.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      parseErrors++;
      continue;
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      assistantMessages++;
      const content = event.message.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "text") {
            finalText = part.text; // keep overwriting to get the last one
          }
        }
      }
    }
  }

  return { finalText, assistantMessages, parseErrors };
}
