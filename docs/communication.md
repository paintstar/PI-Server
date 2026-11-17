# 可靠通信、权限沙箱与协议规范

本文档面向希望深入了解 Pi Subagents 内部状态流转、沙箱隔离边界与 MCP 协议映射的开发者。当前 1.7.0 版本基于 `@modelcontextprotocol/sdk` 1.26.0 构建，提供 **24 个主会话工具**，同时支持 MCP 2025-11-25 的资源订阅、结构化日志、进度通知与实验性 Tasks。

## 消息投递与断线恢复

- **幂等请求身份**：创建子代理可传入稳定 UUID `requestId`，发送任务指令可传入稳定 UUID `messageId`。相同身份且内容一致的重试会直接返回原回执；相同身份但内容不同会立即报错，防止网络抖动下串改指令。
- **四级状态区分**：指令先落盘再发往 Pi。`accepted` 表示传输层已送入 Pi 队列；`consumed` 表示指令已进入模型本轮上下文；`acknowledgedAt` 表示主会话已调用 `ack_messages` 确认读取；`completed` 表示 Pi 当前回合停止运行。这四个状态与“业务代码验收通过”严格分开，主会话接收结果后仍须核查文件差异与测试输出。
- **不确定投递不盲目重放**：当通信中途中断导致投递状态变为 `uncertain` 时，系统不会自动重发，主会话应先调用 `read_agent`、`read_messages` 与 `get_agent_changes` 核实子代理是否已实际执行。
- **阻塞提问持久保留**：子代理调用 `ask_parent` 产生的提问拥有独立 `questionId`。即使本地连接短暂断开，问题仍保留在管理进程中，只有主会话显式调用 `reply_question` 才会放行等待中的工具；同一问题重复确认相同答案是幂等的，换成不同答案会被拒绝。
- **JSONL 全量落盘与尾部修复**：全部事件追加写入 `events.jsonl`，`read_agent` 按递增 `sequence` 分页读取，不受内存缓存最近 500 条的限制；恢复会话时会自动剥离异常断电留下的半行残缺记录。
- **独立控制进程隔离**：MCP stdio 桥接关闭时只断开当前主会话，后台 Unix Socket 管理进程继续托管运行中的 Pi 子进程。新会话可通过 `list_agents(includeSaved=true)` 与 `resume_agent` 接手空闲或失联代理，但不能抢占另一个在线主会话正持有的子代理。

## 执行策略与三档沙箱

`spawn_agent` 创建子代理时的默认 `policy` 如下表所示。未收到用户明确硬性限制要求时，主会话应直接使用内置宽松默认值，不必自行收紧请求数、Token 或时长上限：

| 参数 | 默认值 | 行为说明 |
| --- | --- | --- |
| `allowedModels` | 创建时指定的 `provider/model` | 限制该会话可切换的模型白名单 |
| `maxModelRequests` | `100,000` 次 | 每次向模型服务发起请求前在管理进程预扣计数，超限立即拦截 |
| `maxTotalTokens` | `1e12`（非缓存读取 Token） | 仅累计 `input + output + cacheWrite`，不重复计入多轮工具重读的 `cacheRead`；达到上限 80% 时自动注入提醒让子代理先汇报进展 |
| `maxRuntimeMs` | `7` 天（`604,800,000` ms） | 单次运行最长挂钟时间（最大支持 `2,147,483,647` ms，约 24.8 天）；进程退出时立即清理定时器 |
| `maxOutputTokens` | `128,000` | 按目标协议自动注入单次输出上限 |
| `sandboxMode` | `strict`（或设置中心默认值） | 可选 `strict`、`dev`、`bypass`；单代理 `policy.sandboxMode` 优先于 `.agents/sandbox.json` |
| `allowNetwork` | `true`（或设置中心默认值） | 控制子代理 shell 工具是否允许访问外网；设为 `false` 时在 Seatbelt 层拦截外部网络连接 |

### macOS Seatbelt 三档路径边界

所有新启动的 Pi 会话只加载内置通信扩展（`extensions/communication.ts`）与权限扩展（`extensions/policy.ts`），权限扩展未完成握手确认前不会下发任何任务：

1. **`strict`（默认严格隔离）**：子代理只能读取工作目录与运行必需的系统目录（允许解析外部真实路径的祖先目录元数据以兼容 Python 和 SQLite），只能写入声明的 `ownedPaths` 与私有临时目录；禁止读写 `~/.pi`、`~/.codex`、`~/.ssh` 及管理进程状态目录。
2. **`dev`（开发模式）**：允许子代理运行 `uv`、本地虚拟环境、构建缓存（`~/.cache`、`~/Library/Caches`）并在独立 Git 工作树内执行完整测试与本地提交，同时继续在内核层屏蔽 `~/.pi`、`~/.codex`、`~/.ssh` 与管理进程状态目录。
3. **`bypass`（完全放开路径）**：放开工作区外及凭据目录读写权限并继承常用 `PATH`，仅继续保护管理进程状态目录（防止伪造其他代理令牌），只适用于用户明确信任的本机运维任务。

修改已有空闲代理的策略需调用 `update_agent_policy` 并附上用户指令说明 `authorizationReference`；设置 `PI_SUBAGENTS_CONFIRM_POLICY=1` 时，支持 MCP Elicitation 的客户端还会弹出交互确认表单。

## 标准 MCP 协议与跨宿主唤醒

- **资源与通知**：暴露 `pi-agent://<agentId>/events` 可订阅资源，发生状态变化时推送 `notifications/resources/updated`、`notifications/message` 与绑定对应 `progressToken` 的 `notifications/progress`。
- **标准异步 Tasks**：对声明支持 MCP 2025-11-25 Tasks 的客户端提供 `run_agent_task` 与 `resume_task`，完整覆盖 `working`、`input_required`、`completed`、`failed`、`cancelled` 状态流转与 TTL 过期清理（默认 24 小时，最高 7 天）。
- **三大宿主回调唤醒**：由于标准 MCP 通知无法通用唤醒已结束本轮回复的宿主模型，系统在桥接层实现了三套宿主专用唤醒通道：
  - **Google Antigravity**：通过 `antigravitySessionId` 或 `bind_session` 关联会话，由插件注册的 `PreInvocation` / `Stop` 钩子与后台 `scripts/wait-events.js --session <id>` 协同唤醒，依托 `callbacks/<agentId>.json` 中的 `antigravityDeliveredSeq` 单调游标与 `watchers/<pid>.json` 活跃心跳避免重复投递或漏等。
  - **Claude Code**：支持 `notifications/claude/channel` 原生开发通道唤醒，或通用运行后台命令 `npm run wait-events -- --agent <id>` 在事件到达时唤醒主会话。
  - **OpenAI Codex**：传入 `callback.codexThreadId` 后，桥接进程在子代理结束、提问或异常时调用 `codex queue --thread <id>` 将事件排入对应会话队列。
