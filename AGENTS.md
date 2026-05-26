# DeepAgent Project Instructions

- 默认中文沟通，简洁、直接、证据优先。
- 基于 `earendil-works/pi` 官方 extension API 构建 subagent 系统。
- 官方参考：
  - https://pi.dev/docs/latest (+ /extensions, /settings, /prompt-templates, /skills, /rpc, /json)
  - https://github.com/earendil-works/pi
  - 本地 clone: `C:\Code\pi-learn\pi`
  - 官方 subagent example: `packages/coding-agent/examples/extensions/subagent`
- 非官方仓库（`pi-subagents`, `oh-my-pi`, `oh-my-opencode-slim`, `opencode-dynamic-context-pruning`）只允许借鉴，不作为 runtime 依赖。
- 传输层使用官方 `--mode rpc` / `RpcClient` / RPC extension UI protocol。
- 项目装配使用 `.pi/settings.json`、`.pi/prompts/`、`.pi/skills/`、`.pi/extensions/`。
- 命名规范：工具、命令、目录、prompt、skill、env var 使用语义名，不加 `deepagent` / `DeepAgent` 前缀。示例：tool `subagent`，extension `subagent`，skill `subagent`，diagnostic command `/doctor`，env `SUBAGENT_CHILD`。
- 子 agent 可用 `contact_supervisor` 汇报进度/请求决策；parent 可通过 steer/follow-up 控制运行中的 child。
- 不读取、打印或修改 `C:\Users\Goni\.pi\agent\auth.json`。
- 修改保持小范围；不做无关重构。
- 文档入口：`docs/index.md`，专题分目录（`docs/architecture/`、`docs/plans/` 等）。
