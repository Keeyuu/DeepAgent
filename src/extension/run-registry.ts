/**
 * Run Registry — tracks active async subagent runs.
 */

import type { AsyncRunInfo } from "./types.ts";

/** Maximum concurrent async runs */
export const MAX_ACTIVE_RUNS = 8;

const activeRuns = new Map<string, AsyncRunInfo>();

/** Register a new async run. Returns the run ID. Throws if max reached. */
export function registerRun(info: AsyncRunInfo): string {
  if (activeRuns.size >= MAX_ACTIVE_RUNS) {
    throw new Error(
      `Max concurrent async runs reached (${MAX_ACTIVE_RUNS}). Abort an existing run first.`,
    );
  }
  activeRuns.set(info.id, info);
  return info.id;
}

/** Get a run by ID. Returns undefined if not found. */
export function getRun(id: string): AsyncRunInfo | undefined {
  return activeRuns.get(id);
}

/** Remove a run by ID. Returns the removed info or undefined. */
export function removeRun(id: string): AsyncRunInfo | undefined {
  const info = activeRuns.get(id);
  if (info) activeRuns.delete(id);
  return info;
}

/** Get count of active runs */
export function getActiveRunCount(): number {
  return activeRuns.size;
}

/** Get all active runs as array */
export function getAllRuns(): AsyncRunInfo[] {
  return Array.from(activeRuns.values());
}

/** Remove all runs (for testing/cleanup) */
export function clearAllRuns(): void {
  activeRuns.clear();
}
