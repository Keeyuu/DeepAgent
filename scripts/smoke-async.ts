/**
 * Smoke test: Verify async subagent mode — fire-and-forget + steer/status/abort.
 *
 * Run: npx tsx scripts/smoke-async.ts
 */
import { RpcSession } from "../src/extension/rpc-session.ts";
import { discoverAgents } from "../src/extension/agents.ts";
import { accumulateEvent, getFinalOutput } from "../src/extension/event-accumulator.ts";
import { registerRun, getRun, removeRun, getActiveRunCount, getAllRuns, clearAllRuns } from "../src/extension/run-registry.ts";
import type { AsyncRunInfo } from "../src/extension/types.ts";
import { randomUUID } from "node:crypto";

const CWD = process.cwd();
const IDLE_TIMEOUT = 120_000;

// Cleanup from any prior run
clearAllRuns();

// ── Test 1: Agent discovery ──
console.log("=== Test 1: Agent discovery ===");
const discovery = discoverAgents(CWD, "both");
const worker = discovery.agents.find((a) => a.name === "worker");
if (!worker) {
  console.error("FAIL: worker agent not found");
  process.exit(1);
}
console.log("PASS: worker agent found\n");

// ── Test 2: Start async run ──
console.log("=== Test 2: Start async run ===");
const runId = randomUUID();
const session = new RpcSession({
  cwd: CWD,
  env: {
    SUBAGENT_CHILD: "1",
    SUBAGENT_DEPTH: "1",
  },
  tools: worker.tools,
  systemPrompt: worker.systemPrompt,
  args: ["-p"],
});

try {
  await session.start();
  console.log(`Session started: ${session.isStarted()}`);
} catch (err: any) {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
}

const runInfo: AsyncRunInfo = {
  id: runId,
  agent: "worker",
  task: "List files in the project root",
  status: "running",
  session,
  events: [],
  accumulated: {
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    stderr: "",
  },
  startedAt: Date.now(),
  agentSource: "project",
};

// Wire up background event accumulation (mirrors async mode in tool.ts)
session.onEvent((event) => {
  runInfo.events.push(event);
  accumulateEvent(runInfo.accumulated, event);

  if (event.type === "agent_end") {
    runInfo.status = "completed";
    console.log(`  [agent_end received — run completed]`);
  }
  if (event.type === "tool_execution_start") {
    console.log(`  [tool: ${event.toolName}]`);
  }
});

// Handle UI requests (auto-respond)
session.onUIRequest((req) => {
  const fireAndForget = ["notify", "setStatus", "setTitle", "setWidget", "set_editor_text"];
  if (fireAndForget.includes(req.method)) return;
  if (req.method === "confirm") session.respondToUIRequest(req.id, { confirmed: true });
  else if (req.method === "input") session.respondToUIRequest(req.id, { value: "" });
  else session.respondToUIRequest(req.id, { cancelled: true });
});

// Register the run
registerRun(runInfo);
console.log(`Run registered: ${runId}`);
console.log(`Active runs: ${getActiveRunCount()}`);

// Send task (fire-and-forget)
const task = "List the files in the project root directory (use ls). Report file names only. Do NOT edit any files.";
session.prompt(`Task: ${task}`);
console.log("Task sent (async — not waiting)\n");

// ── Test 3: Poll status while running ──
console.log("=== Test 3: Poll status ===");

// Poll every 2 seconds for up to 60 seconds
const pollInterval = 2_000;
const maxPollTime = 60_000;
const pollStart = Date.now();

while (runInfo.status === "running" && Date.now() - pollStart < maxPollTime) {
  await new Promise((r) => setTimeout(r, pollInterval));

  const run = getRun(runId);
  if (!run) {
    console.error("FAIL: Run disappeared from registry");
    process.exit(1);
  }

  const output = getFinalOutput(run.accumulated.messages);
  const preview = output.length > 60 ? `${output.slice(0, 60)}...` : output || "(no output yet)";
  console.log(`  [${run.status}] turns=${run.accumulated.usage.turns} events=${run.events.length} output="${preview}"`);
}

if (runInfo.status !== "completed") {
  console.error(`FAIL: Run did not complete within ${maxPollTime}ms (status: ${runInfo.status})`);
  await session.stop();
  process.exit(1);
}

console.log("PASS: Async run completed\n");

// ── Test 4: Verify results after completion ──
console.log("=== Test 4: Verify results ===");
const finalRun = getRun(runId);
console.log(`Run still in registry: ${finalRun ? "yes" : "no"}`);
console.log(`Status: ${runInfo.status}`);
console.log(`Events: ${runInfo.events.length}`);
console.log(`Messages: ${runInfo.accumulated.messages.length}`);
console.log(`Usage: input=${runInfo.accumulated.usage.input}, output=${runInfo.accumulated.usage.output}, turns=${runInfo.accumulated.usage.turns}`);
console.log(`Model: ${runInfo.accumulated.model || "unknown"}`);

const finalOutput = getFinalOutput(runInfo.accumulated.messages);
console.log(`\nFinal output:\n${finalOutput.substring(0, 500)}`);

if (runInfo.accumulated.messages.length === 0) {
  console.error("FAIL: No messages accumulated");
  process.exit(1);
}
console.log("\nPASS: Results verified\n");

// ── Cleanup ──
removeRun(runId);
await session.stop();
console.log(`Exit code: ${session.getExitCode()}`);
console.log(`Active runs after cleanup: ${getActiveRunCount()}`);

console.log("\n=== ALL ASYNC TESTS PASSED ===");
process.exit(0);
