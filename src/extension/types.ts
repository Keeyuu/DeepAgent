export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  filePath: string;
}

export interface SubagentInput {
  agent: "worker";
  task: string;
}

export interface ChildRunResult {
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  stderr: string;
}

export interface ParseResult {
  finalText: string;
  assistantMessages: number;
  parseErrors: number;
}
