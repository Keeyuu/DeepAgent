import { describe, it, expect } from "vitest";
import { parseJsonEvents } from "./json-events.ts";

describe("parseJsonEvents", () => {
  it("returns last assistant text from a JSONL stream", () => {
    const stdout = [
      JSON.stringify({
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first response" }],
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final response" }],
        },
      }),
    ].join("\n");

    const result = parseJsonEvents(stdout);
    expect(result.finalText).toBe("final response");
    expect(result.assistantMessages).toBe(2);
    expect(result.parseErrors).toBe(0);
  });

  it("ignores non-JSON lines (counts them as parseErrors)", () => {
    const stdout = [
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        },
      }),
      "not json line",
      "also not json { incomplete",
    ].join("\n");

    const result = parseJsonEvents(stdout);
    expect(result.finalText).toBe("ok");
    expect(result.parseErrors).toBe(2);
  });

  it("returns empty string when no assistant message exists", () => {
    const stdout = JSON.stringify({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    });

    const result = parseJsonEvents(stdout);
    expect(result.finalText).toBe("");
    expect(result.assistantMessages).toBe(0);
  });

  it("counts multiple assistant messages correctly", () => {
    const stdout = [
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "a" }],
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "b" }],
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "c" }],
        },
      }),
    ].join("\n");

    const result = parseJsonEvents(stdout);
    expect(result.assistantMessages).toBe(3);
    expect(result.finalText).toBe("c");
  });

  it("handles empty input", () => {
    const result = parseJsonEvents("");
    expect(result.finalText).toBe("");
    expect(result.assistantMessages).toBe(0);
    expect(result.parseErrors).toBe(0);
  });
});
