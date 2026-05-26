/**
 * DeepAgent V1 Extension - Registers the `subagent` tool and `/doctor` command.
 *
 * This is the main extension entrypoint loaded by Pi from `.pi/extensions/subagent/index.ts`.
 */

import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadProjectAgents, findAgent } from "./agents.ts";
import { checkSubagentAllowed } from "./guards.ts";
import { runChildPi } from "./pi-runner.ts";

const SubagentParams = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke. V1 only supports 'worker'." }),
  task: Type.String({ minLength: 1, description: "The bounded task to delegate to the child agent." }),
});

function makeResult(text: string, isError = false): AgentToolResult<undefined> {
  return {
    content: [{ type: "text", text }],
    details: undefined,
    ...(isError ? { isError: true } : {}),
  };
}

export default function (pi: ExtensionAPI) {
  // Register the `subagent` tool
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate a bounded task to an isolated child Pi process with project-local agent.",
    parameters: SubagentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<undefined>> {
      // Safety gate: block nested delegation
      const allowed = checkSubagentAllowed();
      if (!allowed.allowed) {
        return makeResult(`Blocked: ${allowed.reason}`, true);
      }

      // V1 only accepts "worker"
      if (params.agent !== "worker") {
        return makeResult(`Unknown agent: "${params.agent}". V1 only supports agent "worker".`, true);
      }

      // Load project agents
      const agents = loadProjectAgents(ctx.cwd);
      const agent = findAgent(agents, params.agent);

      if (!agent) {
        const available = agents.map((a) => a.name).join(", ") || "none";
        return makeResult(`Agent "${params.agent}" not found in .pi/agents/. Available: ${available}`, true);
      }

      // Run the child Pi process
      const result = await runChildPi({
        agent,
        task: params.task,
        cwd: ctx.cwd,
        depth: parseInt(process.env.SUBAGENT_DEPTH || "0", 10) + 1,
      });

      if (result.exitCode !== 0) {
        return makeResult(
          `Agent failed (exit ${result.exitCode}): ${result.stderr || result.output || "(no output)"}`,
          true,
        );
      }

      return makeResult(result.output || "(no output)");
    },
  });

  // Register the `/doctor` command
  pi.registerCommand("doctor", {
    description: "Check DeepAgent V1 extension status",
    async handler(_args, ctx) {
      const agents = loadProjectAgents(ctx.cwd);
      const workerFound = agents.some((a) => a.name === "worker");

      const lines = [
        "DeepAgent V1",
        "extension: loaded",
        `agent: worker ${workerFound ? "found" : "missing"}`,
        "third-party runtimes: not used",
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
