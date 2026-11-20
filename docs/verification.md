# 验证矩阵与回归记录

本文档说明 Pi Subagents 的自动化测试覆盖范围、真机联调脚本以及历次关键架构演进的实测结果。

## 如何运行验证

日常开发与 CI 默认只运行离线测试套件，不消耗任何模型额度，也不触碰真实用户数据：

```bash
npm run check                   # 检查全部 JS / TS 源码语法
npm test                        # 运行全部 100 项隔离单元、协议、沙箱与面板测试（macOS Seatbelt / Linux & WSL2 bwrap）
npm run verify:communication    # 使用本机配置的模型实测断线重连、阻塞提问与请求上限拦截
npm run verify:live             # 实测多模型并行修改、兄弟通信与临时模型升降级
node scripts/verify-codex.js    # 实测真实 Codex CLI 通过 stdio MCP 调度子代理
node scripts/verify-opencode.js # 实测真实 OpenCode CLI 通过 stdio MCP 调度子代理
```

真机脚本均在系统临时目录中构造隔离演示包执行；运行生成的本地记录保存在 `.agents/records/`（已被 `.gitignore` 排除），包含当次提示词与模型输出，仅留本机核验使用。

## 自动化测试覆盖模块（100 项）

| 测试文件 | 验证重点 |
| --- | --- |
| `tests/antigravity.test.js` | Antigravity 会话身份识别、`bind_session`、`wait-events --session` 心跳与唤醒、`PreInvocation`/`Stop` 钩子幂等注入与拦截、严格插件包构建校验、超过 100 条事件的游标排干去重 |
| `tests/opencode.test.js` | OpenCode 宿主识别、`opencodeSessionId` 与 `bind_session` 会话绑定、`wait-events --session` 与 `DashboardData` 统一游标联动、可选 `opencodeCliWake` 去重唤醒、JSONC 保留注释安装/卸载与 `0600` 备份、沙箱拦截 `~/.config/opencode` 与 `~/.local/share/opencode` |
| `tests/linux-sandbox.test.js` | Linux / WSL2 `bubblewrap` (`bwrap`) 路径探测、`strict`/`dev`/`bypass` 挂载与 `usrmerge` 符号链接构建、断网与凭据/状态目录屏蔽、`sandboxHealth()` |
| `tests/callbacks.test.js` | Claude Code channel 通知、Codex 线程队列投递与历史不重放、`get_agent_changes` Git 工作树差异计算、单代理 `wait-events` 唤醒 |
| `tests/communication.test.js` | `ask_parent` 阻塞提问与显式答复、取消等待、伪造令牌拦截、兄弟代理互发指令、分页读取不丢事件 |
| `tests/controller.test.js` | 独立 Unix Socket 控制进程在桥接断开后保活子代理与提问、多父会话隔离、新建代理即时唤醒长轮询 |
| `tests/dashboard.test.js` | 只读快照不抢占归属、同源与令牌防护、思考文本展示且隐藏加密签名、实时 `live.json` 流式镜像、自定义标题/备注/置顶/归档/分组移动、SSE `/api/events` 推送、单文件行数与无注释卫生约束 |
| `tests/model-settings.test.js` | API Key 与 OAuth 脱敏及 `0600` 备份、本机 Codex 登录导入与 JWT 校验、原型污染拦截、1M 上下文窗口同步 `models.json` 与 `modelOverrides`、`baseContextWindow` 基线恢复、禁用模型拦截 |
| `tests/reliable-messages.test.js` | 消息回执幂等去重与冲突报错、请求前预检与挂钟超时终止、`maxTotalTokens` 排除重复 `cacheRead` 计数与 80% 预警、子进程退出清理 `runtimeTimer` |
| `tests/tool-sandbox.test.js` | macOS Seatbelt / Linux & WSL2 `bwrap` `strict` / `dev` / `bypass` 三档文件读写、符号链接越界拦截、凭据与控制状态目录隔离、禁网拦截、取消时连带终止后代子进程 |
| `tests/mcp.test.js` & `tests/mcp-tasks.test.js` | 真实 MCP SDK 客户端连接、24 个工具发现、标准 MCP Tasks 状态机、取消与 TTL 过期清理、资源订阅通知 |
| `tests/quota.test.js` & `tests/quota-providers.test.js` | Codex、GLM / Z.ai、MiniMax Token Plan、DeepSeek、OpenCode Go 额度与余额解析、过期凭据前置报错、隐私身份字段剥离 |
| `tests/workspace.test.js`、`tests/lifecycle.test.js`、`tests/models.test.js`、`tests/recovery.test.js` | 并行 Git worktree 分支隔离、脏工作区显式决策、空闲模型切换与 `next_run` 自动恢复、关闭后恢复不重放历史任务 |
| `tests/benchmark-profile.test.js` | `BENCHMARK_PROMPT_PROFILE=clean` 洁净评测模式移除继承的上下文文件与技能且保留工具和沙箱限制 |

## 关键里程碑真机验证摘要

1. **跨模型并行与会话恢复实测**：在隔离目录中实测 GLM、DeepSeek、MiniMax 与 OpenCode Go 多模型并行修改各自授权路径、子代理调用 `ask_parent` 暂停等待主会话答复后继续、兄弟代理点对点协作、`next_run` 临时切换模型并在结算后自动恢复原模型，以及关闭后通过 `resume_agent` 恢复且不重复执行旧指令。
2. **断线恢复与请求前硬限实测**：通过真实 stdio MCP 启动子代理发起阻塞提问后主动断开 MCP 连接，再由新连接调用 `resume_agent` 接手同一身份并完成 `reply_question` 答复与受限文件写入；同时实测 `maxModelRequests=1` 在第二次模型请求发出前准确拦截并记入限制原因。
3. **Antigravity 双重回调与 Pi 调度台实测**：在 Antigravity 真实会话中完成本机 Codex OAuth 同步（`pi auth check` 状态为 `ready`），绑定当前会话启动 GPT 子代理完成进度汇报、阻塞提问、答复唤醒、多轮追加指令与 `PreInvocation` 钩子自动注入回调；通过浏览器在桌面端与 375px 窄屏下实测 `http://127.0.0.1:3141/` 三栏布局、SSE 实时推送、上下文水位曲线、内联 Git 差异与设置中心交互，零控制台异常且无横向溢出。
