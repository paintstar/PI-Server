# Pi Subagents（Pi 调度台）

## 这个项目是什么
面向 Google Antigravity、Claude Code、OpenAI Codex 和 OpenCode 的多模型子代理调度平台，包含标准 stdio MCP 服务与实时本机控制台“Pi 调度台”。每个子代理会话由独立进程持久化托管，支持工作树隔离、双向消息、阻塞提问、断线恢复、临时模型切换、四端回调唤醒、模型能力画像配置与只读改动审查。

## 怎么运行
- 环境要求：macOS（沙箱依赖 `/usr/bin/sandbox-exec`）或 Linux / Windows WSL2（沙箱依赖 `bubblewrap` / `bwrap`）、Node.js 22.19+、本机 Pi CLI 1.0.2+ 及有效模型凭据。
- `npm ci --ignore-scripts` 安装固定依赖；`npm start` 启动 stdio MCP 服务。
- `npm run check` 检查全部 JS / TS 语法；`npm test` 运行全量隔离测试（不调用真实付费模型）。
- `npm run install:all` 一键接入本机 Antigravity、Claude Code、Codex 和 OpenCode（也可单独执行 `install:antigravity`、`install:claude`、`install:codex`、`install:opencode`）；只更新客户端配置，不中断正在运行的子代理。
- `npm run wait-events -- --agent <id>` 或 `--session <id>` 后台等待子代理事件并唤醒 Claude Code、Antigravity 或 OpenCode，配合 `watchers/*.json` 记录活跃监听器心跳。
- `npm run dashboard` 启动或复用本机“Pi 调度台”（默认 `http://127.0.0.1:3141/`，MCP 启动时默认自动拉起）。
- `npm run verify:communication` 真机验证断线恢复与请求限制；`npm run verify:live` 真机多模型验证；`node scripts/verify-codex.js` / `node scripts/verify-opencode.js` 分别真机验证 Codex / OpenCode CLI 接入。

## 目录地图
- `src/server.js`：MCP 服务入口与 24 个主会话工具定义（含模型画像 `get_model_profiles`、会话绑定 `bind_session`、健康检查 `get_subagent_health` 与会话整理 `organize_agents`）。
- `src/model-profiles.js`、`src/provider-auth.js`、`src/model-settings.js`：内置模型能力画像、6 个 Pi 工具清单、凭据脱敏与本机 Codex 登录同步（`sync_codex`）、`model-settings.json` / `models-catalog.json` 严格读写与基线保留、`auth.json` / `models.json` `0600` 权限备份与原子同步（含 `models[]` 与 `modelOverrides`）及 `pi auth check` 封装。
- `src/quota*.js`：只读读取 Pi 凭据查询 Codex、智谱 GLM / Z.ai、MiniMax、DeepSeek 和 OpenCode Go 额度或余额；固定接口域名，剥离账号隐私字段。
- `src/controller*.js`：独立后台管理进程、私密 Unix Socket（持久连接、断连取消与新建代理即时唤醒长轮询）、宿主父会话身份识别与断线重连。
- `src/manager.js`、`src/rpc-client.js`、`src/live-stream.js`：Pi RPC JSONL 子进程管理、会话生命周期、模型切换与实时流式输出镜像（`live.json`）。
- `src/agent-policy.js`、`src/tool-sandbox.js`、`src/linux-sandbox.js`、`src/benchmark-profile.js`：模型白名单与用量限制、macOS Seatbelt / Linux & WSL2 `bubblewrap` 三档沙箱隔离、可选 `BENCHMARK_PROMPT_PROFILE=clean` 洁净评测上下文清理。
- `src/message-store.js`、`src/messages.js`、`src/wait-reminder.js`：幂等持久消息回执、子代理本地 HTTP 提问/汇报通道、`mustWait` 防遗忘提醒。
- `src/callbacks.js`、`src/opencode-config.js`、`src/agent-changes.js`、`src/workspace.js`：四端回调唤醒（Antigravity / OpenCode 统一单调游标、Claude channel、`codex queue`、可选 CLI 唤醒）、OpenCode JSONC 注释保留读写、只读 Git 工作树差异审查、独立 worktree 与共享 `ownedPaths` 校验。
- `src/task-store.js`、`src/mcp-*.js`：MCP 2025-11-25 标准 Tasks、资源订阅、日志与进度通知。
- `src/dashboard*.js`、`dashboard/`：“Pi 调度台”后端（SSE `/api/events`、`/api/agents/:id/live`、`/api/system`、60 秒缓存 `/api/quota`、`/api/settings*`、`dashboard.lock` 并发锁）与无外部前端框架依赖的 ES 模块化界面。
- `extensions/`：注入新 Pi 子进程的权限沙箱扩展（`policy.ts`）与双向通信扩展（`communication.ts`）。
- `scripts/`：语法检查、四端安装打包（含 Antigravity 插件校验与 `opencode-install.js`）、`antigravity-hook.js`、`wait-events.js` 及真机验收脚本（含 `verify-opencode.js`）。
- `tests/`：100 项隔离行为测试与单文件行数/注释卫生检查；`tests/helpers/` 为隔离 Pi 模拟进程。
- `docs/`：协议与沙箱说明（`communication.md`）、验证矩阵（`verification.md`）与开源界面预览图（`assets/`）。
- `.agents/`：本机运行状态、工作树与私密验证记录，由 `.gitignore` 排除。

## 标准写法与长期约定
- **代码体积与风格**：`src/*.js` 与 `scripts/*.js` 单文件小于 500 行，`dashboard/*.js` 单文件小于 450 行；`dashboard/*.js`、`src/dashboard.js`、`src/dashboard-launcher.js` 等新模块禁止行内注释（由测试自动守护）。
- **状态与凭据写入**：所有 JSON 状态与配置统一调用 `src/storage.js` 的 `atomicWriteJson` 原子写入；改写 `~/.pi/agent/auth.json` 与 `models.json` 前必须以 `0600` 权限备份，任何接口或工具结果严禁暴露明文 API Key、OAuth Token 或个人身份信息。
- **状态严格区分**：指令传输接受（`accepted`）、进入上下文（`consumed`）、主会话确认已读（`acknowledgedAt`）、Pi 回合结束（`completed`）与业务验收通过分别处理；`agent_end` 后仍可能重试，终态以 `agent_settled` 为准。
- **用量与默认策略**：`list_models` 与 `get_model_profiles` 默认隐藏已禁用模型；`spawn_agent` 拒绝禁用项并将默认 `thinking`、`allowNetwork`、`sandboxMode`、`loadSkills`、`loadContextFiles` 固化进会话记录；`policy.maxTotalTokens` 仅统计非缓存读取用量（`input + output + cacheWrite`），未获用户明确要求时主会话不应擅自收紧请求数、Token 或时长上限。
- **并行与面板边界**：Git 仓库并行开发默认创建独立 worktree，共享目录必须声明不重叠的 `ownedPaths`；面板绝不直接停止或接手子代理进程，仅与 `organize_agents` 共写 `dashboard-marks.json`（运行中或等待答复的会话不可归档或手动标状态，产生新活动自动解除归档），并通过 `/api/settings*` 同源接口维护模型与脱敏凭据设置。
- **Antigravity 唤醒去重**：通过 `spawn_agent.antigravitySessionId` 或 `bind_session` 绑定会话后，插件钩子（`PreInvocation`、`Stop`）、`wait-events --session`、`read_agent` 与 `wait_agent` 共用 `antigravityDeliveredSeq` 单调游标去重，按事件子集监听时不会跳过未投递的默认回调事件。

## 不要做的事与已知的坑
- 不向 `stdout` 打印普通日志（`stdout` 专供 MCP 协议帧）；Pi 子进程输出只按 `\n` 切分 JSONL。
- 不自动合并分支、删除工作目录或执行部署；不把模型目录价格上报值（`reportedCost`）当成真实账单扣费。
- `strict` 外置工作区依赖允许祖先目录元数据供 Python 与 SQLite 解析真实路径，状态目录内部仍严格隔离；`ask_parent` 阻塞期间必须用 `reply_question` 答复，普通 `send_message` 只进指令队列。
- 管理进程沿用首次启动的容量与默认策略，修改全局默认限制后需重启空闲管理进程方对新建代理生效；新桥接检测到空闲旧管理进程脚本路径已变化时会自动平滑替换。
