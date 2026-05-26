import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerRun,
  getRun,
  removeRun,
  getActiveRunCount,
  getAllRuns,
  clearAllRuns,
  MAX_ACTIVE_RUNS,
} from "./run-registry.ts";
import type { AsyncRunInfo } from "./types.ts";
import { randomUUID } from "node:crypto";

function makeRunInfo(overrides?: Partial<AsyncRunInfo>): AsyncRunInfo {
  return {
    id: randomUUID(),
    agent: "worker",
    task: "test task",
    status: "running",
    session: { abort: vi.fn(), steer: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) },
    events: [],
    accumulated: {
      messages: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      stderr: "",
    },
    startedAt: Date.now(),
    agentSource: "user",
    ...overrides,
  };
}

beforeEach(() => {
  clearAllRuns();
});

describe("registerRun", () => {
  it("registers a run and returns the run ID", () => {
    const info = makeRunInfo({ id: "test-run-id" });
    const id = registerRun(info);
    expect(id).toBe("test-run-id");
    expect(getRun(id)).toBe(info);
  });

  it("rejects when max concurrent runs reached", () => {
    for (let i = 0; i < MAX_ACTIVE_RUNS; i++) {
      registerRun(makeRunInfo({ id: `run-${i}` }));
    }
    expect(() => registerRun(makeRunInfo({ id: "overflow" }))).toThrow(/max.*concurrent/i);
  });
});

describe("getRun", () => {
  it("returns undefined for unknown run ID", () => {
    expect(getRun("nonexistent")).toBeUndefined();
  });

  it("returns the run info for a registered run", () => {
    const info = makeRunInfo({ id: "known" });
    registerRun(info);
    expect(getRun("known")).toBe(info);
  });
});

describe("removeRun", () => {
  it("removes a run and returns it", () => {
    const info = makeRunInfo({ id: "to-remove" });
    registerRun(info);
    const removed = removeRun("to-remove");
    expect(removed).toBe(info);
    expect(getRun("to-remove")).toBeUndefined();
  });

  it("returns undefined for unknown run ID", () => {
    expect(removeRun("nonexistent")).toBeUndefined();
  });
});

describe("getActiveRunCount", () => {
  it("returns 0 when no runs", () => {
    expect(getActiveRunCount()).toBe(0);
  });

  it("returns count of registered runs", () => {
    registerRun(makeRunInfo({ id: "a" }));
    registerRun(makeRunInfo({ id: "b" }));
    expect(getActiveRunCount()).toBe(2);
  });
});

describe("getAllRuns", () => {
  it("returns all runs as array", () => {
    const a = makeRunInfo({ id: "a" });
    const b = makeRunInfo({ id: "b" });
    registerRun(a);
    registerRun(b);
    const all = getAllRuns();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === "a")).toBe(a);
    expect(all.find((r) => r.id === "b")).toBe(b);
  });

  it("returns empty array when no runs", () => {
    expect(getAllRuns()).toEqual([]);
  });
});

describe("clearAllRuns", () => {
  it("removes all runs", () => {
    registerRun(makeRunInfo({ id: "a" }));
    registerRun(makeRunInfo({ id: "b" }));
    clearAllRuns();
    expect(getActiveRunCount()).toBe(0);
    expect(getAllRuns()).toEqual([]);
  });
});
