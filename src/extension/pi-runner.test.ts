import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_filePath: string, fn: () => Promise<void>) => fn()),
}));

// Track fs cleanup calls via hoisted mock
const { fsCleanup } = vi.hoisted(() => ({
  fsCleanup: { unlink: [] as string[], rmdir: [] as string[] },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: (p: string) => {
      fsCleanup.unlink.push(p);
    },
    rmdirSync: (p: string) => {
      fsCleanup.rmdir.push(p);
    },
  };
});

// Mock paths module to isolate pi-runner tests from fs/temp file logic
vi.mock("./paths.ts", () => ({
  getPiInvocation: vi.fn((args: string[]) => ({ command: "pi", args })),
  buildChildArgs: vi.fn(() => ["--mode", "json", "-p", "--no-session", "Task: test"]),
  writePromptToTempFile: vi.fn(() =>
    Promise.resolve({ dir: "/tmp/pi-subagent-xxx", filePath: "/tmp/pi-subagent-xxx/prompt.md" })
  ),
}));

import { spawn } from "node:child_process";
import { runChildPi } from "./pi-runner.ts";
import type { RunChildOptions } from "./pi-runner.ts";
import type { AgentConfig } from "./types.ts";

function createMockProc(stdout: string, stderr: string, exitCode: number) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  // Use setImmediate so listeners are attached before we emit
  setImmediate(() => {
    proc.stdout.emit("data", Buffer.from(stdout));
    proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", exitCode);
  });

  return proc;
}

describe("runChildPi", () => {
  const baseAgent: AgentConfig = {
    name: "researcher",
    description: "test researcher",
    systemPrompt: "You are a researcher.",
    filePath: "/tmp/researcher.md",
  };

  const defaultOptions: RunChildOptions = {
    agent: baseAgent,
    task: "find bugs",
    cwd: "/tmp/project",
    depth: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets correct env vars (SUBAGENT_CHILD=1, SUBAGENT_DEPTH)", async () => {
    const mockProc = createMockProc(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      }),
      "",
      0
    );

    vi.mocked(spawn).mockReturnValue(mockProc);

    await runChildPi(defaultOptions);

    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnOptions = vi.mocked(spawn).mock.calls[0][2] as any;
    expect(spawnOptions.env.SUBAGENT_CHILD).toBe("1");
    expect(spawnOptions.env.SUBAGENT_DEPTH).toBe("1");
  });

  it("returns stderr on non-zero exit", async () => {
    const mockProc = createMockProc("", "Error: something failed", 1);

    vi.mocked(spawn).mockReturnValue(mockProc);

    const result = await runChildPi(defaultOptions);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("something failed");
    expect(result.output).toBe("");
  });

  it("cleans up temp files when systemPrompt is present", async () => {
    const mockProc = createMockProc(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        },
      }),
      "",
      0
    );

    vi.mocked(spawn).mockReturnValue(mockProc);

    // Reset tracked cleanup calls
    fsCleanup.unlink.length = 0;
    fsCleanup.rmdir.length = 0;

    await runChildPi(defaultOptions);

    // pi-runner.ts calls unlinkSync + rmdirSync in the finally block
    // when systemPrompt is non-empty and temp files were created
    expect(fsCleanup.unlink.length).toBeGreaterThanOrEqual(1);
    expect(fsCleanup.rmdir.length).toBeGreaterThanOrEqual(1);
  });

  it("returns parsed output on success", async () => {
    const jsonl = [
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "research complete" }],
        },
      }),
    ].join("\n");

    const mockProc = createMockProc(jsonl, "", 0);
    vi.mocked(spawn).mockReturnValue(mockProc);

    const result = await runChildPi(defaultOptions);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("research complete");
    expect(result.agent).toBe("researcher");
    expect(result.task).toBe("find bugs");
  });

  it("handles spawn error gracefully", async () => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();

    vi.mocked(spawn).mockReturnValue(proc);

    setImmediate(() => {
      proc.emit("error", new Error("spawn failed"));
    });

    const result = await runChildPi({
      ...defaultOptions,
      agent: { ...baseAgent, systemPrompt: "" },
    });
    expect(result.exitCode).toBe(1);
  });
});
