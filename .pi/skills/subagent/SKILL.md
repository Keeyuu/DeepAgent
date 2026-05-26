---
name: subagent
description: Official-Pi-only child delegation workflow.
---

# Subagent Workflow

Use this workflow when a task should be delegated to an isolated child Pi process.

1. Keep the parent session responsible for user communication, decisions, and final verification.
2. Delegate only bounded tasks to `subagent`.
3. Use only `agent: "worker"` in V1.
4. Do not ask the child to start more subagents.
5. Treat `status: need_decision` as a stop condition.
6. Before completion, verify the child result fromC:\Users\Goni\.pi\agent\models.json the parent session.
