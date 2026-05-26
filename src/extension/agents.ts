/**
 * Agent discovery and configuration for DeepAgent V1.
 * Only loads project-local agents from `.pi/agents/*.md`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./types.ts";

/**
 * Load all agent configs from the project's `.pi/agents/` directory.
 * Returns an empty array if the directory doesn't exist.
 */
export function loadProjectAgents(projectRoot: string): AgentConfig[] {
  const agents: AgentConfig[] = [];
  const agentsDir = path.join(projectRoot, ".pi", "agents");

  if (!fs.existsSync(agentsDir)) {
    return agents;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(agentsDir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    let frontmatter: Record<string, string>;
    let body: string;
    try {
      const parsed = parseFrontmatter<Record<string, string>>(content);
      frontmatter = parsed.frontmatter;
      body = parsed.body;
    } catch {
      continue;
    }

    if (!frontmatter.name || !frontmatter.description) {
      continue;
    }

    const tools = frontmatter.tools
      ?.split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body,
      filePath,
    });
  }

  return agents;
}

/**
 * Find an agent by name from a loaded list.
 */
export function findAgent(agents: AgentConfig[], name: string): AgentConfig | undefined {
  return agents.find((a) => a.name === name);
}
