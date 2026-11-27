# 版本更新记录

本文档按时间倒序记录 Pi Server 各公开版本的主要功能、架构演进与关键修复（`1.0.0`–`1.7.0` 为上游 `mumuxsy/pi-subagents` 基线历史）。

## [2.0.0] - 2026-11-27

### 架构分代、生态扩展与品牌收口
- 项目全面演进为 **Pi Server v2.0**（作者 `shin`，保留 MIT 双版权致谢上游 `mumuxsy/pi-subagents`），统一包名、MCP 服务、四端配置、新四端总线 SVG Logo（`docs/assets/logo.svg` 单源复用）与作品集级中英文文档。
- 新增 **OpenCode 第四端适配**（`install:opencode` / `uninstall:opencode`、保留注释的 JSONC 读写、`SKILL.md` 自动安装、会话绑定、统一单调游标唤醒与沙箱凭据隔离）。
- 新增 **Linux / Windows WSL2 `bubblewrap` (`bwrap`) 双平台沙箱后端**与 GitHub Actions macOS/Linux 双平台 CI 流水线。

### 高层多模型协作原语与机械化验收闭环（24 → 27 MCP 工具）
- 新增 **`consult`**（一次性只读第二意见）、**`council`**（2–4 模型并行会诊 + 确定性共识/分歧/置信度合成 + `cleanProfile` + `minQuorum` 降级）与 **`cross_review`**（含未跟踪新建文件 diff、默认拒同模型、空 diff 零成本短路、Fail-Closed 裁决归一化与 `blocker` 强升），全系支持 `dryRun`、`budgetCapUsd` 与 `unknownPricingModels` 预检。
- 新增沙箱内机械化 **`acceptanceChecks`** 闭环：`completed-verified` / `completed-unverified` 五级状态语义、8KB 滑动缓冲与 300s 总超时、`interrupt`/`closeAgent` 零死锁中止、修完自动重验，以及 MCP Task `failed` + `isError: true` 同步映射。
- 新增 `policy.readOnly` / `nonInteractive` / `allowWorkspaceRead` 与双平台内核只读隔离，支持脏工作区多模型并发无 `pathsOverlap` 冲突。

### 后端加固、Web 控制台 v2.0 与产品化 CLI
- 完成 8 项后端加固：屏蔽 `~/.claude`、`~/.claude.json`、`~/.gemini`、`~/.aws`、`~/.kube`、`~/.gnupg`（`bwrap` 普通文件 `/dev/null` 绑定防 `ENOTDIR`）；`Buffer.concat` + 512KB 修复 UTF-8 跨分片拼接；`agentChanges` 纳入未跟踪新建文件；三零条件控制器热替换；重连保留 `parentInfo`；`spawn` 失败清 Map 与 `interruptedRun` 防状态覆写；`manager.read()` 内存尾窗缓存；补齐主流开源/商业模型画像。
- 升级零外部框架实时控制台 **Pi Server · 调度台 v2.0**：后端拆分共享单实例 SSE 广播器（`src/dashboard-sse.js`）与 `mtimeMs` 缓存（`src/dashboard-insights.js`），新增 `/api/runs`、`/api/runs/:runId`、`/logo.svg` 与 `/api/system` 四端×双沙箱矩阵；前端拆分 `runtime.js` / `sys-dialog.js` / `tabs.js` / `collab-views.js`，落地会诊对比网格、审查结论联动 Diff、验收命令明细与明暗双主题 + 375px 窄屏适配。
- 新增统一命令行入口 `bin/pi-server.js`（`serve`/`install`/`uninstall`/`dashboard`/`doctor [--json]`/`ask`）、`src/bin-resolve.js` 根治 `fnm_multishells` 临时路径与 MOTD 杂讯问题，并补充 `scripts/seed-demo-state.js` 脱敏演示夹具与 `scripts/verify-v2.js` 真机验收脚本。

## [1.7.0] - 2026-11-14（上游基线）

### 新增与升级
- 项目正式更名为 **Pi Subagents**（Web 控制台名 **Pi 调度台**），解除早期与单一 Codex 宿主的命名绑定，统一面向 Google Antigravity、Claude Code 与 OpenAI Codex 提供多模型子代理调度。
- 新增可选洁净评测模式（在 `spawn_agent.context` 单独一行传入 `BENCHMARK_PROMPT_PROFILE=clean`），可在保留沙箱权限与父会话指令的前提下清空继承的全局/项目上下文与技能列表，便于公平对比模型表现。
- 完善开源工程设施：新增 MIT 许可证、中英双语说明文档、真实隔离环境渲染的 Retina 界面截图、GitHub Actions 双平台自动检查流水线、安全上报说明与贡献指南。

### 修复与优化
- 修复多轮工具调用场景下 `policy.maxTotalTokens` 重复累加每轮缓存读取（`cacheRead`）导致子代理提前触发 `Observed token limit reached` 的问题，现仅统计非缓存读取消耗（`input + output + cacheWrite`）。
- 修复子进程异常退出后 `runtimeTimer` 未及时清理、进而在超时时刻覆盖原始限制原因的问题。
- 修复内置与混合服务商模型的上下文窗口同步逻辑，支持全目录模型统一配置 1M 上下文窗口并动态生成中文能力画像描述。
- 更新 MCP 跨工具引导说明与插件规则，避免宿主代理在用户未要求硬性上限时自行收紧请求数、Token 或运行时长。

## [1.6.0] - 2026-11-14

### 新增
- **Google Antigravity 原生插件接入**：支持 `npm run install:antigravity` 一键安装插件包（含 MCP 配置、规则、技能与 `PreInvocation` / `Stop` 钩子），新增 `bind_session` 与 `get_subagent_health` 工具，通过 `antigravityDeliveredSeq` 单调游标对钩子、`wait-events --session`、`read_agent` 和 `wait_agent` 统一去重。
- **设置中心与模型能力画像**：新增 `get_model_profiles` 工具与面板左下角设置弹窗，支持按服务商启停模型、脱敏配置 API Key 与 Base URL、一键同步本机 Codex OAuth 登录、自定义上下文窗口/最大输出/推荐思考强度/能力描述并自动以 `0600` 权限备份同步 `models.json`。
- **会话整理协议**：新增第 24 个 MCP 工具 `organize_agents`，与 Web 调度台实时共享自定义标题、摘要备注、置顶、手动状态标记、分组改名及已完成会话归档。

### 优化
- **模块化实时调度台**：后端新增 `/api/events` SSE 实时推送、`/api/system` 系统与监听器状态、60 秒缓存 `/api/quota` 与 `dashboard.lock` 并发启动锁；前端拆分为独立 ES 模块，恢复折叠式执行过程与 `live.json` 逐字流式渲染，重排右侧检查器（概况、上下文水位与增长曲线、只读 Git 改动内联差异）。
- **原子写入加固**：全部运行状态与配置文件改用 `atomicWriteJson` 临时文件原子替换，补齐 `readTail` 与沙箱 `read_head` 边界校验。

## [1.2.0] - 2026-10-13

### 新增
- Web 面板升级为 **Pi 调度台**（默认端口 `127.0.0.1:3141`），支持按父会话分组、实时对话与 `live.json` 流式输出镜像、SVG 上下文构成分析、PR 链接识别、明暗双主题与 375px 窄屏抽屉布局。
- 新增宿主专用回调唤醒（`set_agent_callback`、`scripts/wait-events.js`）与只读 Git 工作树差异审查工具 `get_agent_changes`。
- 支持 `strict`、`dev`、`bypass` 三档沙箱模式切换与启动/等待防遗忘提醒（`mustWait`）。

## [1.1.0] - 2026-10-06

### 新增
- 引入独立 Unix Socket 管理进程（`src/controller.js`），MCP 连接断开不中断运行中的 Pi 子代理与待答复问题，支持新会话通过 `resume_agent` / `resume_task` 显式接手。
- 实现带幂等去重与送达回执的持久消息存储（`read_messages` / `ack_messages`）、macOS Seatbelt 进程级文件与网络限制、策略变更校验（`update_agent_policy`）以及 MCP 2025-11-25 标准资源订阅、日志、进度通知与实验性 Tasks。
- 新增多渠道只读套餐额度与余额查询工具 `get_quota`（支持 Codex、智谱 GLM / Z.ai、MiniMax Token Plan、DeepSeek、OpenCode Go）与本机只读查看面板。

## [1.0.0] - 2026-10-05

### 新增
- 首个可用版本：通过 stdio MCP 封装本机 Pi RPC 子进程，支持多模型子代理创建、Git 独立 worktree 与共享目录 `ownedPaths` 隔离、双向 `agent_message` 汇报、`ask_parent` / `reply_question` 阻塞问答及 `next_run` 临时模型升降级。
