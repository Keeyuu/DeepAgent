/**
 * Session Pool — manages a pool of idle RpcSessions for resume/reuse.
 *
 * The pool works alongside run-registry: active runs are tracked there,
 * idle/reusable sessions live here. The combined count must not exceed
 * MAX_TOTAL_CHILDREN.
 *
 * Import direction: session-pool → run-registry (unidirectional).
 */

import type { RpcSession } from "./rpc-session.ts";
import { getActiveRunCount } from "./run-registry.ts";
import type { UsageStats } from "./types.ts";

/** Maximum combined children (pooled + active runs) */
export const MAX_TOTAL_CHILDREN = 8;

/** Idle timeout in milliseconds (30 minutes) */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** A session held in the pool for potential reuse */
export interface PooledSession {
  /** Unique run ID (run_XXXXXXXX) */
  runId: string;
  /** The live RPC session */
  session: RpcSession;
  /** Agent name */
  agent: string;
  /** Where the agent definition comes from */
  agentSource: "user" | "project" | "unknown";
  /** When this entry was created */
  createdAt: number;
  /** Last time this entry was touched */
  lastActivityAt: number;
  /** Accumulated usage stats */
  usage: UsageStats;
}

// ---- Internal state ----

const pool = new Map<string, PooledSession>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let exitHandlersRegistered = false;

// ---- Helpers ----

/** Generate a run ID: run_ + 8 hex chars from crypto.randomUUID */
function generateRunId(): string {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return `run_${uuid.slice(0, 8)}`;
}

/** Combined child count: pooled + actively running */
export function totalChildCount(): number {
  return pool.size + getActiveRunCount();
}

// ---- Core pool operations ----

/**
 * Add a session to the pool for later reuse.
 * Throws if the combined child count would exceed MAX_TOTAL_CHILDREN.
 */
export function addToPool(
  session: RpcSession,
  agent: string,
  agentSource: "user" | "project" | "unknown",
  usage: UsageStats,
  existingRunId?: string,
): string {
  if (totalChildCount() >= MAX_TOTAL_CHILDREN) {
    throw new Error(
      `Max total children reached (${MAX_TOTAL_CHILDREN}). Cannot add to pool.`,
    );
  }

  const runId = existingRunId ?? generateRunId();
  const now = Date.now();

  pool.set(runId, {
    runId,
    session,
    agent,
    agentSource,
    createdAt: now,
    lastActivityAt: now,
    usage: { ...usage },
  });

  scheduleIdleCleanup();
  return runId;
}

/**
 * Retrieve a pooled session by run ID.
 * Returns undefined if not found or if the session is dead (auto-removes dead sessions).
 */
export function getFromPool(runId: string): PooledSession | undefined {
  const entry = pool.get(runId);
  if (!entry) return undefined;

  // Auto-remove dead sessions
  if (!entry.session.isAlive()) {
    pool.delete(runId);
    return undefined;
  }

  return entry;
}

/**
 * Update activity timestamp and usage for a pooled session.
 * Reschedules idle cleanup.
 */
export function updatePoolActivity(
  runId: string,
  usage: UsageStats,
): boolean {
  const entry = pool.get(runId);
  if (!entry) return false;

  entry.lastActivityAt = Date.now();
  entry.usage = { ...usage };
  scheduleIdleCleanup();
  return true;
}

/** Remove a session from the pool. Returns the removed entry or undefined. */
export function removeFromPool(runId: string): PooledSession | undefined {
  const entry = pool.get(runId);
  if (entry) pool.delete(runId);
  return entry;
}

/** Get all run IDs currently in the pool */
export function getPoolRunIds(): string[] {
  return Array.from(pool.keys());
}

/** Get current pool size */
export function getPoolSize(): number {
  return pool.size;
}

/** Kill all pooled sessions synchronously (for process exit) */
export function releaseAll(): void {
  for (const entry of pool.values()) {
    try {
      entry.session.killSync();
    } catch {
      // Best-effort during shutdown
    }
  }
  pool.clear();
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
}

// ---- Idle cleanup ----

/** Schedule a timer that kills sessions idle beyond IDLE_TIMEOUT_MS */
export function scheduleIdleCleanup(): void {
  if (idleTimer) clearTimeout(idleTimer);

  idleTimer = setTimeout(() => {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [runId, entry] of pool) {
      if (now - entry.lastActivityAt >= IDLE_TIMEOUT_MS) {
        toRemove.push(runId);
      }
    }

    for (const runId of toRemove) {
      const entry = pool.get(runId);
      if (entry) {
        try {
          entry.session.killSync();
        } catch {
          // Best-effort
        }
        pool.delete(runId);
      }
    }

    // Reschedule if pool is not empty
    if (pool.size > 0) {
      scheduleIdleCleanup();
    } else {
      idleTimer = undefined;
    }
  }, IDLE_TIMEOUT_MS);
}

// ---- Process exit handlers ----

/** Register process exit handlers to clean up pooled sessions */
export function registerExitHandlers(): void {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;
  process.on("exit", releaseAll);
}
