import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadProjectAgents, findAgent } from "./agents.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepagent-test-"));
}

function writeAgentFile(dir: string, filename: string, content: string): string {
  const agentsDir = path.join(dir, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const filePath = path.join(agentsDir, filename);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("loadProjectAgents", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when .pi/agents directory does not exist", () => {
    const agents = loadProjectAgents(tmpDir);
    expect(agents).toEqual([]);
  });

  it("returns empty array when .pi/agents is empty", () => {
    fs.mkdirSync(path.join(tmpDir, ".pi", "agents"), { recursive: true });
    const agents = loadProjectAgents(tmpDir);
    expect(agents).toEqual([]);
  });

  it("loads a valid agent .md file", () => {
    writeAgentFile(tmpDir, "worker.md", [
      "---",
      "name: worker",
      "description: A test worker agent",
      "---",
      "",
      "You are a worker.",
    ].join("\n"));

    const agents = loadProjectAgents(tmpDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("worker");
    expect(agents[0].description).toBe("A test worker agent");
    expect(agents[0].systemPrompt).toContain("You are a worker.");
    expect(agents[0].filePath).toMatch(/worker\.md$/);
  });

  it("skips files missing name in frontmatter", () => {
    writeAgentFile(tmpDir, "noname.md", [
      "---",
      "description: Missing name",
      "---",
      "",
      "Body",
    ].join("\n"));

    const agents = loadProjectAgents(tmpDir);
    expect(agents).toHaveLength(0);
  });

  it("skips files missing description in frontmatter", () => {
    writeAgentFile(tmpDir, "nodesc.md", [
      "---",
      "name: nodesc",
      "---",
      "",
      "Body",
    ].join("\n"));

    const agents = loadProjectAgents(tmpDir);
    expect(agents).toHaveLength(0);
  });

  it("parses tools into string array", () => {
    writeAgentFile(tmpDir, "worker.md", [
      "---",
      "name: worker",
      "description: Has tools",
      "tools: read, grep, find, ls, bash, edit, write",
      "---",
      "",
      "You have tools.",
    ].join("\n"));

    const agents = loadProjectAgents(tmpDir);
    expect(agents).toHaveLength(1);
    expect(agents[0].tools).toEqual([
      "read", "grep", "find", "ls", "bash", "edit", "write",
    ]);
  });

  it("sets tools to undefined when not specified", () => {
    writeAgentFile(tmpDir, "worker.md", [
      "---",
      "name: worker",
      "description: No tools",
      "---",
      "",
      "No tools here.",
    ].join("\n"));

    const agents = loadProjectAgents(tmpDir);
    expect(agents[0].tools).toBeUndefined();
  });

  it("skips files with invalid YAML frontmatter", () => {
    writeAgentFile(tmpDir, "worker.md", [
      "---",
      "name: worker",
      "description: Empty tools",
      "tools: , ,",
      "---",
      "",
      "Invalid YAML tools field.",
    ].join("\n"));

    const agents = loadProjectAgents(tmpDir);
    // Invalid YAML causes parseFrontmatter to throw → file is skipped
    expect(agents).toHaveLength(0);
  });

  it("parses model from frontmatter", () => {
    writeAgentFile(tmpDir, "worker.md", [
      "---",
      "name: worker",
      "description: Custom model",
      "model: claude-sonnet-4-20250514",
      "---",
      "",
      "Body",
    ].join("\n"));

    const agents = loadProjectAgents(tmpDir);
    expect(agents[0].model).toBe("claude-sonnet-4-20250514");
  });

  it("ignores non-markdown files", () => {
    const agentsDir = path.join(tmpDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "notes.txt"), "not an agent", "utf-8");

    const agents = loadProjectAgents(tmpDir);
    expect(agents).toEqual([]);
  });

  it("loads multiple agents", () => {
    writeAgentFile(tmpDir, "worker.md", [
      "---",
      "name: worker",
      "description: Worker agent",
      "---",
      "",
      "Worker body",
    ].join("\n"));

    writeAgentFile(tmpDir, "reviewer.md", [
      "---",
      "name: reviewer",
      "description: Reviewer agent",
      "---",
      "",
      "Reviewer body",
    ].join("\n"));

    const agents = loadProjectAgents(tmpDir);
    expect(agents).toHaveLength(2);
    const names = agents.map((a) => a.name).sort();
    expect(names).toEqual(["reviewer", "worker"]);
  });
});

describe("findAgent", () => {
  const agents = [
    {
      name: "worker",
      description: "Worker",
      systemPrompt: "Do work",
      filePath: "/fake/worker.md",
      tools: ["read", "bash"],
    },
    {
      name: "reviewer",
      description: "Reviewer",
      systemPrompt: "Review code",
      filePath: "/fake/reviewer.md",
    },
  ];

  it("finds an existing agent by name", () => {
    const found = findAgent(agents, "worker");
    expect(found).toBeDefined();
    expect(found!.name).toBe("worker");
  });

  it("returns undefined for unknown agent name", () => {
    const found = findAgent(agents, "nonexistent");
    expect(found).toBeUndefined();
  });

  it("returns undefined for empty agents array", () => {
    const found = findAgent([], "worker");
    expect(found).toBeUndefined();
  });
});
