import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  addToPool,
  getFromPool,
  removeFromPool,
  releaseAll,
  getPoolRunIds,
  getPoolSize,
  updatePoolActivity,
  totalChildCount,
  MAX_TOTAL_CHILDREN,
  type PooledSession,
} from "./session-pool.ts";
import type { UsageStats } from "./types.ts";

// Mock run-registry so we control getActiveRunCount
vi.mock("./run-registry.ts", () => ({
  getActiveRunCount: vi.fn(() => 0),
}));

import { getActiveRunCount } from "./run-registry.ts";

const mockedGetActiveRunCount = vi.mocked(getActiveRunCount);

// ---- Mock RpcSession factory ----

function makeMockSession(alive = true) {
  return {
    isAlive: vi.fn(() => alive),
    killSync: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as import("./rpc-session.ts").RpcSession;
}

const zeroUsage: UsageStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
};

beforeEach(() => {
  releaseAll();
  mockedGetActiveRunCount.mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("addToPool", () => {
  it("adds a session and returns a run_ prefixed ID", () => {
    const session = makeMockSession();
    const id = addToPool(session, "worker", "user", zeroUsage);
    expect(id).toMatch(/^run_[0-9a-f]{8}$/);
    expect(getPoolSize()).toBe(1);
  });

  it("throws when total child count is at max", () => {
    mockedGetActiveRunCount.mockReturnValue(MAX_TOTAL_CHILDREN);
    const session = makeMockSession();
    expect(() => addToPool(session, "worker", "user", zeroUsage)).toThrow(
      /max.*total.*children/i,
    );
  });

  it("throws when pool + active runs equals max", () => {
    // Fill pool to MAX - 1, then set active to 1
    for (let i = 0; i < MAX_TOTAL_CHILDREN - 1; i++) {
      addToPool(makeMockSession(), `agent-${i}`, "user", zeroUsage);
    }
    mockedGetActiveRunCount.mockReturnValue(1);
    expect(() => addToPool(makeMockSession(), "overflow", "user", zeroUsage)).toThrow(
      /max.*total.*children/i,
    );
  });
});

describe("getFromPool", () => {
  it("returns the pooled session for a valid run ID", () => {
    const session = makeMockSession();
    const id = addToPool(session, "worker", "user", zeroUsage);
    const entry = getFromPool(id);
    expect(entry).toBeDefined();
    expect(entry!.runId).toBe(id);
    expect(entry!.agent).toBe("worker");
    expect(entry!.agentSource).toBe("user");
  });

  it("returns undefined for unknown run ID", () => {
    expect(getFromPool("nonexistent")).toBeUndefined();
  });

  it("returns undefined and auto-removes dead sessions", () => {
    const session = makeMockSession(true);
    const id = addToPool(session, "worker", "user", zeroUsage);
    expect(getFromPool(id)).toBeDefined();

    // Kill the session (make isAlive return false)
    (session as any).isAlive = vi.fn(() => false);

    const result = getFromPool(id);
    expect(result).toBeUndefined();
    expect(getPoolSize()).toBe(0);
  });
});

describe("removeFromPool", () => {
  it("removes and returns a pooled session", () => {
    const session = makeMockSession();
    const id = addToPool(session, "worker", "user", zeroUsage);
    const removed = removeFromPool(id);
    expect(removed).toBeDefined();
    expect(removed!.runId).toBe(id);
    expect(getPoolSize()).toBe(0);
  });

  it("returns undefined for unknown run ID", () => {
    expect(removeFromPool("nonexistent")).toBeUndefined();
  });
});

describe("releaseAll", () => {
  it("kills all pooled sessions and clears the pool", () => {
    const s1 = makeMockSession();
    const s2 = makeMockSession();
    addToPool(s1, "a", "user", zeroUsage);
    addToPool(s2, "b", "project", zeroUsage);

    releaseAll();

    expect((s1 as any).killSync).toHaveBeenCalled();
    expect((s2 as any).killSync).toHaveBeenCalled();
    expect(getPoolSize()).toBe(0);
    expect(getPoolRunIds()).toEqual([]);
  });
});

describe("getPoolRunIds", () => {
  it("returns all run IDs in the pool", () => {
    const id1 = addToPool(makeMockSession(), "a", "user", zeroUsage);
    const id2 = addToPool(makeMockSession(), "b", "project", zeroUsage);
    const ids = getPoolRunIds();
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids).toHaveLength(2);
  });

  it("returns empty array when pool is empty", () => {
    expect(getPoolRunIds()).toEqual([]);
  });
});

describe("updatePoolActivity", () => {
  it("updates timestamp and usage for a pooled session", () => {
    const session = makeMockSession();
    const id = addToPool(session, "worker", "user", zeroUsage);
    const before = getFromPool(id)!.lastActivityAt;

    // Wait a tiny bit to ensure timestamp changes
    const updatedUsage: UsageStats = { ...zeroUsage, turns: 5, cost: 0.42 };
    const result = updatePoolActivity(id, updatedUsage);

    expect(result).toBe(true);
    const entry = getFromPool(id)!;
    expect(entry.lastActivityAt).toBeGreaterThanOrEqual(before);
    expect(entry.usage.turns).toBe(5);
    expect(entry.usage.cost).toBeCloseTo(0.42);
  });

  it("returns false for unknown run ID", () => {
    expect(updatePoolActivity("nonexistent", zeroUsage)).toBe(false);
  });
});

describe("totalChildCount", () => {
  it("returns pool size when no active runs", () => {
    addToPool(makeMockSession(), "a", "user", zeroUsage);
    addToPool(makeMockSession(), "b", "user", zeroUsage);
    expect(totalChildCount()).toBe(2);
  });

  it("sums pool size + active run count", () => {
    addToPool(makeMockSession(), "a", "user", zeroUsage);
    mockedGetActiveRunCount.mockReturnValue(3);
    expect(totalChildCount()).toBe(4);
  });
});
