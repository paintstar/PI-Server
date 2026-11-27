# 可靠通信、权限沙箱与协议规范

本文档面向希望深入了解 Pi Server v2.0 内部状态流转、多模型协作边界、双平台内核沙箱与 MCP 协议映射的开发者。当前 **2.0.0** 版本基于 `@modelcontextprotocol/sdk` 1.26.0 构建，提供 **27 个主会话工具**（24 个调度原语 + `consult` / `council` / `cross_review` 3 个高层协作原语），并完整支持 MCP 2025-11-25 的资源订阅、结构化日志、进度通知与标准 Tasks。

## 消息投递、五级状态与断线恢复

- **幂等请求身份**：创建子代理可传入稳定 UUID `requestId`，发送任务指令可传入稳定 UUID `messageId`。相同身份且内容一致的重试直接返回原回执；相同身份但内容不同立即报错。
- **五级状态严格区分**：
  1. `accepted`：指令已落盘并送入 Pi 传输队列；
  2. `consumed`：Pi `context` 钩子确认指令已进入本轮上下文；
  3. `acknowledgedAt`：父会话已调用 `ack_messages` 确认读取；
  4. `completed`：未配置 `acceptanceChecks` 时，Pi 收到 `agent_settled` 回合结束（`verification.status = 'none'`）；
  5. `completed-verified` / `completed-unverified`：配置了 `acceptanceChecks` 时，控制器在原工作树与 OS 沙箱内顺序跑完验收命令后的机械结论（`verification.status = 'verified' | 'failed'`，验收中为 `'running'`，中断/错误为 `'skipped'`）。机械验收通过仍不等同最终人工合并决策。
- **无死锁验收中断与修完重验**：验收执行期间代理保持 `finishing` 态；若父会话调用 `interrupt_agent` 或 `close_agent`，控制器在进入 `serial()` 队列前同步置位 `interruptedRun = true` 并触发 `acceptanceAbort.abort()` 立即 `SIGKILL` 清理整棵进程树。若验收失败落为 `completed-unverified`，父会话可直接 `send_message` 下发修复指令，新一轮 `agent_settled` 后自动重验并在全通时转正为 `completed-verified`。
- **单写入者落盘约束**：`agent.json` 仅由控制器单一原子写入（静态指针 `orchestration: { kind, runId, role?, sourceAgentId? }` 经 `spawn` 写入）；高层协作动态终态（`verdict`、`synthesis`、`members`、`totalUsage`）独占落盘 `<stateRoot>/runs/<runId>.json`（`0600`），避免多写竞态。
- **独立控制进程与安全热替换**：MCP stdio 断开不终止后台子代理与阻塞中的 `ask_parent`。`ControllerClient` 重连时自动透传已绑定的 `parentInfo`；仅当旧控制器满足 `liveProcesses === 0 && activeParents === 0 && inflightOps === 0` 时自动平滑热替换。
- **UTF-8 分片安全与内存尾窗**：控制器（上限 `512KB`）与面板均采用 `Buffer.concat` 拼接 HTTP 请求体消除多字节中文跨分片乱码；`manager.read()` 优先命中 500 条内存事件滑动尾窗，越窗回退磁盘 `events.jsonl`。

## 执行策略、只读协作与双平台沙箱

| 参数 | 默认值 | 行为说明 |
| --- | --- | --- |
| `allowedModels` | 创建时指定的 `provider/model` | 限制该会话可切换的模型白名单 |
| `maxModelRequests` / `maxTotalTokens` / `maxRuntimeMs` | `100,000` / `1e12` 非缓存 Token / `7` 天 | 仅统计 `input + output + cacheWrite`；未获用户明确要求时不擅自收紧 |
| `sandboxMode` | `strict`（或设置中心默认值） | 可选 `strict`、`dev`、`bypass`；单代理优先级高于 `.agents/sandbox.json` |
| `allowNetwork` | `true`（`consult`/`council`/`cross_review` 强制 `false`） | `false` 时在 macOS Seatbelt / Linux `bwrap --unshare-net` 断网拦截 |
| `readOnly` / `nonInteractive` / `allowWorkspaceRead` | `false` / `false` / `true` | `readOnly: true` 允许 `ownedPaths: []` 并跳过 `pathsOverlap`（支持脏工作区多模型并发），内核层仅允许写 `tempDir`/`/dev/null`，`extensions/policy.ts` 动态禁用写/执行工具；`nonInteractive: true` 禁用 `ask_parent` 并切换精简只读系统提示词 |

### macOS Seatbelt / Linux & WSL2 Bubblewrap 三档路径边界

1. **`strict`（默认严格隔离）**：只读工作目录与运行必需系统目录，仅可写声明的 `ownedPaths` 与私有临时目录（`readOnly: true` 时连 `ownedPaths` 也不可写）；禁止读写 `~/.pi`、`~/.codex`、`~/.claude`、`~/.claude.json`、`~/.gemini`、`~/.config/opencode`、`~/.local/share/opencode`、`~/.ssh`、`~/.aws`、`~/.kube`、`~/.gnupg` 与管理进程状态目录。在 Linux `bwrap` 下，普通凭据文件（如 `~/.claude.json`）采用 `--ro-bind /dev/null <file>` 掩蔽防止 `ENOTDIR`，目录采用 `--perms 0000 --tmpfs <dir>`。
2. **`dev`（开发模式）**：允许工作树全写及本地构建缓存（`~/.cache`、`~/.local/share/uv`、`~/.npm`、`~/Library/Caches`）以运行测试和本地提交，同时继续在内核层屏蔽上述全部敏感凭据与控制状态目录。
3. **`bypass`（完全放开路径）**：放开工作区外及凭据目录权限，仅保护控制进程状态目录，仅适用于完全信任的本机运维任务。

## 高层多模型协作原语与 Fail-Closed 语义

- **`consult` / `council`**：Server 侧无状态编排器经 Socket 分段调用 `spawn → wait (≤20s) → read → closeAgent → archive`（规避控制器单次 55s RPC 超时）。`preflightBudget` 在 spawn 前校验模型可用性、控制器并发容量与单次 `budgetCapUsd`，显式返回 `unknownPricingModels[]` 与 `pricingComplete`，`dryRun: true` 保证零 spawn、零写盘。`council` 支持 `cleanProfile: true`（洁净评测模式）与 `minQuorum` 降级（`completed` / `partial` / `failed`）。
- **`cross_review`**：校验源代理所有权与非活跃态，默认拒绝同模型自审（`allowSameModel: true` 可覆盖）；调用增强版 `agentChanges({ includeDiff: true, includeUntracked: true })` 将未跟踪新建文件纳入统一 Diff；空 diff 时零成本短路返回 `concerns`；裁决归一化严格 **Fail-Closed**：无法解析合法 JSON 或非法 `verdict` 时绝不返回 `approve`（强制降级为 `concerns` + `parseWarning`），存在任意 `severity === 'blocker'` 时强制提升为 `blockers`。

## 标准 MCP 协议与四大宿主回调唤醒

- **资源、进度与标准 Tasks**：暴露 `pi-agent://<agentId>/events` 可订阅资源与 `notifications/progress`；标准 Tasks（`run_agent_task` / `resume_task`）对 `completed` 与 `completed-verified` 映射 `'completed'`，对 `completed-unverified` 映射 `'failed'` 且 `resultOf` 返回 `isError: true`。
- **四大宿主唤醒**：Antigravity（插件 `PreInvocation`/`Stop` 钩子 + `wait-events --session`）、Claude Code（`claude/channel` 或 `wait-events --agent`）、Codex（`codex queue --thread`）与 OpenCode（`SKILL.md` + `wait-events --session` + 可选 `opencodeCliWake`），全通道共用 `callbacks/<agentId>.json` 单调游标防重放。
