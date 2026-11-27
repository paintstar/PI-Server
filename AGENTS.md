# Pi Server（Pi 调度台）

## 这个项目是什么
面向 Google Antigravity、Claude Code、OpenAI Codex 和 OpenCode 的多模型子代理调度平台（v2.0.0），包含标准 stdio MCP 服务（27 个工具）、统一命令行工具 `pi-server` 与零外部前端框架依赖的本机实时控制台“Pi Server · 调度台”。每个子代理会话由独立进程持久化托管，支持工作树隔离、高层多模型协作（`consult` / `council` / `cross_review`）、沙箱内机械化验收（`acceptanceChecks`）、双向消息、阻塞提问、断线恢复、四端回调唤醒、模型能力画像与只读改动审查。

## 怎么运行
- 环境要求：macOS（沙箱依赖 `/usr/bin/sandbox-exec`）或 Linux / Windows WSL2（沙箱依赖 `bubblewrap` / `bwrap`）、Node.js 22.19+、本机 Pi CLI 1.0.2+ 及有效模型凭据。
- `npm ci --ignore-scripts` 安装固定依赖；`npm start` 或 `pi-server serve` 启动 stdio MCP 服务。
- `npm run check` 检查 `bin/`、`src/`、`scripts/`、`tests/`、`dashboard/`、`extensions/` 全部 JS / TS 语法；`npm test` 运行全量隔离测试（不调用真实付费模型）。
- `pi-server doctor [--json]` 执行八维运行环境、双平台沙箱探针与四端配置体检；`pi-server install [target] [--dry-run]` 或 `npm run install:all` 稳定化路径后一键接入四端。
- `pi-server dashboard [--port N] [--open]` 启动或复用本机“Pi Server · 调度台”（默认 `http://127.0.0.1:3141/`）；`pi-server ask <provider/model> "<q>"` 经独立控制器执行 Headless 咨询。
- `npm run wait-events -- --agent <id>` 或 `--session <id>` 后台等待事件并唤醒宿主，配合 `watchers/*.json` 记录活跃监听器心跳。
- `node scripts/verify-v2.js` 真机验收 v2.0 验收闭环 + `cross_review` + `council`；`node scripts/seed-demo-state.js` 生成脱敏演示夹具；`npm run verify:communication` / `verify:live` / `verify-codex.js` / `verify-opencode.js` 执行专项真机验收。

## 目录地图
- `bin/pi-server.js`、`src/bin-resolve.js`：统一 CLI 入口（`serve`/`install`/`uninstall`/`dashboard`/`doctor`/`ask`）、`fnm_multishells` 软链稳定化（不穿透 `bin/pi`）与 MOTD 抗噪解析。
- `src/server.js`、`src/orchestration-tools.js`：MCP 服务入口与 27 个主会话工具定义（原 24 个 + `consult` / `council` / `cross_review`）。
- `src/budget.js`、`src/orchestration-core.js`、`src/consult.js`、`src/council.js`、`src/cross-review.js`：静态目录费用/容量预检、`contextFiles` 沙箱预检、独占写 `runs/<runId>.json` 的高层多模型协作原语与 Fail-Closed 审查归一化。
- `src/acceptance.js`：子代理结算后的沙箱内机械化验收检查执行器（8KB 滑动缓冲、整批 ≤300s 总超时、`sandboxHint`、可中断）。
- `src/model-profiles.js`、`src/provider-auth.js`、`src/model-settings.js`：主流开源/商业模型能力画像、6 个 Pi 工具清单、凭据脱敏与本机 Codex 登录同步、`0600` 权限原子备份同步。
- `src/quota*.js`：只读读取 Pi 凭据查询 Codex、智谱 GLM / Z.ai、MiniMax、DeepSeek 和 OpenCode Go 额度或余额；固定接口域名，剥离账号隐私字段。
- `src/controller*.js`：独立后台管理进程、私密 Unix Socket（`Buffer.concat` 512KB UTF-8 读取、重连保留 `parentInfo`、三零条件平滑热替换）。
- `src/manager.js`、`src/rpc-client.js`、`src/live-stream.js`：Pi RPC JSONL 子进程管理、五级状态生命周期（含 `completed-verified` / `completed-unverified`）、`interruptedRun` 防竞态、内存 500 条事件尾窗与实时流式输出镜像（`live.json`）。
- `src/agent-policy.js`、`src/tool-sandbox.js`、`src/linux-sandbox.js`、`src/benchmark-profile.js`：三档沙箱 + `readOnly`/`nonInteractive`/`allowWorkspaceRead` 策略、macOS Seatbelt / Linux & WSL2 `bwrap`（普通凭据文件 `/dev/null` 绑定）、四端及云凭据隔离与洁净评测模式。
- `src/message-store.js`、`src/messages.js`、`src/wait-reminder.js`、`src/callbacks.js`、`src/opencode-config.js`、`src/agent-changes.js`、`src/workspace.js`：幂等持久消息回执、四端单调游标唤醒、OpenCode JSONC 保留注释读写、含未跟踪新文件的只读 Git 差异审查与独立 worktree 隔离。
- `src/task-store.js`、`src/mcp-*.js`：MCP 2025-11-25 标准 Tasks（`completed-unverified` 映射 `failed` + `isError: true`）、资源订阅、日志与进度通知。
- `src/dashboard*.js`（含 `dashboard-insights.js`、`dashboard-sse.js`）、`dashboard/`（含 `runtime.js`、`sys-dialog.js`、`tabs.js`、`collab-views.js`）：共享单实例 SSE 广播器、`/api/runs`、`/api/system`（含 `sandbox` 与四端 `hosts`）、`/logo.svg` 与零框架 ES 模块化控制台。
- `extensions/`：注入新 Pi 子进程的权限沙箱扩展（`policy.ts`，按策略动态注册工具）与双向通信扩展（`communication.ts`）。
- `scripts/`：语法检查、四端安装（含 `--dry-run` 与 `docs/assets/logo.svg` 单源复用）、钩子、监听器、脱敏演示夹具与真机验收脚本。
- `tests/`：全量隔离行为测试与单文件行数/零注释卫生检查；`tests/helpers/` 为隔离 Pi 模拟进程。

## 标准写法与长期约定
- **代码体积与风格**：`bin/*.js`、`src/*.js` 与 `scripts/*.js` 单文件小于 500 行，`dashboard/*.js` 单文件小于 450 行；`bin/*.js`、`dashboard/*.js` 及所有新/重构后端模块禁止行首注释（由 `tests/dashboard.test.js` 自动守护）。
- **状态与单写入者边界**：所有 JSON 状态与配置统一调用 `src/storage.js` 的 `atomicWriteJson` 原子写入；`agent.json` 由控制器单一写入，高层协作终态结果独占落盘 `<stateRoot>/runs/<runId>.json`；改写 `~/.pi/agent/auth.json` 与 `models.json` 前必须 `0600` 备份，任何接口、日志或体检输出严禁暴露明文密钥。
- **五级状态严格区分**：传输接受（`accepted`）、进入上下文（`consumed`）、父端确认已读（`acknowledgedAt`）、Pi 回合结束（`completed`）与机械验收结果（`completed-verified` / `completed-unverified`，`verification.status = 'none'|'running'|'verified'|'failed'|'skipped'`）严格分开；终态以 `agent_settled` 为准。
- **用量与默认策略**：未获用户明确要求时不擅自收紧请求数、Token 或时长上限；`policy.maxTotalTokens` 仅统计非缓存读取用量（`input + output + cacheWrite`）；`catalogEstimateUsd` / `reportedCost` 均为静态目录估算而非真实账单。
- **并行与面板边界**：Git 仓库并行写开发默认独立 worktree，只读协作（`policy.readOnly: true`）允许同目录多路并发；面板绝不直接停止或接手子代理进程，仅与 `organize_agents` 共写 `dashboard-marks.json`。

## 不要做的事与已知的坑
- 不向 `stdout` 打印普通日志（`stdout` 专供 MCP JSON-RPC 帧）；Pi 子进程输出只按 `\n` 切分 JSONL。
- 不自动合并分支、删除工作目录或执行部署；不把 `reportedCost` 或 `catalogEstimateUsd` 当成真实账单。
- `interrupt()` / `closeAgent()` 进入 `serial()` 队列前必须先同步中止 `acceptanceAbort` 并置位 `interruptedRun`，严防验收阻塞死锁。
- `fnm_multishells` 路径只解引用会话目录前缀，严禁对 `bin/pi` 调用 `realpathSync` 穿透到 `node_modules/.../cli.js`。
