import { describe, it, expect, vi, afterEach } from "vitest";
import { isBlockedPath, isBlockedCommand, checkSubagentAllowed } from "./guards.js";

describe("isBlockedPath", () => {
  it("blocks exact auth.json path with backslashes", () => {
    expect(isBlockedPath("C:\\Users\\Goni\\.pi\\agent\\auth.json")).toBe(true);
  });

  it("blocks auth.json with forward slashes", () => {
    expect(isBlockedPath("/home/user/.pi/agent/auth.json")).toBe(true);
  });

  it("blocks .env", () => {
    expect(isBlockedPath(".env")).toBe(true);
  });

  it("blocks .env.local", () => {
    expect(isBlockedPath(".env.local")).toBe(true);
  });

  it("blocks .env.production", () => {
    expect(isBlockedPath(".env.production")).toBe(true);
  });

  it("blocks .env.anything", () => {
    expect(isBlockedPath(".env.anything")).toBe(true);
  });

  it("allows src/main.ts", () => {
    expect(isBlockedPath("src/main.ts")).toBe(false);
  });

  it("allows package.json", () => {
    expect(isBlockedPath("package.json")).toBe(false);
  });
});

describe("isBlockedCommand", () => {
  it("blocks git reset --hard HEAD", () => {
    expect(isBlockedCommand("git reset --hard HEAD")).toBe(true);
  });

  it("blocks git clean -fdx", () => {
    expect(isBlockedCommand("git clean -fdx")).toBe(true);
  });

  it("blocks rm -rf /", () => {
    expect(isBlockedCommand("rm -rf /")).toBe(true);
  });

  it("blocks Remove-Item -Recurse -Force something", () => {
    expect(isBlockedCommand("Remove-Item -Recurse -Force something")).toBe(true);
  });

  it("allows git status --short", () => {
    expect(isBlockedCommand("git status --short")).toBe(false);
  });

  it("allows npm install", () => {
    expect(isBlockedCommand("npm install")).toBe(false);
  });

  it("allows npm run test", () => {
    expect(isBlockedCommand("npm run test")).toBe(false);
  });
});

describe("checkSubagentAllowed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns allowed when SUBAGENT_CHILD is not set", () => {
    const result = checkSubagentAllowed();
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns not allowed when SUBAGENT_CHILD=1", () => {
    vi.stubEnv("SUBAGENT_CHILD", "1");
    const result = checkSubagentAllowed();
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(
      "Nested subagent delegation is not supported in V1."
    );
  });

  it("returns not allowed when SUBAGENT_DEPTH >= 1", () => {
    vi.stubEnv("SUBAGENT_DEPTH", "1");
    const result = checkSubagentAllowed();
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("Subagent depth limit reached in V1.");
  });

  it("returns not allowed when SUBAGENT_DEPTH > 1", () => {
    vi.stubEnv("SUBAGENT_DEPTH", "2");
    const result = checkSubagentAllowed();
    expect(result.allowed).toBe(false);
  });
});
