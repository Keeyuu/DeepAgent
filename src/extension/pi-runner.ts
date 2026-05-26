import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { AgentConfig, ChildRunResult } from "./types.ts";
import { buildChildArgs, getPiInvocation, writePromptToTempFile } from "./paths.ts";
import { parseJsonEvents } from "./json-events.ts";

export interface RunChildOptions {
  agent: AgentConfig;
  task: string;
  cwd: string;
  depth: number;
}

export async function runChildPi(
  options: RunChildOptions
): Promise<ChildRunResult> {
  const { agent, task, cwd, depth } = options;

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  try {
    // Write system prompt to temp file if present
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
    }

    const args = buildChildArgs(agent, task, tmpPromptPath || "");
    const invocation = getPiInvocation(args);

    let stdout = "";
    let stderr = "";

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        env: {
          ...process.env,
          SUBAGENT_CHILD: "1",
          SUBAGENT_DEPTH: String(depth),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      proc.on("close", (code) => resolve(code ?? 0));
      proc.on("error", () => resolve(1));
    });

    const parsed = parseJsonEvents(stdout);

    return {
      agent: agent.name,
      task,
      exitCode,
      output: parsed.finalText,
      stderr,
    };
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {}
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {}
  }
}
