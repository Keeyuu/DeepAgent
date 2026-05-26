import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverAgents, findAgent, formatAgentList } from "./agents.ts";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "deepagent-test-"));
}

function writeAgentFile(baseDir: string, filename: string, content: string): string {
	const agentsDir = path.join(baseDir, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	const filePath = path.join(agentsDir, filename);
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

describe("discoverAgents", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty array when .pi/agents directory does not exist", () => {
		const result = discoverAgents(tmpDir, "project");
		expect(result.agents).toEqual([]);
		expect(result.projectAgentsDir).toBeNull();
	});

	it("returns empty array when .pi/agents is empty", () => {
		fs.mkdirSync(path.join(tmpDir, ".pi", "agents"), { recursive: true });
		const result = discoverAgents(tmpDir, "project");
		expect(result.agents).toEqual([]);
	});

	it("loads a valid agent .md file from project scope", () => {
		writeAgentFile(tmpDir, "worker.md", [
			"---",
			"name: worker",
			"description: A test worker agent",
			"---",
			"",
			"You are a worker.",
		].join("\n"));

		const result = discoverAgents(tmpDir, "project");
		expect(result.agents).toHaveLength(1);
		expect(result.agents[0].name).toBe("worker");
		expect(result.agents[0].description).toBe("A test worker agent");
		expect(result.agents[0].systemPrompt).toContain("You are a worker.");
		expect(result.agents[0].filePath).toMatch(/worker\.md$/);
		expect(result.agents[0].source).toBe("project");
		expect(result.projectAgentsDir).toBeTruthy();
	});

	it("skips files missing name in frontmatter", () => {
		writeAgentFile(tmpDir, "noname.md", [
			"---",
			"description: Missing name",
			"---",
			"",
			"Body",
		].join("\n"));

		const result = discoverAgents(tmpDir, "project");
		expect(result.agents).toHaveLength(0);
	});

	it("skips files missing description in frontmatter", () => {
		writeAgentFile(tmpDir, "nodesc.md", [
			"---",
			"name: nodesc",
			"---",
			"",
			"Body",
		].join("\n"));

		const result = discoverAgents(tmpDir, "project");
		expect(result.agents).toHaveLength(0);
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

		const result = discoverAgents(tmpDir, "project");
		expect(result.agents).toHaveLength(1);
		expect(result.agents[0].tools).toEqual([
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

		const result = discoverAgents(tmpDir, "project");
		expect(result.agents[0].tools).toBeUndefined();
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

		const result = discoverAgents(tmpDir, "project");
		expect(result.agents[0].model).toBe("claude-sonnet-4-20250514");
	});

	it("ignores non-markdown files", () => {
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "notes.txt"), "not an agent", "utf-8");

		const result = discoverAgents(tmpDir, "project");
		expect(result.agents).toEqual([]);
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

		const result = discoverAgents(tmpDir, "project");
		expect(result.agents).toHaveLength(2);
		const names = result.agents.map((a) => a.name).sort();
		expect(names).toEqual(["reviewer", "worker"]);
	});

	it("returns empty agents and null dir for user-only scope with no user agents dir", () => {
		// "user" scope loads from getAgentDir()/agents which may not exist in test
		// We just verify it doesn't throw
		const result = discoverAgents(tmpDir, "user");
		expect(result.agents).toBeDefined();
		expect(result.projectAgentsDir).toBeNull();
	});

	it("finds project agents dir by walking up", () => {
		const childDir = path.join(tmpDir, "sub", "project");
		fs.mkdirSync(childDir, { recursive: true });
		writeAgentFile(tmpDir, "worker.md", [
			"---",
			"name: worker",
			"description: Found by walking up",
			"---",
			"",
			"Body",
		].join("\n"));

		const result = discoverAgents(childDir, "project");
		expect(result.agents).toHaveLength(1);
		expect(result.agents[0].name).toBe("worker");
		expect(result.projectAgentsDir).toBeTruthy();
	});
});

describe("findAgent", () => {
	const agents = [
		{
			name: "worker",
			description: "Worker",
			systemPrompt: "Do work",
			filePath: "/fake/worker.md",
			source: "project" as const,
			tools: ["read", "bash"],
		},
		{
			name: "reviewer",
			description: "Reviewer",
			systemPrompt: "Review code",
			filePath: "/fake/reviewer.md",
			source: "user" as const,
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

describe("formatAgentList", () => {
	it("returns 'none' for empty array", () => {
		const result = formatAgentList([], 5);
		expect(result.text).toBe("none");
		expect(result.remaining).toBe(0);
	});

	it("formats agents with name and source", () => {
		const agents = [
			{ name: "worker", description: "Worker", systemPrompt: "", filePath: "/a.md", source: "project" as const },
		];
		const result = formatAgentList(agents, 5);
		expect(result.text).toContain("worker (project): Worker");
		expect(result.remaining).toBe(0);
	});

	it("tracks remaining count", () => {
		const agents = [
			{ name: "a", description: "A", systemPrompt: "", filePath: "/a.md", source: "user" as const },
			{ name: "b", description: "B", systemPrompt: "", filePath: "/b.md", source: "user" as const },
			{ name: "c", description: "C", systemPrompt: "", filePath: "/c.md", source: "user" as const },
		];
		const result = formatAgentList(agents, 2);
		expect(result.remaining).toBe(1);
	});
});
