/**
 * Smoke test: Verify RPC session + extension loading + agent discovery.
 * This simulates what the subagent tool does internally.
 * 
 * Run: npx tsx scripts/smoke-rpc.ts
 */
import { RpcSession } from "../src/extension/rpc-session.ts";
import { discoverAgents } from "../src/extension/agents.ts";
import { accumulateResultFromEvents, getFinalOutput } from "../src/extension/event-accumulator.ts";

const CWD = process.cwd();

// ── Test 1: Agent discovery ──
console.log("=== Test 1: Agent discovery ===");
const discovery = discoverAgents(CWD, "both");
console.log(`Project agents dir: ${discovery.projectAgentsDir}`);
console.log(`Agents found: ${discovery.agents.length}`);
for (const a of discovery.agents) {
  console.log(`  - ${a.name} (${a.source}): ${a.description}`);
  console.log(`    tools: ${a.tools?.join(", ") || "none"}`);
}
const worker = discovery.agents.find((a) => a.name === "worker");
if (!worker) {
  console.error("FAIL: worker agent not found");
  process.exit(1);
}
console.log("PASS: worker agent found\n");

// ── Test 2: RPC session startup ──
console.log("=== Test 2: RPC session startup ===");
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
  console.log("Starting RPC session...");
  await session.start();
  console.log(`Session started: ${session.isStarted()}`);
  console.log("PASS: RPC session started\n");
} catch (err: any) {
  console.error(`FAIL: ${err.message}`);
  console.error(`Stderr: ${session.getStderr()}`);
  process.exit(1);
}

// ── Test 3: Send task and collect events ──
console.log("=== Test 3: Send task via RPC ===");
const events: any[] = [];
const unsubscribe = session.onEvent((event) => {
  events.push(event);
  if (event.type === "tool_execution_start") {
    console.log(`  [tool: ${event.toolName}]`);
  }
  if (event.type === "tool_execution_end") {
    const result = event.result;
    if (typeof result === "string") {
      console.log(`  [tool result: ${result.substring(0, 80)}...]`);
    } else {
      console.log(`  [tool result: ${JSON.stringify(result).substring(0, 80)}...]`);
    }
  }
});

// Handle UI requests from child
const uiUnsubscribe = session.onUIRequest((req) => {
  console.log(`  [UI request: ${req.method} - ${req.id}]`);
  const fireAndForget = ["notify", "setStatus", "setTitle", "setWidget", "set_editor_text"];
  if (fireAndForget.includes(req.method)) return;
  if (req.method === "confirm") {
    session.respondToUIRequest(req.id, { confirmed: true });
  } else if (req.method === "input") {
    session.respondToUIRequest(req.id, { value: "" });
  } else if (req.method === "select") {
    session.respondToUIRequest(req.id, { value: req.options?.[0] || "" });
  } else {
    session.respondToUIRequest(req.id, { cancelled: true });
  }
});

const task = "List the files in the project root directory (use ls or find). Report the file names. Do NOT edit any files.";
console.log(`Sending task: ${task.substring(0, 60)}...`);
session.prompt(`Task: ${task}`);

try {
  await session.waitForIdle(120_000);
  console.log("Agent finished.");
} catch (err: any) {
  console.error(`FAIL: ${err.message}`);
}

unsubscribe();
uiUnsubscribe();

// ── Analyze results ──
console.log("\n=== Test 3: Results ===");
const result = accumulateResultFromEvents(events);
console.log(`Events collected: ${events.length}`);
console.log(`Messages: ${result.messages.length}`);
console.log(`Usage: input=${result.usage.input}, output=${result.usage.output}, turns=${result.usage.turns}`);
console.log(`Model: ${result.model || "unknown"}`);
console.log(`Stop reason: ${result.stopReason || "unknown"}`);

const output = getFinalOutput(result.messages);
console.log(`\nFinal output:\n${output.substring(0, 500)}`);

if (result.messages.length === 0) {
  console.error("FAIL: No messages collected");
  process.exit(1);
}
console.log("\nPASS: Task completed\n");

// ── Cleanup ──
await session.stop();
console.log(`Exit code: ${session.getExitCode()}`);
console.log(`Stderr: ${session.getStderr().substring(0, 200) || "(none)"}`);

console.log("\n=== ALL TESTS PASSED ===");
process.exit(0);
