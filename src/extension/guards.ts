/** Paths that must never be read or modified by child agents */
const BLOCKED_PATHS: string[] = [
  "auth.json", // matches any auth.json anywhere
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.staging",
];

/** Command substrings that indicate destructive operations */
const BLOCKED_COMMANDS: string[] = [
  "git reset --hard",
  "git checkout --",
  "git clean",
  "Remove-Item -Recurse -Force",
  "rm -rf",
  "rd /s /q",
];

/**
 * Check if a file path is blocked from access.
 * Returns true if the path should be blocked.
 */
export function isBlockedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();

  // Block auth.json anywhere (especially ~/.pi/agent/auth.json)
  if (normalized.endsWith("auth.json")) return true;

  // Block .env and .env.* files
  const basename = normalized.split("/").pop() || "";
  if (BLOCKED_PATHS.includes(basename)) return true;
  if (basename.startsWith(".env.")) return true;

  return false;
}

/**
 * Check if a command contains destructive substrings.
 * Returns true if the command should be blocked.
 */
export function isBlockedCommand(command: string): boolean {
  const lower = command.toLowerCase();
  for (const blocked of BLOCKED_COMMANDS) {
    if (lower.includes(blocked.toLowerCase())) return true;
  }
  return false;
}

/**
 * Check if subagent is allowed to run in the current context.
 * Returns { allowed: false, reason: string } if blocked.
 */
export function checkSubagentAllowed(): {
  allowed: boolean;
  reason?: string;
} {
  if (process.env.SUBAGENT_CHILD === "1") {
    return {
      allowed: false,
      reason: "Nested subagent delegation is not supported in V1.",
    };
  }
  const depth = parseInt(process.env.SUBAGENT_DEPTH || "0", 10);
  if (depth >= 1) {
    return { allowed: false, reason: "Subagent depth limit reached in V1." };
  }
  return { allowed: true };
}
