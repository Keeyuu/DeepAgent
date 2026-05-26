import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { getPiInvocation, buildChildArgs } from "./paths.ts";
import type { AgentConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// getPiInvocation
// ---------------------------------------------------------------------------

describe("getPiInvocation", () => {
  const realExecPath = process.execPath;
  const realArgv1 = process.argv[1];

  afterEach(() => {
    // restore after each test
    Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true });
    Object.defineProperty(process, "argv", { value: process.argv, configurable: true });
  });

  it('returns { command: "pi", args } when execPath is node.exe and no script', () => {
    Object.defineProperty(process, "execPath", {
      value: "/usr/local/bin/node",
      configurable: true,
    });
    Object.defineProperty(process, "argv", {
      value: ["node"],
      configurable: true,
    });

    const result = getPiInvocation(["--mode", "json"]);
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["--mode", "json"]);
  });

  it('returns { command: "pi", args } on Windows node.exe', () => {
    Object.defineProperty(process, "execPath", {
      value: "C:\\Program Files\\nodejs\\node.exe",
      configurable: true,
    });
    Object.defineProperty(process, "argv", {
      value: ["node.exe"],
      configurable: true,
    });

    const result = getPiInvocation(["foo"]);
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["foo"]);
  });

  it("returns { command: execPath, args: [script, ...rest] } when script exists", () => {
    // Use the current test file as a script that definitely exists
    const existingScript = import.meta.url.replace("file:///", "").replace(/\//g, path.sep);
    // On Windows, import.meta.url gives file:///C:/... → we need C:\...
    const scriptPath =
      process.platform === "win32"
        ? decodeURIComponent(import.meta.url.replace("file:///", ""))
        : decodeURIComponent(import.meta.url.replace("file://", ""));

    Object.defineProperty(process, "execPath", {
      value: "/usr/local/bin/node",
      configurable: true,
    });
    Object.defineProperty(process, "argv", {
      value: ["node", scriptPath],
      configurable: true,
    });

    const result = getPiInvocation(["--test"]);
    expect(result.command).toBe("/usr/local/bin/node");
    expect(result.args).toEqual([scriptPath, "--test"]);
  });

  it("returns { command: execPath, args } when runtime is non-generic (e.g. bundled)", () => {
    Object.defineProperty(process, "execPath", {
      value: "/opt/pi/bin/pi-runtime",
      configurable: true,
    });
    Object.defineProperty(process, "argv", {
      value: ["pi-runtime"],
      configurable: true,
    });

    const result = getPiInvocation(["arg1"]);
    expect(result.command).toBe("/opt/pi/bin/pi-runtime");
    expect(result.args).toEqual(["arg1"]);
  });

  it("skips bun virtual script paths", () => {
    Object.defineProperty(process, "execPath", {
      value: "/usr/local/bin/bun",
      configurable: true,
    });
    Object.defineProperty(process, "argv", {
      value: ["bun", "/$bunfs/root/some-script.ts"],
      configurable: true,
    });

    const result = getPiInvocation(["hello"]);
    // bun is generic runtime → falls through to "pi"
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["hello"]);
  });
});

// ---------------------------------------------------------------------------
// buildChildArgs
// ---------------------------------------------------------------------------

describe("buildChildArgs", () => {
  const baseAgent: AgentConfig = {
    name: "test-agent",
    description: "test",
    systemPrompt: "",
    filePath: "/tmp/test-agent.md",
  };

  it("includes --mode json -p --no-session always", () => {
    const args = buildChildArgs(baseAgent, "do stuff", "/tmp/prompt.md");
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("json");
    expect(args).toContain("-p");
    expect(args).toContain("--no-session");
  });

  it("includes --tools when agent has tools", () => {
    const agent: AgentConfig = { ...baseAgent, tools: ["read", "write"] };
    const args = buildChildArgs(agent, "task", "");
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe("read,write");
  });

  it("does not include --tools when agent has no tools", () => {
    const args = buildChildArgs(baseAgent, "task", "");
    expect(args).not.toContain("--tools");
  });

  it("includes --model when agent has a model", () => {
    const agent: AgentConfig = { ...baseAgent, model: "claude-4" };
    const args = buildChildArgs(agent, "task", "");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-4");
  });

  it("includes --append-system-prompt when agent has systemPrompt", () => {
    const agent: AgentConfig = { ...baseAgent, systemPrompt: "You are helpful." };
    const args = buildChildArgs(agent, "task", "/tmp/prompt.md");
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("/tmp/prompt.md");
  });

  it("does not include --append-system-prompt when systemPrompt is empty", () => {
    const agent: AgentConfig = { ...baseAgent, systemPrompt: "  " };
    const args = buildChildArgs(agent, "task", "/tmp/prompt.md");
    expect(args).not.toContain("--append-system-prompt");
  });

  it("includes Task: prefix", () => {
    const args = buildChildArgs(baseAgent, "do the thing", "");
    const taskEntry = args.find((a) => a.startsWith("Task: "));
    expect(taskEntry).toBe("Task: do the thing");
  });
});
