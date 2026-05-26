/**
 * RPC Session Manager — spawns a Pi process in --mode rpc and manages
 * bidirectional JSONL communication over stdin/stdout.
 *
 * This replaces RpcClient (which has all-private members and cannot
 * be subclassed) with direct process control.
 *
 * stdin  → JSONL commands: prompt, steer, follow_up, abort, extension_ui_response
 * stdout ← JSONL: response, agent events, extension_ui_request
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { RpcEvent } from "./types.ts";

/** Options for creating an RPC session */
export interface RpcSessionOptions {
  /** Working directory for the child process */
  cwd: string;
  /** Environment variables (merged with process.env) */
  env?: Record<string, string>;
  /** Model to use (passed as --model) */
  model?: string;
  /** Tools to enable (passed as --tools) */
  tools?: string[];
  /** System prompt to append (written to temp file, passed as --append-system-prompt) */
  systemPrompt?: string;
  /** Additional CLI arguments */
  args?: string[];
}

/** Pending extension UI request from child */
export interface ExtensionUIRequest {
  id: string;
  method: string;
  [key: string]: any;
}

type EventListener = (event: RpcEvent) => void;
type UIRequestListener = (request: ExtensionUIRequest) => void;

export class RpcSession {
  private proc: ChildProcess | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private listeners: EventListener[] = [];
  private uiListeners: UIRequestListener[] = [];
  private stderr = "";
  private exitCode: number | null = null;
  private started = false;
  private startError: string | null = null;
  private tmpPromptDir: string | null = null;
  private tmpPromptPath: string | null = null;

  constructor(private options: RpcSessionOptions) {}

  /**
   * Determine how to invoke Pi based on the current runtime environment.
   * Mirrors the official subagent example.
   */
  private static getPiInvocation(args: string[]): { command: string; args: string[] } {
    const currentScript = process.argv[1];
    const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

    if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
      // If process.execPath is a generic node/bun, check whether the script
      // looks like a Pi entrypoint (e.g. pi.js bundle) vs a user .ts file.
      // TypeScript .ts files can't be run directly by Node without tsx/ts-node.
      const isTsScript = currentScript.endsWith(".ts") || currentScript.endsWith(".tsx");
      const execName = path.basename(process.execPath).toLowerCase();
      const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);

      if (isTsScript && isGenericRuntime) {
        // Running via node/bun + .ts file — fall through to resolve pi
      } else {
        return { command: process.execPath, args: [currentScript, ...args] };
      }
    }

    const execName = path.basename(process.execPath).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
    if (!isGenericRuntime) {
      return { command: process.execPath, args };
    }

    // On Windows, "pi" is a shell script/cmd wrapper — can't be spawned with shell:false.
    // Resolve the actual Node entry point instead.
    const resolved = RpcSession.resolvePiCliPath();
    if (resolved) {
      return { command: process.execPath, args: [resolved, ...args] };
    }

    return { command: "pi", args };
  }

  /** Try to locate the Pi CLI entry point (cli.js) */
  private static resolvePiCliPath(): string | null {
    // Strategy 1: check node_modules in the same directory as node.exe
    const nodeDir = path.dirname(process.execPath);
    const globalCli = path.join(nodeDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    if (fs.existsSync(globalCli)) return globalCli;

    // Strategy 2: check local node_modules
    for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
      const localCli = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
      if (fs.existsSync(localCli)) return localCli;
      const parent = path.dirname(dir);
      if (parent === dir) break;
    }

    return null;
  }

  /** Build RPC mode arguments */
  private buildArgs(): string[] {
    const args: string[] = ["--mode", "rpc", "--no-session"];

    if (this.options.model) {
      args.push("--model", this.options.model);
    }
    if (this.options.tools && this.options.tools.length > 0) {
      args.push("--tools", this.options.tools.join(","));
    }
    if (this.options.systemPrompt?.trim()) {
      args.push("--append-system-prompt", this.tmpPromptPath!);
    }
    if (this.options.args) {
      args.push(...this.options.args);
    }

    return args;
  }

  /** Write system prompt to a secure temp file */
  private async writePromptToTempFile(agentName: string, prompt: string): Promise<void> {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
    const safeName = agentName.replace(/[^\w.-]+/g, "_");
    const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
    await withFileMutationQueue(filePath, async () => {
      await fs.promises.writeFile(filePath, prompt, {
        encoding: "utf-8",
        mode: 0o600,
      });
    });
    this.tmpPromptDir = tmpDir;
    this.tmpPromptPath = filePath;
  }

  /**
   * Start the RPC session: spawn child process, set up JSONL parsing.
   * Returns a promise that resolves when the process is ready (first event received)
   * or rejects on immediate startup failure.
   */
  async start(): Promise<void> {
    // Write temp prompt file if needed
    if (this.options.systemPrompt?.trim()) {
      await this.writePromptToTempFile("subagent", this.options.systemPrompt);
    }

    const args = this.buildArgs();
    const invocation = RpcSession.getPiInvocation(args);

    return new Promise<void>((resolve, reject) => {
      const env = {
        ...process.env,
        ...this.options.env,
      };

      this.proc = spawn(invocation.command, invocation.args, {
        cwd: this.options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });

      // Collect stderr
      this.proc.stderr!.on("data", (data: Buffer) => {
        this.stderr += data.toString();
      });

      // Track exit
      this.proc.on("close", (code) => {
        this.exitCode = code ?? 0;
        this.rl?.close();
      });

      this.proc.on("error", (err) => {
        this.startError = err.message;
        reject(err);
      });

      // Set up readline on stdout
      this.rl = createInterface({ input: this.proc.stdout! });

      let settled = false;

      this.rl.on("line", (line: string) => {
        if (!line.trim()) return;
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Ignore malformed JSONL lines
          return;
        }

        const event = parsed as RpcEvent;

        // Categorize: response, extension_ui_request, or agent event
        if (event.type === "extension_ui_request") {
          const uiReq = event as ExtensionUIRequest;
          for (const listener of this.uiListeners) {
            listener(uiReq);
          }
          return; // Don't emit as generic event
        }

        // Emit to all event listeners
        for (const listener of this.listeners) {
          listener(event);
        }

        // Resolve start promise on first meaningful event
        if (!settled) {
          if (event.type === "agent_start" || event.type === "response") {
            this.started = true;
            settled = true;
            resolve();
          }
        }
      });

      // Timeout: if process exits before first event, reject
      const startupTimeout = setTimeout(() => {
        if (!settled) {
          if (this.exitCode !== null) {
            settled = true;
            reject(new Error(`RPC process exited before startup with code ${this.exitCode}: ${this.stderr}`));
          }
          // If still running but no event, resolve anyway — the process is alive
          if (this.proc && !this.proc.killed && this.exitCode === null) {
            this.started = true;
            settled = true;
            resolve();
          }
        }
      }, 2000);

      // Clean up timeout on resolution
      const cleanup = () => clearTimeout(startupTimeout);
      const origResolve = resolve;
      const wrappedResolve = () => { cleanup(); origResolve(); };
      // Already wrapped above in the line handler, just clean up on reject too
      reject = ((origReject: (reason: any) => void) => {
        return (reason: any) => { cleanup(); origReject(reason); };
      })(reject);
    });
  }

  /** Subscribe to agent events. Returns unsubscribe function. */
  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Subscribe to extension UI requests. Returns unsubscribe function. */
  onUIRequest(listener: UIRequestListener): () => void {
    this.uiListeners.push(listener);
    return () => {
      this.uiListeners = this.uiListeners.filter((l) => l !== listener);
    };
  }

  /** Send a JSONL command to child's stdin */
  private send(obj: Record<string, unknown>): void {
    if (!this.proc || this.proc.killed) {
      throw new Error("RPC session is not active");
    }
    this.proc.stdin!.write(`${JSON.stringify(obj)}\n`);
  }

  /** Send a prompt command to the child */
  prompt(message: string): void {
    this.send({ type: "prompt", message });
  }

  /** Send a steer command (modifies current agent behavior) */
  steer(message: string): void {
    this.send({ type: "steer", message });
  }

  /** Send a follow-up command (continues after agent_end) */
  followUp(message: string): void {
    this.send({ type: "follow_up", message });
  }

  /** Send an abort command */
  abort(): void {
    this.send({ type: "abort" });
  }

  /** Respond to an extension UI request from the child */
  respondToUIRequest(id: string, response: { confirmed?: boolean; value?: string; cancelled?: boolean }): void {
    this.send({ type: "extension_ui_response", id, ...response });
  }

  /**
   * Wait for agent_end event with optional timeout.
   * Returns all collected events.
   */
  waitForIdle(timeoutMs = 300_000): Promise<RpcEvent[]> {
    return new Promise((resolve, reject) => {
      const events: RpcEvent[] = [];
      const unsubscribe = this.onEvent((event) => {
        events.push(event);
        if (event.type === "agent_end") {
          cleanup();
          resolve(events);
        }
      });

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`waitForIdle timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        unsubscribe();
        clearTimeout(timer);
      };
    });
  }

  /** Force-stop the child process: SIGTERM → wait → SIGKILL */
  async stop(): Promise<void> {
    if (!this.proc || this.proc.killed) return;

    return new Promise<void>((resolve) => {
      const proc = this.proc!;
      let settled = false;

      const cleanup = () => {
        this.cleanupTempFiles();
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      // Try graceful SIGTERM
      try {
        proc.kill("SIGTERM");
      } catch {
        // On Windows, kill() uses TerminateProcess directly
        proc.kill();
        cleanup();
        return;
      }

      // Force SIGKILL after 5s (meaningful on Unix, no-op on Windows)
      const killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
        cleanup();
      }, 5000);

      proc.on("close", () => {
        clearTimeout(killTimer);
        cleanup();
      });

      // Safety timeout
      setTimeout(() => {
        try { proc.kill(); } catch { /* already dead */ }
        cleanup();
      }, 10000);
    });
  }

  /** Get accumulated stderr */
  getStderr(): string {
    return this.stderr;
  }

  /** Get process exit code (null if still running) */
  getExitCode(): number | null {
    return this.exitCode;
  }

  /** Whether the session has started successfully */
  isStarted(): boolean {
    return this.started;
  }

  /** Clean up temp prompt files */
  private cleanupTempFiles(): void {
    if (this.tmpPromptPath) {
      try { fs.unlinkSync(this.tmpPromptPath); } catch { /* ignore */ }
      this.tmpPromptPath = null;
    }
    if (this.tmpPromptDir) {
      try { fs.rmdirSync(this.tmpPromptDir); } catch { /* ignore */ }
      this.tmpPromptDir = null;
    }
  }
}
