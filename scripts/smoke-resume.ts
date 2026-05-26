/**
 * Smoke test: Verify session resume — keepAlive → pool → resume → release.
 *
 * Flow:
 * 1. Start a chain-like run, let it complete, add session to pool (keepAlive)
 * 2. Resume the pooled session with a follow-up task
 * 3. Release the session
 *
 * Run: npx tsx scripts/smoke-resume.ts
 */
import { RpcSession } from "../src/extension/rpc-session.ts";
import { discoverAgents } from "../src/extension/agents.ts";
import { accumulateEvent, getFinalOutput } from "../src/extension/event-accumulator.ts";
import { clearAllRuns } from "../src/extension/run-registry.ts";
import {
  addToPool,
  getFromPool,
  getPoolSize,
  getPoolRunIds,
  removeFromPool,
  releaseAll,
  registerExitHandlers,
} from "../src/extension/session-pool.ts";
import type { AccumulatedResult } from "../src/extension/types.ts";

const CWD = process.cwd();
const IDLE_TIMEOUT = 120_000;

// Cleanup
clearAllRuns();
releaseAll();
registerExitHandlers();

// ── Test 1: Agent discovery ──
console.log("=== Test 1: Agent discovery ===");
const discovery = discoverAgents(CWD, "both");
const worker = discovery.agents.find((a) => a.name === "worker");
if (!worker) {
  console.error("FAIL: worker agent not found");
  process.exit(1);
}
console.log("PASS: worker agent found\n");

// ── Helper: run task and wait for completion ──
async function runTaskAndWait(
  session: RpcSession,
  task: string,
): Promise<{ events: any[]; accumulated: AccumulatedResult }> {
  const accumulated: AccumulatedResult = {
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    stderr: "",
  };
  const events: any[] = [];

  // Handle UI requests
  session.onUIRequest((req) => {
    const ff = ["notify", "setStatus", "setTitle", "setWidget", "set_editor_text"];
    if (ff.includes(req.method)) return;
    if (req.method === "confirm") session.respondToUIRequest(req.id, { confirmed: true });
    else if (req.method === "input") session.respondToUIRequest(req.id, { value: "" });
    else session.respondToUIRequest(req.id, { cancelled: true });
  });

  // Send prompt
  session.prompt(`Task: ${task}`);

  // Wait for agent_end
  const allEvents = await session.waitForIdle(IDLE_TIMEOUT);
  for (const event of allEvents) {
    events.push(event);
    accumulateEvent(accumulated, event);
  }

  return { events, accumulated };
}

// ── Test 2: Start session, run task, pool it ──
console.log("=== Test 2: Run task + keepAlive (pool) ===");
const session = new RpcSession({
  cwd: CWD,
  env: { SUBAGENT_CHILD: "1", SUBAGENT_DEPTH: "1" },
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

const task1 = "List the files in the project root directory. Report file names only. Do NOT edit any files.";
const { events: events1, accumulated: acc1 } = await runTaskAndWait(session, task1);

console.log(`Task 1 completed:`);
console.log(`  Events: ${events1.length}`);
console.log(`  Messages: ${acc1.messages.length}`);
console.log(`  Turns: ${acc1.usage.turns}`);
console.log(`  Session alive: ${session.isAlive()}`);

if (acc1.messages.length === 0) {
  console.error("FAIL: No messages from task 1");
  await session.stop();
  process.exit(1);
}
console.log("PASS: Task 1 completed\n");

// Pool the session (keepAlive)
const runId = addToPool(session, "worker", "project", acc1.usage);
console.log(`Session pooled: runId=${runId}`);
console.log(`Pool size: ${getPoolSize()}`);
console.log(`Pool run IDs: ${getPoolRunIds().join(", ")}`);

if (getPoolSize() !== 1) {
  console.error("FAIL: Pool size should be 1");
  process.exit(1);
}
console.log("PASS: Session pooled\n");

// ── Test 3: Resume the pooled session ──
console.log("=== Test 3: Resume pooled session ===");
const pooled = getFromPool(runId);
if (!pooled) {
  console.error("FAIL: Could not retrieve pooled session");
  process.exit(1);
}

// Remove from pool (we'll re-pool or release after resume)
removeFromPool(runId);
console.log(`Removed from pool. Pool size: ${getPoolSize()}`);

const resumedSession = pooled.session;
console.log(`Resumed session alive: ${resumedSession.isAlive()}`);

const task2 = "What is 2 + 2? Answer with just the number.";
const { events: events2, accumulated: acc2 } = await runTaskAndWait(resumedSession, task2);

console.log(`Task 2 (resume) completed:`);
console.log(`  Events: ${events2.length}`);
console.log(`  Messages: ${acc2.messages.length}`);
console.log(`  Turns: ${acc2.usage.turns}`);

const output2 = getFinalOutput(acc2.messages);
console.log(`  Output: ${output2.substring(0, 200)}`);

if (acc2.messages.length === 0) {
  console.error("FAIL: No messages from resumed task");
  await resumedSession.stop();
  process.exit(1);
}
console.log("PASS: Resume worked\n");

// ── Test 4: Release the session ──
console.log("=== Test 4: Release session ===");
const releaseId = addToPool(resumedSession, "worker", "project", acc2.usage);
console.log(`Re-pooled for release: ${releaseId}`);

const released = removeFromPool(releaseId);
if (released) {
  await released.session.stop();
  console.log("Session stopped and released");
} else {
  console.error("FAIL: Could not remove from pool for release");
  process.exit(1);
}

console.log(`Pool size after release: ${getPoolSize()}`);

if (getPoolSize() !== 0) {
  console.error("FAIL: Pool should be empty after release");
  process.exit(1);
}
console.log("PASS: Session released\n");

// ── Summary ──
console.log("=== ALL RESUME TESTS PASSED ===");
console.log(`  Task 1: ${events1.length} events, ${acc1.usage.turns} turns`);
console.log(`  Task 2 (resume): ${events2.length} events, ${acc2.usage.turns} turns`);
console.log(`  Pool: empty after release`);
process.exit(0);
