# Official Subagent Demo Migration and Bidirectional Communication Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DeepAgent's minimal runner with the full official Pi subagent example, then add parent-child agent communication on top of that official baseline.

**Architecture:** The official demo becomes the main implementation, not just reference material. DeepAgent keeps the official single / parallel / chain execution model, agent discovery, realtime JSONL parsing, `details`, `onUpdate`, abort handling, and TUI rendering. On top of that, DeepAgent adds a thin communication bridge: child agents can contact the parent, and the parent can steer a live child.

**Tech Stack:** TypeScript, Node.js, official `@earendil-works/pi-coding-agent` extension API, `RpcClient` (official RPC mode), project-local `.pi/extensions/`, TypeBox, Vitest, Windows PowerShell.

---

## Decision

Do not continue expanding the current minimal runner.

Use these official files as the implementation baseline:

```text
C:\Code\pi-learn\pi\packages\coding-agent\examples\extensions\subagent\index.ts
C:\Code\pi-learn\pi\packages\coding-agent\examples\extensions\subagent\agents.ts
```

The current DeepAgent V1 proved the basic path works, but it discards too much data:

- no realtime event handling
- no `Message[]`
- no usage stats
- no tool call list
- no model / stop reason / error message
- no structured `details`
- no `renderCall` / `renderResult`
- no abort handling
- no parallel / chain

Rebuilding those pieces locally would be reimplementing the official demo.

## Scope Reset

The following are explicitly not part of this stage:

- DeepAgent project-only policy
- extra DeepAgent safety hardening
- restricting to only `worker`
- hiding official parallel / chain
- forcing a custom result format before the official result pipeline exists
- replacing official rendering

This stage is intentionally bold:

```text
full official subagent demo
  + child -> parent contact
  + parent -> child steering
```

## Official Baseline To Keep

Keep the official demo behavior unless it directly conflicts with parent-child communication.

Must keep:

- Single mode: `{ agent, task }`
- Parallel mode: `{ tasks: [{ agent, task }] }`
- Chain mode: `{ chain: [{ agent, task }] }`
- `agentScope`: `user | project | both`
- user agents from `~/.pi/agent/agents`
- project agents from nearest `.pi/agents`
- project-agent confirmation via `ctx.ui.confirm`
- realtime JSONL line parsing
- full `Message[]` capture
- usage aggregation
- tool call extraction
- model / stopReason / errorMessage capture
- `SubagentDetails`
- `onUpdate`
- `renderCall`
- `renderResult`
- abort handling with terminate then kill
- parallel output cap

## Communication Transport: RPC Mode

### Why Not `--mode json`

`--mode json` is fire-and-forget. stdin is `"ignore"`, the child runs one prompt, streams JSON events to stdout, then exits. Extensions cannot listen to stdin in this mode. There is no official mechanism to inject messages into a running `--mode json` child.

### Why Not File System JSONL

An earlier draft proposed per-run `.deepagent/runs/<runId>/control.jsonl` + `events.jsonl` for cross-process transport. This works but adds unnecessary complexity: run-store, file watchers, environment variable path passing, file locking, and cleanup.

### Official Solution: `--mode rpc` + `RpcClient`

Pi provides `--mode rpc` — a headless, long-running, bidirectional JSONL protocol over stdin/stdout. The official `RpcClient` class (exported from `@earendil-works/pi-coding-agent`) wraps this protocol:

```ts
import { RpcClient } from "@earendil-works/pi-coding-agent";

const client = new RpcClient({ cwd: "/project", model: "claude-sonnet-4" });
await client.start();

// Send a prompt
await client.prompt("Task: inspect the project");

// Listen for events (streaming messages, tool calls, usage, etc.)
client.onEvent((event) => {
  if (event.type === "message_update") { /* ... */ }
});

// Wait for completion
await client.waitForIdle();

// Steer mid-run
await client.steer("Change direction: focus on tests");

// Follow-up after completion
await client.followUp("Also check README");

// Abort
await client.abort();

// Cleanup
await client.stop();
```

### RPC Protocol Summary

**Commands (parent → child via stdin):**

```ts
{ type: "prompt", message: "..." }         // Start a task
{ type: "steer", message: "..." }          // Mid-run steering
{ type: "follow_up", message: "..." }      // After completion
{ type: "abort" }                           // Abort
{ type: "get_state" }                       // Query state
{ type: "get_messages" }                    // Get all messages
```

**Events (child → parent via stdout):**

```ts
{ type: "agent_start" }                     // Agent begins
{ type: "message_update", ... }             // Streaming content
{ type: "message_end", message: Message }   // Full message with usage
{ type: "tool_execution_start", ... }       // Tool call begins
{ type: "tool_execution_end", ... }         // Tool call ends
{ type: "agent_end" }                       // Agent done
{ type: "extension_ui_request", ... }       // Extension needs user input
```

**Extension UI sub-protocol (child -> parent -> child):**

When a child extension calls `ctx.ui.confirm()` / `ctx.ui.input()` / `ctx.ui.select()`:
1. Child emits `extension_ui_request` to stdout
2. Parent receives the event, processes it, and sends back `extension_ui_response` via stdin
3. Child extension receives the response and continues

This is the official, supported channel for child→parent requests.

Important implementation note: the exported `RpcClient` covers `prompt`, `steer`, `followUp`, `abort`, state, and message APIs, but the current source does not expose a public `sendExtensionUiResponse()` helper. For dialog responses, use the official RPC protocol directly, following `packages/coding-agent/examples/rpc-extension-ui.ts`, or wrap/adapt `RpcClient` with one extra public response method. Do not reintroduce a file-system transport.

## Communication Requirements

### Child → Parent (`contact_supervisor`)

Child agents need a tool:

```text
contact_supervisor
```

Reasons:

- `progress_update`: child reports meaningful progress; child continues.
- `need_decision`: child needs supervisor input; child pauses and waits.

**Implementation using `extension_ui_request`:**

The child bridge extension registers `contact_supervisor`. When called:

- For `progress_update`: extension writes a custom event and continues (no blocking).
- For `need_decision`: extension calls `ctx.ui.confirm()` or `ctx.ui.input()`, which triggers the official `extension_ui_request` → parent → `extension_ui_response` round-trip. The child blocks until the parent responds.

Parent side: the extension running in the parent Pi session receives `extension_ui_request` events from the child's RPC stream and can auto-respond or surface the decision to the parent LLM.

### Parent → Child (steering)

Directly use `RpcClient`:

```ts
await client.steer("Change direction: inspect tests first.");
```

No file system, no inbox, no environment variables. The RPC protocol handles it.

For foreground runs: `client.prompt()` + `client.waitForIdle()` — blocking, same as current `--mode json`.

For background runs: `client.prompt()` returns immediately, parent can `client.steer()` at any time, `client.onEvent()` streams progress.

## Why Not Direct `pi-intercom` Dependency

Use `pi-intercom` as protocol inspiration, not as the first runtime dependency.

Borrow:

- `contact_supervisor`
- `need_decision`
- `progress_update`
- "do not use supervisor contact for routine completion"

Do not copy yet:

- local broker
- session registry
- presence
- overlay UI
- session picker
- reply tracker
- `interview_request`
- multi-session target resolution

## File Strategy

Replace the local minimal implementation with official-demo-derived code:

- Replace: `C:\Code\DeepAgent\src\extension\tool.ts`
- Replace: `C:\Code\DeepAgent\src\extension\agents.ts`
- Keep or rewrite as wrappers: `types.ts`, `json-events.ts`, `pi-runner.ts`
- Add only if needed: `C:\Code\DeepAgent\src\extension\rpc-session.ts` as a thin wrapper around official RPC protocol / `RpcClient` for extension UI responses.
- Add: `C:\Code\DeepAgent\src\extension\child-bridge.ts`
- Do NOT add: `run-store.ts` (not needed — RPC replaces file system transport)
- Add tests around official behavior plus communication bridge.

The old minimal-runner modules can be removed once official-demo-derived code owns the behavior.

## Runtime Model

### Foreground Official Modes

Official modes stay available:

```json
{ "agent": "worker", "task": "inspect files" }
```

```json
{
  "tasks": [
    { "agent": "scout", "task": "find relevant files" },
    { "agent": "reviewer", "task": "review the plan" }
  ],
  "agentScope": "both"
}
```

```json
{
  "chain": [
    { "agent": "scout", "task": "collect evidence" },
    { "agent": "reviewer", "task": "review based on {previous}" }
  ]
}
```

These use `RpcClient.prompt()` + `RpcClient.waitForIdle()` instead of raw `spawn` + `--mode json`. All official rendering, details, and onUpdate behavior preserved.

### Background Run For Steering

```json
{
  "agent": "worker",
  "task": "start implementation and wait for steering if needed",
  "async": true
}
```

Return immediately:

```text
Run: <runId>
State: running
Control: subagent_control({ runId, action: "steer", message: "..." })
Status: subagent_status({ runId })
```

Then parent can steer:

```json
{
  "runId": "<runId>",
  "action": "steer",
  "message": "Stop editing config; switch to README and tests only."
}
```

Implementation: `RpcClient` instance is stored in a `Map<runId, RpcClient>`. `subagent_control` calls `client.steer()`. `subagent_status` reads from event buffer.

## Task 1: Replace Baseline With Official Demo

**Files:**

- Modify: `C:\Code\DeepAgent\src\extension\tool.ts`
- Modify: `C:\Code\DeepAgent\src\extension\agents.ts`
- Modify: `C:\Code\DeepAgent\src\extension\types.ts`
- Update tests under `C:\Code\DeepAgent\src\extension\*.test.ts`

- [ ] **Step 1: Copy official demo structure**

Use the official `index.ts` and `agents.ts` as the implementation source.

Keep:

- `UsageStats`
- `SingleResult`
- `SubagentDetails`
- `getFinalOutput`
- `getDisplayItems`
- `runSingleAgent`
- `mapWithConcurrencyLimit`
- official schemas
- `renderCall`
- `renderResult`

- [ ] **Step 2: Adapt imports and package names**

Keep imports aligned with this project dependencies:

```ts
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
```

- [ ] **Step 3: Preserve official tool schema**

The `subagent` tool should accept official modes:

```ts
agent?: string;
task?: string;
tasks?: Array<{ agent: string; task: string; cwd?: string }>;
chain?: Array<{ agent: string; task: string; cwd?: string }>;
agentScope?: "user" | "project" | "both";
confirmProjectAgents?: boolean;
cwd?: string;
```

- [ ] **Step 4: Add `async` field only after official foreground behavior passes**

Do not mix async into the first migration commit. First get official foreground behavior green.

- [ ] **Step 5: Run tests**

Run:

```powershell
npm run check
```

Expected:

```text
typecheck exits 0
vitest exits 0
```

## Task 2: Switch to Official RPC Transport

**Files:**

- Modify: `C:\Code\DeepAgent\src\extension\tool.ts`
- Modify: `C:\Code\DeepAgent\src\extension\types.ts`
- Add only if needed: `C:\Code\DeepAgent\src\extension\rpc-session.ts`
- Add tests for RPC integration.

- [ ] **Step 1: Replace `spawn + --mode json` with official RPC**

In `runSingleAgent`, replace:

```ts
// OLD: raw spawn + --mode json
const proc = spawn(command, ["--mode", "json", ...args], { stdio: ["ignore", "pipe", "pipe"] });
```

With:

```ts
// NEW: official RPC transport
const client = new RpcClient({ cwd, model, env: { SUBAGENT_CHILD: "1" } });
await client.start();
```

Use exported `RpcClient` directly for `prompt`, `steer`, `followUp`, `abort`, `getState`, and `getMessages`. If `extension_ui_response` is required, add a tiny wrapper based on official `examples/rpc-extension-ui.ts` so the parent can write raw UI responses to stdin.

- [ ] **Step 2: Route events through `onEvent` instead of raw stdout parsing**

Replace the manual `proc.stdout.on("data", ...)` JSONL parser with:

```ts
client.onEvent((event) => {
  if (event.type === "message_end" && event.message) {
    currentResult.messages.push(event.message as Message);
    // ... accumulate usage, model, stopReason (same logic as official demo)
    emitUpdate();
  }
});
```

- [ ] **Step 3: Use `prompt` + `waitForIdle` for foreground runs**

```ts
await client.prompt(`Task: ${task}`);
await client.waitForIdle();
```

- [ ] **Step 4: Handle `extension_ui_request` events**

Add handler for child extension UI requests (the `contact_supervisor` bridge):

```ts
client.onEvent((event) => {
  if (event.type === "extension_ui_request") {
    // Record contact_supervisor request.
    // For dialog methods, respond with extension_ui_response over stdin.
  }
});
```

Do not assume `RpcClient` currently exposes this response writer; verify the installed version. If absent, use the local `rpc-session.ts` wrapper instead of touching files on disk.

- [ ] **Step 5: Cleanup on completion**

```ts
await client.stop();
```

## Task 3: Add Child Bridge Extension

**Files:**

- Create: `C:\Code\DeepAgent\src\extension\child-bridge.ts`
- Modify: `RpcClient` spawn args in `tool.ts` (add `--extension` for child bridge)
- Add tests for child bridge.

- [ ] **Step 1: Load child bridge into every child process**

When creating `RpcClient`, add extra args:

```ts
const client = new RpcClient({
  cwd,
  model,
  args: ["--extension", absolutePathToChildBridge],
  env: { SUBAGENT_CHILD: "1" },
});
```

- [ ] **Step 2: Register `contact_supervisor` only in child context**

Child bridge registers:

```ts
contact_supervisor({
  reason: "progress_update" | "need_decision",
  message: string
})
```

- [ ] **Step 3: Implement progress_update (non-blocking)**

For `progress_update`, write directly to stderr or emit a custom message:

```ts
pi.sendMessage({
  customType: "deepagent_supervisor_contact",
  content: message,
  display: true,
  details: { reason: "progress_update", agent, runId },
});
```

This emits a custom event through the RPC event stream. No blocking, child continues.

- [ ] **Step 4: Implement need_decision (blocking via extension_ui_request)**

For `need_decision`, use the official UI round-trip:

```ts
const answer = await ctx.ui.input("Supervisor decision needed", message);
// Child blocks until parent responds via extension_ui_response
```

This is the official mechanism. No custom protocol needed.

- [ ] **Step 5: No custom JSONL events needed**

Remove the old `deepagent_supervisor_contact` JSONL event type. Use official `sendMessage` + `extension_ui_request` instead.

## Task 4: Background Run Mode

**Files:**

- Modify: `C:\Code\DeepAgent\src\extension\tool.ts`
- Add tests for run lifecycle.

- [ ] **Step 1: Add async mode**

Extend `subagent` params:

```ts
async?: boolean;
```

If `async: true`, start the `RpcClient`, call `prompt()`, and return immediately with run metadata.

- [ ] **Step 2: Keep official foreground behavior unchanged**

If `async` is omitted or false, official foreground single / parallel / chain behavior remains unchanged (`prompt` + `waitForIdle`).

- [ ] **Step 3: Store RpcClient instances in-process**

Track active runs:

```ts
const activeRuns = new Map<string, {
  client: RpcClient;
  agent: string;
  task: string;
  startedAt: number;
  events: AgentEvent[];
}>();
```

No file system, no `.deepagent/runs/` directory. Everything is in-process.

## Task 5: Control and Status Tools

**Files:**

- Modify: `C:\Code\DeepAgent\src\extension\tool.ts`
- Add tests for control/status tools.

- [ ] **Step 1: Add `subagent_control` tool**

Schema:

```ts
{
  runId: string;
  action: "steer" | "follow_up";
  message: string;
}
```

Behavior:

```ts
const run = activeRuns.get(runId);
if (action === "steer") await run.client.steer(message);
if (action === "follow_up") await run.client.followUp(message);
```

No file writes. Direct RPC call.

- [ ] **Step 2: Add `subagent_status` tool**

Schema:

```ts
{
  runId: string;
}
```

Behavior:

- read from `activeRuns.get(runId)`
- include buffered events (supervisor contacts, streaming updates)
- include final result if complete

- [ ] **Step 3: Add `subagent_abort` tool**

Schema:

```ts
{
  runId: string;
}
```

Behavior:

```ts
const run = activeRuns.get(runId);
await run.client.abort();
```

## Task 6: Rendering and Details

**Files:**

- Modify: `C:\Code\DeepAgent\src\extension\tool.ts`

- [ ] **Step 1: Preserve official renderers**

Keep official:

- `renderCall`
- `renderResult`
- collapsed and expanded views
- tool call formatting
- usage formatting

- [ ] **Step 2: Add communication details**

Extend details with optional:

```ts
supervisorContacts?: SupervisorContactEvent[];
controlMessages?: string[];
runId?: string;
async?: boolean;
```

Do not remove official `SubagentDetails`.

## Task 7: Prompt and Docs

**Files:**

- Modify: `C:\Code\DeepAgent\.pi\agents\worker.md`
- Modify: `C:\Code\DeepAgent\.pi\prompts\parent.md`
- Modify: `C:\Code\DeepAgent\.pi\skills\subagent\SKILL.md`
- Modify: `C:\Code\DeepAgent\README.md`

- [ ] **Step 1: Update worker prompt**

Worker should know:

- use `contact_supervisor` for meaningful progress or decisions
- accept parent steering messages as authoritative
- do not use supervisor contact for routine completion

- [ ] **Step 2: Update parent prompt**

Parent should know:

- foreground official modes are available
- async mode is required for live steering
- use `subagent_control` to change child direction
- use `subagent_status` to inspect result and events

- [ ] **Step 3: Update README**

README should describe:

```text
Official subagent demo baseline
Foreground: single / parallel / chain (via RpcClient)
Background: async child with subagent_control steering
Child -> parent: contact_supervisor (via sendMessage + extension_ui_request)
Parent -> child: subagent_control steer/follow_up (via RpcClient.steer/followUp)
Transport: official RPC mode (--mode rpc), no file system bridge
```

## Task 8: Verification

- [ ] **Step 1: Unit tests**

Run:

```powershell
npm run check
```

- [ ] **Step 2: Foreground single smoke**

Inside Pi:

```text
Use subagent with agent "worker" to inspect C:\Code\DeepAgent and return entrypoints.
```

Expected:

- official render appears
- tool calls visible in expanded result
- usage/model/stop reason details available

- [ ] **Step 3: Parallel smoke**

Inside Pi:

```text
Use subagent with two parallel worker tasks: one lists README-relevant files and one lists src/extension files. Do not edit files.
```

Expected:

- realtime parallel progress
- aggregated result

- [ ] **Step 4: Child -> parent contact smoke**

Inside Pi:

```text
Use subagent worker to send contact_supervisor progress_update saying "checking entrypoints", then return result.
```

Expected:

- progress event appears before final result

- [ ] **Step 5: Parent -> child steering smoke**

Start async child:

```text
Start subagent worker asynchronously to inspect the project slowly and wait for steering.
```

Then steer:

```text
Use subagent_control to tell the child: "Change direction: inspect README and docs only."
```

Expected:

- child receives steering message
- final result reflects the changed direction

## Completion Criteria

The migration is complete when:

- official single / parallel / chain behavior works (via `RpcClient`)
- official `onUpdate` and rendering work
- official `details.results[]` contains full messages, usage, tool calls, model, stop reason, and errors
- child can contact parent (via `sendMessage` + `extension_ui_request`)
- parent can steer a live async child (via `RpcClient.steer()`)
- no file system bridge or run-store exists
- `npm run check` passes
- real Pi smoke confirms foreground and async control paths

## Appendix: RPC Mode Evidence

### RpcClient API (`@earendil-works/pi-coding-agent`)

```ts
// Exported from package index
import { RpcClient, type RpcClientOptions, type RpcEventListener } from "@earendil-works/pi-coding-agent";

// Source: packages/coding-agent/src/modes/rpc/rpc-client.ts
class RpcClient {
  constructor(options: RpcClientOptions)
  async start(): Promise<void>
  async stop(): Promise<void>
  onEvent(listener: (event: AgentEvent) => void): () => void
  async prompt(message: string, images?: ImageContent[]): Promise<void>
  async steer(message: string, images?: ImageContent[]): Promise<void>
  async followUp(message: string, images?: ImageContent[]): Promise<void>
  async abort(): Promise<void>
  async getState(): Promise<RpcSessionState>
  async getMessages(): Promise<AgentMessage[]>
  waitForIdle(timeout?: number): Promise<void>
  collectEvents(timeout?: number): Promise<AgentEvent[]>
  async promptAndWait(message: string, images?: ImageContent[], timeout?: number): Promise<AgentEvent[]>
}
```

### RpcClientOptions

```ts
interface RpcClientOptions {
  cliPath?: string;     // Path to CLI entry (default: dist/cli.js)
  cwd?: string;         // Working directory
  env?: Record<string, string>;  // Extra env vars
  provider?: string;    // Provider name
  model?: string;       // Model ID
  args?: string[];      // Additional CLI args (e.g. --extension)
}
```

### Extension UI Request/Response Protocol

Child extension calls → triggers `extension_ui_request` event → parent responds via stdin:

```json
// stdout: child needs decision
{ "type": "extension_ui_request", "id": "uuid", "method": "confirm", "title": "Need decision", "message": "..." }
{ "type": "extension_ui_request", "id": "uuid", "method": "input", "title": "Progress report", "placeholder": "" }

// stdin: parent responds
{ "type": "extension_ui_response", "id": "uuid", "confirmed": true }
{ "type": "extension_ui_response", "id": "uuid", "value": "user's answer" }
{ "type": "extension_ui_response", "id": "uuid", "cancelled": true }
```

### Key Source Files

- `packages/coding-agent/src/modes/rpc/rpc-client.ts` — RpcClient implementation
- `packages/coding-agent/src/modes/rpc/rpc-types.ts` — RPC protocol types
- `packages/coding-agent/src/modes/rpc/jsonl.ts` — JSONL serialization
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts` — RPC mode server (child side)
- `packages/coding-agent/examples/rpc-extension-ui.ts` — official raw RPC client example with extension UI responses
- `packages/coding-agent/src/core/extensions/types.ts:1177-1190` — sendUserMessage API
- `packages/coding-agent/examples/extensions/send-user-message.ts` — sendUserMessage example
